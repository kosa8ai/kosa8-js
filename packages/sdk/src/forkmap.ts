// Copyright (c) 2026 kosa8. Licensed under the MIT License; see LICENSE.

/**
 * The engine behind `cloud.forkMap` and `rl.Run.map`: hand out forks of a
 * base sandbox (or fresh sandboxes), run work in them, retry what can pass,
 * and never leave a child behind, abort included.
 */

import { Kosa8ApiError, Kosa8Error, Kosa8TimeoutError, classifyFailure } from './errors.js';
import type { FailureClass } from './errors.js';
import { RetryPolicy, sleepMs } from './retry.js';
import type { CloudFanoutFailure, CloudSandbox } from './cloud.js';

/** Children forked ahead of the workers in one call, at most. */
const PREFORK_MAX = 100;

/** The map was aborted before this item ran. */
export class Kosa8CancelledError extends Kosa8Error {
  constructor(message = 'cancelled before it ran') {
    super(message, { body: { failure_class: 'error', retryable: false }, code: 'cancelled' });
  }
}

/** An item ran past the map's `timeoutMs`; its sandbox was deleted. */
export class Kosa8ItemTimeoutError extends Kosa8TimeoutError {
  constructor(timeoutMs: number) {
    super(`gave up after ${timeoutMs} ms; its sandbox was deleted`, {
      body: { failure_class: 'timeout', retryable: false }, code: 'timeout',
    });
  }
}

/** A `failed` entry of a batch or fork answer as an error. */
export function failureFromEntry(entry: Partial<CloudFanoutFailure>): Kosa8ApiError {
  return new Kosa8ApiError(String(entry.message || entry.code || 'not created'), {
    code: entry.code,
    body: { failure_class: entry.failure_class || 'infra', retryable: entry.retryable ?? true, ...entry },
  });
}

async function quiet(p: Promise<unknown>): Promise<void> {
  try {
    await p;
  } catch {
    // gone already, or its lease deletes it
  }
}

/** @internal Forks of `base` (or `make(arg)`) for workers to take; `close` deletes every one not released. */
export class ChildPool<A = unknown> {
  private readonly ready: CloudSandbox[] = [];
  private readonly live = new Map<string, CloudSandbox>();
  closed = false;

  constructor(
    private readonly src:
      | { base: CloudSandbox; make?: undefined }
      | { base?: undefined; make: (arg: A) => Promise<CloudSandbox> },
    private readonly fan: { labels?: Record<string, string>; runId?: string; leaseS?: number } = {},
  ) {}

  private adopt(kids: CloudSandbox[]): void {
    if (this.closed) {
      for (const k of kids) void quiet(k.delete());
      throw new Kosa8CancelledError();
    }
    for (const k of kids) this.live.set(k.id, k);
  }

  private async fork(n: number, partialOk?: boolean): Promise<CloudSandbox[]> {
    const kids = await this.src.base!.fork({
      n, ...this.fan, ...(partialOk !== undefined ? { partialOk } : {}),
    });
    this.adopt(kids);
    if (kids.length === 0) throw failureFromEntry(kids.failed?.[0] ?? { message: 'the fork made no sandbox' });
    return [...kids];
  }

  /** Fork up to `n` children ahead, in calls of at most 100. Failures are ignored: each worker then forks its own. */
  async prefork(n: number): Promise<void> {
    if (this.src.make) return;
    let left = n;
    while (left > 0 && !this.closed) {
      const k = Math.min(left, PREFORK_MAX);
      try {
        this.ready.push(...(await this.fork(k, true)));
      } catch {
        return;
      }
      left -= k;
    }
  }

  async take(arg: A): Promise<CloudSandbox> {
    if (this.closed) throw new Kosa8CancelledError();
    if (this.src.make) {
      const child = await this.src.make(arg);
      this.adopt([child]);
      return child;
    }
    const c = this.ready.shift();
    if (c) return c;
    return (await this.fork(1))[0]!;
  }

  /** Delete a child taken from the pool (once; later calls do nothing). */
  async release(child: CloudSandbox): Promise<void> {
    if (this.live.delete(child.id)) await quiet(child.delete());
  }

  /** Stop tracking a child without deleting it (`keep`). */
  forget(child: CloudSandbox): void {
    this.live.delete(child.id);
  }

  liveIds(): string[] {
    return [...this.live.keys()];
  }

  /** Delete every child not yet released (queued or in use): one drain, then one by one for anything it missed. */
  async close(): Promise<void> {
    this.closed = true;
    this.ready.length = 0;
    const kids = [...this.live.values()];
    this.live.clear();
    if (!kids.length) return;
    try {
      const cloud = (kids[0] as unknown as { cloud: { sandboxes: { drain(s: { ids: string[] }): Promise<{ failed: unknown[] }> } } }).cloud;
      const r = await cloud.sandboxes.drain({ ids: kids.map((k) => k.id) });
      if (!r.failed.length) return;
    } catch {
      // fall through
    }
    await Promise.all(kids.map((k) => quiet(k.delete())));
  }
}

/** @internal `fn()`, or a timeout error after `ms` (running `onTimeout` first). */
export async function withTimeout<T>(fn: () => Promise<T>, ms: number | undefined, onTimeout: () => Promise<void>): Promise<T> {
  if (ms === undefined) return fn();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      void onTimeout().finally(() => reject(new Kosa8ItemTimeoutError(ms)));
    }, ms);
  });
  try {
    return await Promise.race([fn(), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** @internal `worker(i)` for i < n, `concurrency` at once, results in order. */
export async function runPool<T>(n: number, concurrency: number, worker: (i: number) => Promise<T>): Promise<T[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Kosa8Error('concurrency must be a whole number of at least 1');
  const out = new Array<T>(n);
  let next = 0;
  const run = async () => {
    while (next < n) {
      const i = next++;
      out[i] = await worker(i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, n) }, run));
  return out;
}

export interface ForkMapOptions {
  /** Items in flight at once. Default 16. */
  concurrency?: number;
  /** Retries of an infra failure or a rate limit, each on a fresh fork. Default 2. */
  retries?: number;
  /** Give up on an item after this long (`failureClass: 'timeout'`) and delete its child. */
  timeoutMs?: number;
  /** Labels for every child. */
  labels?: Record<string, string>;
  /** Label the children kosa8.run=<runId>. */
  runId?: string;
  /** Lease the children (60..86400 s), so a crash leaks none. */
  leaseS?: number;
  /** Backoff between retries. Default `new RetryPolicy({ attempts: retries + 1 })`. */
  policy?: RetryPolicy;
  /** Abort: no new item starts, and every child is deleted. */
  signal?: AbortSignal;
}

/** One item of `cloud.forkMap`. */
export interface ForkResult<I, R> {
  item: I;
  index: number;
  /** What `fn` resolved with (undefined when it failed). */
  value?: R;
  /** The error of the last attempt, when it failed. */
  error?: unknown;
  /** ok, or the failure's class (infra, timeout, quota, client, error). */
  failureClass: FailureClass | (string & {});
  attempts: number;
  /** The child of the last attempt (already deleted). */
  sandboxId?: string;
  ms: number;
  ok: boolean;
}

/** @internal See `Kosa8Cloud.forkMap`. */
export async function forkMap<I, R>(
  base: CloudSandbox,
  fn: (child: CloudSandbox, item: I, index: number) => Promise<R>,
  items: Iterable<I>,
  opts: ForkMapOptions = {},
): Promise<ForkResult<I, R>[]> {
  const list = [...items];
  const retries = opts.retries ?? 2;
  if (!Number.isInteger(retries) || retries < 0) throw new Kosa8Error('retries must be a whole number of at least 0');
  const concurrency = opts.concurrency ?? 16;
  const policy = opts.policy ?? new RetryPolicy({ attempts: retries + 1 });
  const pool = new ChildPool<I>({ base }, { labels: opts.labels, runId: opts.runId, leaseS: opts.leaseS });
  const signal = opts.signal;
  const onAbort = () => void pool.close();
  signal?.addEventListener('abort', onAbort, { once: true });

  const worker = async (i: number): Promise<ForkResult<I, R>> => {
    const item = list[i]!;
    const res: ForkResult<I, R> = { item, index: i, failureClass: 'ok', attempts: 0, ms: 0, ok: false };
    const t0 = Date.now();
    for (let attempt = 1; attempt <= retries + 1; attempt++) {
      res.attempts = attempt;
      if (signal?.aborted) {
        res.error = new Kosa8CancelledError();
        res.failureClass = 'error';
        break;
      }
      let child: CloudSandbox | undefined;
      try {
        child = await pool.take(item);
        res.sandboxId = child.id;
        const c = child;
        res.value = await withTimeout(() => fn(c, item, i), opts.timeoutMs, () => pool.release(c));
        res.error = undefined;
        res.failureClass = 'ok';
        break;
      } catch (e) {
        res.value = undefined;
        res.error = e;
        const f = classifyFailure(e);
        res.failureClass = f.failureClass;
        if (!f.retryable || attempt > retries) break;
        if (child) await pool.release(child);
        child = undefined;
        await sleepMs(policy.delayMs(e, attempt), signal);
      } finally {
        if (child) await pool.release(child);
      }
    }
    res.ms = Date.now() - t0;
    res.ok = res.failureClass === 'ok';
    return res;
  };

  try {
    if (list.length) await pool.prefork(Math.min(list.length, concurrency));
    return await runPool(list.length, concurrency, worker);
  } finally {
    signal?.removeEventListener('abort', onAbort);
    await pool.close();
  }
}

// Copyright (c) 2026 kosa8. Licensed under the MIT License; see LICENSE.

/** RL runs: what a training run did, recorded on kosa8 Cloud and shown on app.kosa8.com (RL runs). */

import { ensureDisposeSymbols } from '../dispose.js';
import { Kosa8Error } from '../errors.js';
import { newIdempotencyKey } from '../cloud.js';
import type { CloudDrainResult, CloudSandbox, Kosa8Cloud } from '../cloud.js';
import { DEFAULT_LEASE_S, Lease } from './lease.js';
import { mapRollouts, rolloutRow } from './rollouts.js';
import type { MapRolloutsOptions, RolloutBase, RolloutResult, Rollouts, RunLike } from './rollouts.js';

ensureDisposeSymbols();

/** Rows per `POST /v1/rl/runs/{id}/rollouts`. */
export const MAX_ROWS_PER_CALL = 500;

export const RUN_STATUSES = ['running', 'finished', 'failed'] as const;

/** A run as the API reports it. */
export interface RlRunInfo {
  /** run_… */
  id: string;
  name: string;
  project: string | null;
  status: string;
  config: Record<string, unknown> | null;
  /** The label its sandboxes carry: {"kosa8.run": id}. */
  label?: Record<string, string>;
  created_at: number;
  updated_at: number;
  finished_at: number | null;
  /** List only: a short summary and the count of recommendations. */
  summary?: Record<string, unknown>;
  recommendations?: unknown;
  [k: string]: unknown;
}

/** A rollout row to record: one of a `RolloutResult` or the API's own fields. */
export interface RolloutRow {
  step?: number;
  group?: string | number;
  index?: number;
  sandbox_id?: string;
  reward?: number | null;
  /** Default: ok for exit 0 or no exit, exit_nonzero otherwise. */
  failure_class?: string;
  exit?: number | null;
  duration_ms?: number;
  cost_usd?: number;
  tokens?: number;
  /** At most 32 numbers. */
  metrics?: Record<string, number>;
  /** Anything, at most 8 KiB as JSON. */
  meta?: Record<string, unknown>;
  /** The last 4 KiB is kept. */
  stdout_tail?: string;
  [k: string]: unknown;
}

export interface RlRunOptions {
  /** The run's name. Give it, or `runId` to attach to an existing run. */
  name?: string;
  runId?: string;
  project?: string;
  /** Anything, at most 16 KiB as JSON. */
  config?: Record<string, unknown>;
  /** How long the run's sandboxes outlive the last heartbeat (60..86400 s). Default 600. */
  leaseS?: number;
  /** Delete the run's sandboxes when it finishes. Default true. */
  drainOnExit?: boolean;
  /** Send buffered rollouts once this many are waiting (1..500). Default 100. */
  flushEvery?: number;
  /** Finish (record, drain, mark failed) on SIGINT/SIGTERM and when the event loop runs dry. Default true. */
  signals?: boolean;
  /** Between heartbeats (and flushes). Default a third of the lease. */
  heartbeatMs?: number;
  /** Where warnings go. Default console.warn. */
  warn?: (message: string) => void;
}

export interface RolloutFilters {
  step?: number;
  failureClass?: string;
  minReward?: number;
  maxReward?: number;
  sandboxId?: string;
  id?: string;
  /** 1..500; default 100. */
  limit?: number;
  cursor?: string;
}

type RowIn = RolloutResult | RolloutRow;

function isResult(r: RowIn): r is RolloutResult {
  return typeof (r as RolloutResult).failureClass === 'string' && 'masked' in r;
}

const enc = encodeURIComponent;

/**
 * One RL training run on kosa8 Cloud.
 *
 * ```ts
 * await withRun(cloud, { name: 'my-grpo-run' }, async (run) => {
 *   const base = await cloud.sandboxes.create({ template: 'python' });
 *   const results = await run.map(base, tasks, solve, { gradeCmd: ['python', '/grader/test.py'] });
 * });
 * ```
 *
 * Starting it creates the run (or attaches to `runId`) and starts a
 * `Lease`: every sandbox this `cloud` makes while the run is open is
 * labelled `kosa8.run=<id>` and leased for `leaseS`, heartbeats keep them
 * alive, and finishing (or SIGINT, SIGTERM, the process running dry)
 * records what is left, deletes the run's sandboxes (`drainOnExit`) and
 * marks the run `finished` or `failed`. `await using run = await
 * RlRun.start(cloud, …)` finishes it as `finished` when the block ends.
 */
export class RlRun implements RunLike {
  id: string | undefined;
  readonly name: string | undefined;
  readonly leaseS: number;
  /** The run as the API last answered it. */
  info: Partial<RlRunInfo> = {};
  /** Rollouts sent by this object so far. */
  recorded = 0;
  status: string | undefined;
  private buf: Record<string, unknown>[] = [];
  /** The first rows of buf that a flush sent and lost: sent again as one chunk with the same key. */
  private unsent?: { size: number; key: string };
  private flushing: Promise<number> | undefined;
  private leaseObj: Lease | undefined;
  private prevDefaults: Kosa8Cloud['_runDefaults'];
  private step = 0;
  private open = false;
  private readonly flushEvery: number;

  constructor(readonly cloud: Kosa8Cloud, private readonly opts: RlRunOptions = {}) {
    if (!opts.name && !opts.runId) throw new Kosa8Error('give the run a name, or runId to attach to one');
    const fe = opts.flushEvery ?? 100;
    if (!Number.isInteger(fe) || fe < 1 || fe > MAX_ROWS_PER_CALL) throw new Kosa8Error(`flushEvery must be from 1 to ${MAX_ROWS_PER_CALL}`);
    this.flushEvery = fe;
    this.id = opts.runId;
    this.name = opts.name;
    this.leaseS = opts.leaseS ?? DEFAULT_LEASE_S;
  }

  /** Create (or attach to) a run and start it. */
  static start(cloud: Kosa8Cloud, opts: RlRunOptions): Promise<RlRun> {
    return new RlRun(cloud, opts).start();
  }

  /** An existing run, to keep recording after a restart. */
  static attach(cloud: Kosa8Cloud, runId: string, opts: Omit<RlRunOptions, 'runId'> = {}): Promise<RlRun> {
    return new RlRun(cloud, { ...opts, runId }).start();
  }

  /** The org's runs, newest first, with a short summary. */
  static async list(
    cloud: Kosa8Cloud,
    opts: { project?: string; status?: string; name?: string; limit?: number; cursor?: string } = {},
  ): Promise<{ runs: RlRunInfo[]; nextCursor: string | null }> {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(opts)) if (v !== undefined && v !== '') q.set(k, String(v));
    const qs = q.toString();
    const r = await cloud.request<{ runs?: RlRunInfo[]; next_cursor?: string | null }>('GET', `/v1/rl/runs${qs ? `?${qs}` : ''}`);
    return { runs: r.runs ?? [], nextCursor: r.next_cursor || null };
  }

  /** The run's lease while it is open. */
  get lease(): Lease | undefined {
    return this.leaseObj;
  }

  /** Rollouts buffered, not yet sent. */
  get pending(): number {
    return this.buf.length;
  }

  /** Create (or attach to) the run and start its lease. */
  async start(): Promise<this> {
    if (this.open) return this;
    if (this.id === undefined) {
      const body: Record<string, unknown> = { name: this.name };
      if (this.opts.project) body.project = this.opts.project;
      if (this.opts.config) body.config = this.opts.config;
      const r = await this.cloud.request<{ run?: RlRunInfo }>('POST', '/v1/rl/runs', body);
      this.info = r.run ?? {};
      this.id = this.info.id;
      if (!this.id) throw new Kosa8Error('kosa8 Cloud answered no run id');
    }
    this.status = 'running';
    this.prevDefaults = this.cloud._runDefaults;
    this.cloud._runDefaults = { runId: this.id, leaseS: this.leaseS };
    this.leaseObj = new Lease(this.cloud, {
      runId: this.id, leaseS: this.leaseS, drain: this.opts.drainOnExit ?? true, signals: this.opts.signals ?? true,
      onTick: () => this.tick(), ...(this.opts.heartbeatMs !== undefined ? { intervalMs: this.opts.heartbeatMs } : {}),
      ...(this.opts.warn ? { warn: this.opts.warn } : {}),
      // A signal or the loop running dry closes the lease first: the run is then marked failed.
      onClose: () => this.closedByLease(),
    });
    this.leaseObj.start();
    this.open = true;
    return this;
  }

  private warn(msg: string): void {
    (this.opts.warn ?? ((m: string) => console.warn(m)))(msg);
  }

  private async tick(): Promise<void> {
    try {
      await this.flush();
    } catch (e) {
      this.warn(`kosa8: recording rollouts of run ${this.id} failed, will retry: ${String((e as Error)?.message ?? e)}`);
    }
  }

  private async closedByLease(): Promise<void> {
    if (!this.open) return;
    this.open = false;
    this.leaseObj = undefined;
    this.cloud._runDefaults = this.prevDefaults;
    try {
      await this.update({ status: 'failed' });
    } catch (e) {
      this.warn(`kosa8: could not mark run ${this.id} failed: ${String((e as Error)?.message ?? e)}`);
    }
    this.status = 'failed';
  }

  /**
   * Record what is buffered, drain the run's sandboxes (`drainOnExit`), and
   * mark the run `finished` (or `failed`). Safe to call twice.
   */
  async finish(status: 'finished' | 'failed' = 'finished'): Promise<void> {
    if (status !== 'finished' && status !== 'failed') throw new Kosa8Error('status is finished or failed');
    if (!this.open) return;
    this.open = false;
    const lease = this.leaseObj;
    this.leaseObj = undefined;
    if (lease) await lease.close(); // final flush (its tick), then the drain
    else await this.tick();
    this.cloud._runDefaults = this.prevDefaults;
    try {
      await this.update({ status });
    } catch (e) {
      this.warn(`kosa8: could not mark run ${this.id} ${status}: ${String((e as Error)?.message ?? e)}`);
    }
    this.status = status;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.finish('finished');
  }

  /** @internal */
  nextStep(): number {
    return this.step++;
  }

  private path(suffix = ''): string {
    if (!this.id) throw new Kosa8Error('the run has not started: use RlRun.start or run.start()');
    return `/v1/rl/runs/${enc(this.id)}${suffix}`;
  }

  /**
   * Buffer one rollout or many (a `RolloutResult` or the API's row fields).
   * They are sent in batches (`flushEvery`, at most 500 a call), every
   * heartbeat, and when the run finishes; `{ flush: true }` sends now.
   */
  async record(rows: RowIn | RowIn[], opts: { flush?: boolean } = {}): Promise<void> {
    const list = Array.isArray(rows) ? rows : [rows];
    for (const r of list) this.buf.push(isResult(r) ? rolloutRow(r) : { ...r });
    if (opts.flush || (opts.flush === undefined && this.buf.length >= this.flushEvery)) await this.flush();
  }

  /** Send every buffered rollout now; resolves with how many were recorded. On an error the unsent rows stay buffered. */
  flush(): Promise<number> {
    const prev = this.flushing ?? Promise.resolve(0);
    const next = prev.catch(() => 0).then(() => this.flushNow());
    this.flushing = next;
    return next;
  }

  private async flushNow(): Promise<number> {
    let sent = 0;
    while (this.buf.length) {
      // A chunk that failed is sent again as it was, with its Idempotency-Key:
      // if the first try was stored after all (an answer lost on the way),
      // the server replays it rather than storing the rows twice.
      const again = this.unsent;
      const chunk = this.buf.splice(0, again ? again.size : MAX_ROWS_PER_CALL);
      const key = again ? again.key : newIdempotencyKey();
      try {
        const r = await this.cloud.request<{ recorded?: number }>('POST', this.path('/rollouts'), { rollouts: chunk }, { idempotencyKey: key });
        this.unsent = undefined;
        const n = r?.recorded ?? chunk.length;
        sent += n;
        this.recorded += n;
      } catch (e) {
        this.buf.unshift(...chunk);
        this.unsent = { size: chunk.length, key };
        throw e;
      }
    }
    return sent;
  }

  /** The run with its summary (rewards, failure classes, live sandboxes, cost) and recommendations. */
  async summary(): Promise<{ run: RlRunInfo; summary: Record<string, unknown>; recommendations: Record<string, unknown>[] }> {
    const r = await this.cloud.request<{ run: RlRunInfo; summary?: Record<string, unknown>; recommendations?: Record<string, unknown>[] }>(
      'GET', this.path(),
    );
    if (r.run) this.info = r.run;
    return { run: r.run, summary: r.summary ?? {}, recommendations: r.recommendations ?? [] };
  }

  /** Rename it or set its status. */
  async update(opts: { status?: string; name?: string }): Promise<RlRunInfo> {
    const body: Record<string, unknown> = {};
    if (opts.status !== undefined) body.status = opts.status;
    if (opts.name !== undefined) body.name = opts.name;
    if (!Object.keys(body).length) throw new Kosa8Error('give status or name');
    const r = await this.cloud.request<{ run?: RlRunInfo }>('PATCH', this.path(), body);
    if (r?.run) this.info = r.run;
    return this.info as RlRunInfo;
  }

  /** One page of recorded rollouts, newest first. */
  async rollouts(f: RolloutFilters = {}): Promise<{ rollouts: Record<string, unknown>[]; nextCursor: string | null }> {
    const q = new URLSearchParams();
    const names: [keyof RolloutFilters, string][] = [
      ['step', 'step'], ['failureClass', 'failure_class'], ['minReward', 'min_reward'], ['maxReward', 'max_reward'],
      ['sandboxId', 'sandbox_id'], ['id', 'id'], ['limit', 'limit'], ['cursor', 'cursor'],
    ];
    for (const [k, api] of names) if (f[k] !== undefined) q.set(api, String(f[k]));
    const qs = q.toString();
    const r = await this.cloud.request<{ rollouts?: Record<string, unknown>[]; next_cursor?: string | null }>(
      'GET', this.path(`/rollouts${qs ? `?${qs}` : ''}`),
    );
    return { rollouts: r.rollouts ?? [], nextCursor: r.next_cursor || null };
  }

  /** Every rollout as JSON lines, oldest first. */
  async export(): Promise<string> {
    return new TextDecoder().decode(await this.cloud.requestBytes('GET', this.path('/export?format=jsonl')));
  }

  /** Every rollout, parsed. */
  async exportRows(): Promise<Record<string, unknown>[]> {
    return (await this.export()).split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  /** Delete the run's sandboxes now (the run stays open). */
  drain(): Promise<CloudDrainResult> {
    if (!this.id) throw new Kosa8Error('the run has not started');
    return this.cloud.sandboxes.drain({ runId: this.id });
  }

  /**
   * One training step: `solve(sandbox, task)` for every task (`groupSize`
   * samples each), `concurrency` at a time (default 64), each in its own
   * sandbox from `base`, graded, recorded on this run and deleted. `step`
   * defaults to this run's count of maps. See `mapRollouts`.
   */
  map<T, O>(
    base: RolloutBase<T>,
    tasks: Iterable<T>,
    solve: (sandbox: CloudSandbox, task: T) => Promise<O>,
    opts: Omit<MapRolloutsOptions<T, O>, 'base' | 'run' | 'cloud'> = {},
  ): Promise<Rollouts<T, O>> {
    if (!this.open) throw new Kosa8Error('the run is not open: start it first');
    return mapRollouts(solve, tasks, { ...opts, base, run: this, cloud: this.cloud });
  }
}

/**
 * Start a run, call `fn(run)`, and finish it: `finished` when `fn`
 * resolves, `failed` when it throws (the error is rethrown).
 */
export async function withRun<R>(cloud: Kosa8Cloud, opts: RlRunOptions, fn: (run: RlRun) => Promise<R>): Promise<R> {
  const run = await RlRun.start(cloud, opts);
  try {
    const out = await fn(run);
    await run.finish('finished');
    return out;
  } catch (e) {
    await run.finish('failed');
    throw e;
  }
}

// Copyright (c) 2026 kosa8. Licensed under the MIT License; see LICENSE.

/** Rollouts: acquire a sandbox, run the agent, grade it, record it, release it. */

import { Kosa8Error, classifyFailure } from '../errors.js';
import type { FailureClass } from '../errors.js';
import { RetryPolicy, callWithRetry, sleepMs } from '../retry.js';
import { CloudSandbox } from '../cloud.js';
import type { CloudCreateOptions, CloudGradeResult, Kosa8Cloud } from '../cloud.js';
import { ChildPool, runPool, withTimeout } from '../forkmap.js';

/**
 * Failure classes masked by default: the sandbox or the platform failed,
 * not the policy, so the rollout must not train as reward 0. `error` is
 * your own `solve` throwing (a harness bug). Add `timeout` to mask timeouts
 * too.
 */
export const DEFAULT_MASK: readonly FailureClass[] = ['infra', 'quota', 'error'];

/** Most of the grader's stdout kept on a result and in a recorded rollout. */
export const STDOUT_TAIL = 64 * 1024;

const ALL_CLASSES = new Set(['ok', 'exit_nonzero', 'timeout', 'infra', 'quota', 'client', 'error']);

/** One rollout. `masked` means: leave it out of the gradient; `reward` is then null, never 0. */
export interface RolloutResult<T = unknown, O = unknown> {
  task: T;
  /** Which task (its position in `tasks`) and which sample of its group. */
  group: number;
  index: number;
  step?: number;
  reward: number | null;
  /** ok, exit_nonzero (the grader ran and failed), timeout, infra, quota, client, error. */
  failureClass: FailureClass | (string & {});
  masked: boolean;
  metrics: Record<string, unknown>;
  /** What `solve` resolved with. */
  output?: O;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error?: string;
  attempts: number;
  durationMs: number;
  sandboxId?: string;
  graderId?: string;
  tokens?: number;
  costUsd?: number;
  /** Whether kosa8 Cloud already recorded it (the grader does, given a run). */
  recorded: boolean;
  meta: Record<string, unknown>;
  /** Trainable: not masked, and the grader (or reward) ran. */
  ok: boolean;
}

/** The row `POST /v1/rl/runs/{id}/rollouts` takes. */
export function rolloutRow(r: RolloutResult): Record<string, unknown> {
  const meta: Record<string, unknown> = { ...r.meta };
  if (Object.keys(r.metrics).length) meta.metrics = r.metrics;
  if (r.masked) meta.masked = true;
  if (r.error) meta.error = r.error.slice(0, 2000);
  if (r.attempts > 1) meta.attempts = r.attempts;
  const row: Record<string, unknown> = {
    step: r.step, group: r.group, index: r.index, sandbox_id: r.sandboxId, reward: r.reward,
    failure_class: r.failureClass, exit: r.exitCode, duration_ms: r.durationMs, meta,
    stdout_tail: (r.stdout ?? '').slice(-STDOUT_TAIL), tokens: r.tokens, cost_usd: r.costUsd,
  };
  for (const k of Object.keys(row)) if (row[k] === undefined || row[k] === null) delete row[k];
  if (r.reward === null) row.reward = null;
  return row;
}

/** The results of a map, in input order (task-major, `groupSize` per task). */
export class Rollouts<T = unknown, O = unknown> extends Array<RolloutResult<T, O>> {
  static get [Symbol.species](): ArrayConstructor {
    return Array;
  }

  /** Each reward, null where masked. */
  get rewards(): (number | null)[] {
    return Array.from(this, (r) => r.reward);
  }

  /** true where the rollout should train (not masked). */
  get mask(): boolean[] {
    return Array.from(this, (r) => !r.masked);
  }

  get meanReward(): number | null {
    const v = Array.from(this, (r) => r.reward).filter((x): x is number => x !== null);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  }

  /** How many of each failure class. */
  get byClass(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of this) out[r.failureClass] = (out[r.failureClass] ?? 0) + 1;
    return out;
  }

  /** The rollouts of each task together, for group-relative advantages (GRPO). */
  groups(): RolloutResult<T, O>[][] {
    const m = new Map<number, RolloutResult<T, O>[]>();
    for (const r of this) {
      const g = m.get(r.group) ?? [];
      g.push(r);
      m.set(r.group, g);
    }
    return [...m.keys()].sort((a, b) => a - b).map((k) => m.get(k)!);
  }
}

/** Where each rollout's sandbox comes from. */
export type RolloutBase<T> =
  /** Fork it per rollout (cheapest: set it up once). */
  | CloudSandbox
  /** A snapshot id (snap_…) to create each from. */
  | string
  /** Create options for each. */
  | CloudCreateOptions
  /** Make each one yourself. */
  | ((task: T) => Promise<CloudSandbox>);

export interface MapRolloutsOptions<T, O> {
  /** The sandboxes' source. */
  base: RolloutBase<T>;
  /** Needed when `base` is not a sandbox (and there is no `run`). */
  cloud?: Kosa8Cloud;
  /** Record each rollout on this run (and default `step` to its count of maps). */
  run?: RunLike;
  /** Grade each rollout in a sealed copy with this command and the task's hidden files. */
  gradeCmd?: string | string[];
  /** Hidden grader files: a map, or a function of the task. Default `task.files` (or `task.hidden_files`). */
  files?: Record<string, string | Uint8Array> | ((task: T) => Record<string, string | Uint8Array> | undefined);
  gradeTimeoutS?: number;
  gradeEnv?: Record<string, string>;
  /** Without `gradeCmd`: the reward of a solved sandbox, a number or `{ reward, metrics? }`. */
  reward?: (sandbox: CloudSandbox, task: T, output: O) => unknown;
  /** Rollouts in flight at once. Default 64. */
  concurrency?: number;
  /** Samples per task (GRPO's G). Default 1. */
  groupSize?: number;
  step?: number;
  /** Retries of an infra failure or a rate limit, on a fresh sandbox (a failed grade is retried on its own first). Default 2. */
  retries?: number;
  /** Cap on `solve`, client-side: past it the sandbox is deleted and the rollout is `timeout`. */
  timeoutMs?: number;
  /** Failure classes to mask. Default infra, quota and error. */
  mask?: readonly string[];
  /** Keep each rollout's sandbox instead of deleting it. */
  keep?: boolean;
  /** Extra meta for each rollout's record. */
  meta?: (task: T, output: O | undefined) => Record<string, unknown> | undefined;
  /** Abort: no new rollout starts, and every sandbox is deleted. */
  signal?: AbortSignal;
}

/** @internal What a map needs of a run. */
export interface RunLike {
  readonly id: string | undefined;
  readonly leaseS: number;
  readonly cloud: Kosa8Cloud;
  nextStep(): number;
  record(r: RolloutResult): Promise<void>;
}

const NO_REWARD =
  'no reward: pass gradeCmd (a sealed grader), reward(sandbox, task, output), or resolve solve with a number or { reward }';

function taskFiles(task: unknown): Record<string, string | Uint8Array> | undefined {
  if (task && typeof task === 'object') {
    for (const k of ['files', 'hidden_files']) {
      const v = (task as Record<string, unknown>)[k];
      if (v && typeof v === 'object') return v as Record<string, string | Uint8Array>;
    }
  }
  return undefined;
}

function taskId(task: unknown): unknown {
  if (task && typeof task === 'object') {
    for (const k of ['id', 'task_id', 'instance_id']) {
      const v = (task as Record<string, unknown>)[k];
      if (v !== undefined && v !== null) return v;
    }
  }
  return undefined;
}

/** Take reward, metrics, tokens and meta from what solve (or reward) gave; true if it gave a reward. */
function fromOutput(res: RolloutResult, out: unknown): boolean {
  if (typeof out === 'number') {
    res.reward = out;
    return true;
  }
  if (out && typeof out === 'object') {
    const o = out as Record<string, unknown>;
    if (Number.isInteger(o.tokens)) res.tokens = o.tokens as number;
    if (typeof o.cost_usd === 'number') res.costUsd = o.cost_usd;
    if (typeof o.costUsd === 'number') res.costUsd = o.costUsd;
    if (o.meta && typeof o.meta === 'object') Object.assign(res.meta, o.meta);
    if (typeof o.reward === 'number') {
      res.reward = o.reward;
      if (o.metrics && typeof o.metrics === 'object') res.metrics = { ...(o.metrics as Record<string, unknown>) };
      return true;
    }
  }
  return false;
}

function applyGrade(res: RolloutResult, g: CloudGradeResult, recorded: boolean): void {
  res.reward = g.reward;
  res.metrics = g.metrics;
  res.exitCode = g.exitCode;
  res.stdout = g.stdout.slice(-STDOUT_TAIL);
  res.stderr = g.stderr.slice(-STDOUT_TAIL);
  res.failureClass = g.failureClass;
  if (g.graderId) res.graderId = g.graderId;
  res.recorded = recorded;
}

function maker<T>(cloud: Kosa8Cloud | undefined, base: Exclude<RolloutBase<T>, CloudSandbox>, run?: RunLike): (task: T) => Promise<CloudSandbox> {
  if (typeof base === 'function') return base;
  if (!cloud) throw new Kosa8Error('give cloud (a Kosa8Cloud) when base is not a sandbox');
  const extra: CloudCreateOptions = {};
  if (run?.id) extra.runId = run.id;
  if (run) extra.leaseS = run.leaseS;
  if (typeof base === 'string') {
    if (!base.startsWith('snap_')) throw new Kosa8Error('a string base is a snapshot id (snap_…); pass a sandbox to fork it');
    return () => cloud.sandboxes.create({ snapshot: base, ...extra });
  }
  const lifetime = base.ttlS !== undefined || base.deleteAfter !== undefined;
  const opts: CloudCreateOptions = { ...base, runId: base.runId ?? extra.runId, ...(lifetime ? {} : { leaseS: base.leaseS ?? extra.leaseS }) };
  return () => cloud.sandboxes.create(opts);
}

/**
 * Run `solve(sandbox, task)` for every task (`groupSize` times each),
 * `concurrency` at a time. Each rollout gets its own sandbox (a fork of
 * `base`, or one made from it), is graded in a sealed copy with `gradeCmd`
 * and the task's hidden `files` (or by `reward`, or by what `solve`
 * resolved with), and its sandbox is deleted. Infra failures and rate limits
 * are retried `retries` times on a fresh sandbox, with backoff and jitter;
 * what is still failing in `mask` comes back `masked: true` with
 * `reward: null`. With `run`, each rollout is recorded on it.
 */
export async function mapRollouts<T, O>(
  solve: (sandbox: CloudSandbox, task: T) => Promise<O>,
  tasks: Iterable<T>,
  opts: MapRolloutsOptions<T, O>,
): Promise<Rollouts<T, O>> {
  const list = [...tasks];
  const groupSize = opts.groupSize ?? 1;
  const retries = opts.retries ?? 2;
  const concurrency = opts.concurrency ?? 64;
  const mask = new Set(opts.mask ?? DEFAULT_MASK);
  if (!Number.isInteger(groupSize) || groupSize < 1) throw new Kosa8Error('groupSize must be a whole number of at least 1');
  if (!Number.isInteger(retries) || retries < 0) throw new Kosa8Error('retries must be a whole number of at least 0');
  const unknown = [...mask].filter((c) => !ALL_CLASSES.has(c));
  if (unknown.length) throw new Kosa8Error(`unknown failure classes in mask: ${unknown.join(', ')}`);
  const run = opts.run;
  const runId = run?.id;
  const step = opts.step ?? run?.nextStep();
  const policy = new RetryPolicy({ attempts: retries + 1 });
  const base = opts.base;
  const cloud = opts.cloud ?? run?.cloud;
  const pool = base instanceof CloudSandbox
    ? new ChildPool<T>({ base }, { ...(runId ? { runId } : {}), ...(run ? { leaseS: run.leaseS } : {}) })
    : new ChildPool<T>({ make: maker(cloud, base, run) });
  const filesFor = (task: T) => (typeof opts.files === 'function' ? opts.files(task) : opts.files ?? taskFiles(task));
  const signal = opts.signal;
  const onAbort = () => void pool.close();
  signal?.addEventListener('abort', onAbort, { once: true });

  const one = async (i: number): Promise<RolloutResult<T, O>> => {
    const g = Math.floor(i / groupSize);
    const task = list[g]!;
    const res: RolloutResult<T, O> = {
      task, group: g, index: i % groupSize, ...(step !== undefined ? { step } : {}), reward: null, failureClass: 'ok',
      masked: false, metrics: {}, exitCode: null, stdout: '', stderr: '', attempts: 0, durationMs: 0, recorded: false,
      meta: {}, ok: false,
    };
    const tid = taskId(task);
    if (tid !== undefined) res.meta.task = tid;
    const t0 = Date.now();
    let out: O | undefined;
    for (let attempt = 1; attempt <= retries + 1; attempt++) {
      res.attempts = attempt;
      if (signal?.aborted) {
        res.failureClass = 'error';
        res.error = 'cancelled before it ran';
        break;
      }
      let child: CloudSandbox | undefined;
      try {
        child = await pool.take(task);
        res.sandboxId = child.id;
        const c = child;
        out = await withTimeout(() => solve(c, task), opts.timeoutMs, () => pool.release(c));
        res.output = out;
        res.failureClass = 'ok';
        res.error = undefined;
        const gave = fromOutput(res as RolloutResult, out);
        if (opts.gradeCmd !== undefined) {
          // The solved state is still there: retry the grader alone, not the agent.
          const rollout: Record<string, unknown> = { group: res.group, index: res.index };
          if (step !== undefined) rollout.step = step;
          if (Object.keys(res.meta).length) rollout.meta = { ...res.meta };
          const gr = await callWithRetry(() => c.grade(opts.gradeCmd!, {
            files: filesFor(task), ...(opts.gradeTimeoutS !== undefined ? { timeoutS: opts.gradeTimeoutS } : {}),
            env: opts.gradeEnv, ...(runId ? { runId } : {}), rollout,
          }), policy, { signal });
          applyGrade(res as RolloutResult, gr, gr.raw.recorded !== undefined ? gr.recorded : !!runId);
        } else if (opts.reward) {
          const r = await opts.reward(c, task, out);
          if (!fromOutput(res as RolloutResult, r)) throw new TypeError('reward must return a number or { reward }');
        } else if (!gave) {
          throw new Kosa8Error(NO_REWARD, { body: { failure_class: 'error', retryable: false } });
        }
        break;
      } catch (e) {
        const f = classifyFailure(e);
        res.failureClass = f.failureClass;
        res.error = `${(e as Error)?.name ?? 'Error'}: ${String((e as Error)?.message ?? e)}`;
        res.reward = null;
        if (!f.retryable || attempt > retries) break;
        if (child) await pool.release(child);
        child = undefined;
        await sleepMs(policy.delayMs(e, attempt), signal);
      } finally {
        if (child) {
          if (opts.keep && res.failureClass !== 'infra') pool.forget(child);
          else await pool.release(child);
        }
      }
    }
    res.durationMs = Date.now() - t0;
    if (opts.meta) Object.assign(res.meta, opts.meta(task, out) ?? {});
    res.masked = mask.has(res.failureClass);
    if (res.masked) res.reward = null;
    res.ok = !res.masked && (res.failureClass === 'ok' || res.failureClass === 'exit_nonzero');
    if (run && !res.recorded) {
      try {
        await run.record(res as RolloutResult);
      } catch {
        // recording never fails a rollout
      }
    }
    return res;
  };

  try {
    const n = list.length * groupSize;
    if (n) await pool.prefork(Math.min(n, concurrency));
    const out = new Rollouts<T, O>();
    out.push(...(await runPool(n, concurrency, one)));
    return out;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    await pool.close();
  }
}



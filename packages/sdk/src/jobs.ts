// Copyright (c) 2026 kosa8. Licensed under the MIT License; see LICENSE.

/**
 * Hosted jobs on kosa8 Cloud: send tasks, a solver and a grader, and kosa8
 * runs every rollout server-side and records it as an RL run.
 *
 * ```ts
 * const job = await cloud.jobs.submit({
 *   name: 'swe-eval', template: 'python', tasks: readFileSync('tasks.jsonl', 'utf8'),
 *   solver: { cmd: 'python /workspace/solve.py', timeoutS: 1800 },
 *   grader: { cmd: 'pytest -q /hidden/test.py', files: { '/hidden/test.py': testPy } },
 *   concurrency: 64, budgetUsd: 20,
 * });
 * const done = await cloud.jobs.wait(job.id, { progress: (j) => console.log(j.progress) });
 * ```
 *
 * The job's rollouts land in the RL run `job.run_id` (step 0, group = the
 * task id, reward from the sealed grader): `RlRun` reads them. The Python
 * SDK's `cloud.jobs` is the same API.
 */

import { Kosa8Error, Kosa8TimeoutError } from './errors.js';
import type { CloudRequester } from './cloud-features.js';
import { idemOpts } from './cloud.js';

type Json = Record<string, unknown>;
const enc = encodeURIComponent;

/** Job statuses after which nothing more runs. */
export const JOB_DONE_STATES = ['done', 'failed', 'cancelled', 'budget_reached'] as const;
/** The most tasks one job takes. */
export const MAX_JOB_TASKS = 10_000;

export type CloudJobStatus = 'queued' | 'running' | (typeof JOB_DONE_STATES)[number] | (string & {});
/** A command: a string run with `sh -c`, or a list of arguments. */
export type CloudJobCmd = string | string[];
/** A file's contents: bytes as they are, a string as UTF-8 text. Sent base64-encoded. */
export type CloudJobFile = Uint8Array | string;

/** One task: its id (unique in the job; the rollout's group), its input and its files. */
export interface CloudJobTask {
  id: string | number;
  /** Any JSON, at most 32 KiB: given to the solver as `$KOSA8_TASK_INPUT` and a file. */
  input?: unknown;
  /** `{"/absolute/path": contents}` written into the task's sandbox before the solver runs (at most 256 KiB). */
  files?: Record<string, CloudJobFile>;
}

export interface CloudJobCmdSpec {
  cmd: CloudJobCmd;
  /** Seconds; a solver past it is recorded as `timeout`. */
  timeoutS?: number;
  env?: Record<string, string>;
}

export interface CloudJobGraderSpec extends CloudJobCmdSpec {
  /** Hidden files, written only into the sealed copy (no network) the grader runs in; at most 1 MiB. */
  files?: Record<string, CloudJobFile>;
}

export interface CloudJobOptions {
  name: string;
  /**
   * The tasks: a list, or JSONL text (one task per line, blank lines skipped;
   * its files already base64, as the API takes them). 1 to 10000; ids unique.
   */
  tasks: CloudJobTask[] | string;
  /** Run in each task's sandbox; `timeoutS` (here or `solverTimeoutS`) is required. */
  solver: CloudJobCmd | CloudJobCmdSpec;
  /** Scores a sealed copy of the sandbox after the solver. */
  grader: CloudJobCmd | CloudJobGraderSpec;
  /** Exactly one of `template`, `image` or `snapshot`. */
  template?: string;
  image?: string;
  snapshot?: string;
  /** A Cloud size, e.g. `2x4`. */
  size?: string;
  project?: string;
  solverTimeoutS?: number;
  graderTimeoutS?: number;
  /** More hidden grader files, merged over `grader.files`. */
  graderFiles?: Record<string, CloudJobFile>;
  /** Tasks in flight at once (default 16). */
  concurrency?: number;
  /** Infra failures retried this many times, then recorded masked (reward null). */
  retriesOnInfra?: number;
  /** Each task sandbox's lease, 120 to 86400 s (default 900). */
  leaseS?: number;
  /** Stop with status `budget_reached` once the job's list cost reaches this. */
  budgetUsd?: number;
}

/** A job as kosa8 Cloud answers it. */
export interface CloudJob {
  /** job_… */
  id: string;
  name?: string;
  project?: string | null;
  /** The RL run its rollouts land in. */
  run_id: string;
  status: CloudJobStatus;
  tasks?: number;
  counts?: Record<string, number>;
  /** Finished tasks by failure class: ok, exit_nonzero, timeout, oom, infra, quota, client. */
  by_failure_class?: Record<string, number>;
  progress?: { done: number; total: number; fraction: number };
  cost_usd?: number;
  sandbox_hours?: number | null;
  eta_s?: number | null;
  error?: string | null;
  [k: string]: unknown;
}

/** What a job would use. */
export interface CloudJobEstimate {
  /** `timeout` (from the solver's timeout) or `sample` (measured). */
  basis?: string;
  sandbox_hours?: { low: number; high: number };
  usd_list?: { low: number; high: number };
  included_hours_left?: number | null;
  /** With `sample`: the pilot job (`job_id`, `run_id`, `status`, ...). */
  sample?: Json;
  [k: string]: unknown;
}

/** Whether a job (as the API answers it) has finished. */
export function jobDone(job: { status?: string }): boolean {
  return (JOB_DONE_STATES as readonly string[]).includes(job.status ?? '');
}

function b64(data: CloudJobFile): string {
  if (typeof data !== 'string' && !(data instanceof Uint8Array)) {
    throw new Kosa8Error(`a file is a Uint8Array or a string, got ${typeof data}`);
  }
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const B = (globalThis as { Buffer?: { from(b: Uint8Array): { toString(enc: string): string } } }).Buffer;
  if (B) return B.from(bytes).toString('base64');
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/** `{"/abs/path": bytes | text}` as the API's `{"/abs/path": base64}`. */
export function encodeJobFiles(files: Record<string, CloudJobFile>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [p, v] of Object.entries(files)) {
    if (!p.startsWith('/')) throw new Kosa8Error(`file paths are absolute (in the sandbox), got ${JSON.stringify(p)}`);
    out[p] = b64(v);
  }
  return out;
}

/** Tasks as the API takes them; see `CloudJobOptions.tasks`. */
export function loadJobTasks(tasks: CloudJobTask[] | string): Json[] {
  const fromText = typeof tasks === 'string';
  let rows: unknown[];
  if (fromText) {
    rows = [];
    (tasks as string).split('\n').forEach((line, i) => {
      const t = line.trim();
      if (!t) return;
      try {
        rows.push(JSON.parse(t));
      } catch (e) {
        throw new Kosa8Error(`tasks line ${i + 1}: not JSON: ${(e as Error).message}`);
      }
    });
  } else {
    rows = [...tasks];
  }
  if (rows.length < 1 || rows.length > MAX_JOB_TASKS) {
    throw new Kosa8Error(`a job has 1 to ${MAX_JOB_TASKS} tasks, got ${rows.length}`);
  }
  const seen = new Set<string>();
  return rows.map((t, i) => {
    if (!t || typeof t !== 'object' || Array.isArray(t)) throw new Kosa8Error(`tasks[${i}] must be an object with an id`);
    const task = t as CloudJobTask;
    const id = typeof task.id === 'number' && Number.isInteger(task.id) ? String(task.id) : task.id;
    if (typeof id !== 'string' || !id) throw new Kosa8Error(`tasks[${i}] needs an id (a string)`);
    if (seen.has(id)) throw new Kosa8Error(`task id ${JSON.stringify(id)} appears twice`);
    seen.add(id);
    const row: Json = { id };
    if (task.input !== undefined && task.input !== null) row.input = task.input;
    if (task.files && Object.keys(task.files).length) {
      // Already base64 in JSONL: kept as is.
      row.files = fromText ? { ...task.files } : encodeJobFiles(task.files);
    }
    return row;
  });
}

function cmdSpec(spec: CloudJobCmd | CloudJobGraderSpec, what: string, files: boolean): Json {
  const s: CloudJobGraderSpec = typeof spec === 'string' || Array.isArray(spec) ? { cmd: spec } : spec;
  if (!s || typeof s !== 'object' || !s.cmd || (Array.isArray(s.cmd) && !s.cmd.length)) {
    throw new Kosa8Error(`${what} needs cmd (a string run with sh -c, or a list of arguments)`);
  }
  const extra = Object.keys(s).filter((k) => !['cmd', 'timeoutS', 'env', ...(files ? ['files'] : [])].includes(k));
  if (extra.length) throw new Kosa8Error(`${what}: unknown fields ${extra.sort().join(', ')}`);
  const out: Json = { cmd: typeof s.cmd === 'string' ? s.cmd : [...s.cmd] };
  if (s.timeoutS !== undefined) out.timeout_s = s.timeoutS;
  if (s.env && Object.keys(s.env).length) out.env = { ...s.env };
  if (files && s.files && Object.keys(s.files).length) out.files = encodeJobFiles(s.files);
  return out;
}

/** The body of `POST /v1/jobs` (and `/v1/jobs/estimate`), checked. */
export function jobBody(opts: CloudJobOptions): Json {
  if (!opts.name) throw new Kosa8Error('a job needs a name');
  if ([opts.template, opts.image, opts.snapshot].filter((x) => x !== undefined).length !== 1) {
    throw new Kosa8Error('give exactly one of template, image or snapshot');
  }
  const solver = cmdSpec(opts.solver, 'solver', false);
  if (opts.solverTimeoutS !== undefined) solver.timeout_s = opts.solverTimeoutS;
  if (solver.timeout_s === undefined) {
    throw new Kosa8Error('solver needs timeoutS (seconds; a solver past it is recorded as timeout)');
  }
  const grader = cmdSpec(opts.grader, 'grader', true);
  if (opts.graderTimeoutS !== undefined) grader.timeout_s = opts.graderTimeoutS;
  if (opts.graderFiles && Object.keys(opts.graderFiles).length) {
    grader.files = { ...(grader.files as Record<string, string> | undefined), ...encodeJobFiles(opts.graderFiles) };
  }
  const body: Json = { name: opts.name, tasks: loadJobTasks(opts.tasks), solver, grader };
  const more: [string, unknown][] = [
    ['project', opts.project], ['template', opts.template], ['image', opts.image], ['snapshot', opts.snapshot],
    ['size', opts.size], ['concurrency', opts.concurrency], ['retries_on_infra', opts.retriesOnInfra],
    ['lease_s', opts.leaseS], ['budget_usd', opts.budgetUsd],
  ];
  for (const [k, v] of more) if (v !== undefined) body[k] = v;
  return body;
}

/** The job of an answer (`{job}`, with `job_id`/`run_id` on a submit), always with `id` and `run_id`. */
function jobOf(answer: unknown): CloudJob {
  if (!answer || typeof answer !== 'object') return {} as CloudJob;
  const a = answer as { job?: Json; job_id?: string; run_id?: string };
  const job: Json = a.job && typeof a.job === 'object' ? { ...a.job } : {};
  if (a.job_id && !job.id) job.id = a.job_id;
  if (a.run_id && !job.run_id) job.run_id = a.run_id;
  return job as CloudJob;
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface CloudJobListOptions {
  status?: CloudJobStatus;
  project?: string;
  limit?: number;
  cursor?: string;
}

export interface CloudJobEstimateOptions extends CloudJobOptions {
  /** Start a pilot job of the first n tasks (1 to 50) and answer its id in `sample.job_id`. */
  sample?: number;
  /** Estimate from that finished pilot job's measured durations. */
  sampleJobId?: string;
}

export interface CloudJobWaitOptions {
  /** Called with the job on every poll. */
  progress?: (job: CloudJob) => unknown;
  /** Between polls (default 5000 ms). */
  pollMs?: number;
  /** Throws `Kosa8TimeoutError` past this; the job keeps running on kosa8. */
  timeoutMs?: number;
}

/**
 * Hosted jobs (`cloud.jobs`): kosa8 runs every task's rollout itself. Each
 * task gets its own sandbox (from `template`, `image` or `snapshot`); the
 * solver runs there with the task's input in `$KOSA8_TASK_INPUT` and a file,
 * then the sealed grader scores a copy with no network and the hidden grader
 * files. Infra failures are retried `retriesOnInfra` times, then recorded
 * masked (reward null).
 */
export class CloudJobs {
  constructor(private readonly cloud: CloudRequester) {}

  /**
   * Start a job; answers it (`id`, `run_id`, `status`, ...). The call carries
   * an Idempotency-Key (`idempotencyKey`, or a new one), so a retry after a
   * dropped connection starts the job once.
   */
  async submit(opts: CloudJobOptions & { idempotencyKey?: string }): Promise<CloudJob> {
    const { idempotencyKey, ...o } = opts;
    return jobOf(await this.cloud.request('POST', '/v1/jobs', jobBody(o), idemOpts(idempotencyKey)));
  }

  /** The job now: `status`, `counts`, `by_failure_class`, `progress`, `cost_usd`, `eta_s`. */
  async get(id: string): Promise<CloudJob> {
    return jobOf(await this.cloud.request('GET', `/v1/jobs/${enc(id)}`));
  }

  /** The org's jobs, newest first. */
  async list(opts: CloudJobListOptions = {}): Promise<CloudJob[]> {
    const q = new URLSearchParams();
    if (opts.status !== undefined) q.set('status', opts.status);
    if (opts.project !== undefined) q.set('project', opts.project);
    if (opts.limit !== undefined) q.set('limit', String(opts.limit));
    if (opts.cursor !== undefined) q.set('cursor', opts.cursor);
    const s = q.toString();
    return (await this.cloud.request<{ jobs?: CloudJob[] }>('GET', `/v1/jobs${s ? `?${s}` : ''}`)).jobs ?? [];
  }

  /** Stop starting rollouts and delete the job's sandboxes; answers the job. */
  async cancel(id: string): Promise<CloudJob> {
    return jobOf(await this.cloud.request('POST', `/v1/jobs/${enc(id)}/cancel`, {}));
  }

  /**
   * What a job would use: `sandbox_hours` and `usd_list` as `{low, high}`
   * ranges and `included_hours_left` on your plan. Takes `submit`'s options.
   * Without a sample the range comes from the solver's timeout; `sample: n`
   * starts a pilot job of the first n tasks (its id is in `sample.job_id`),
   * and once it is done `sampleJobId` estimates from its measured durations.
   */
  async estimate(opts: CloudJobEstimateOptions): Promise<CloudJobEstimate> {
    const { sample, sampleJobId, ...o } = opts;
    if (sample !== undefined && sampleJobId !== undefined) throw new Kosa8Error('give sample or sampleJobId, not both');
    const body = jobBody(o);
    if (sample !== undefined) body.sample = sample;
    if (sampleJobId !== undefined) body.sample_job_id = sampleJobId;
    return (await this.cloud.request<CloudJobEstimate>('POST', '/v1/jobs/estimate', body)) ?? {};
  }

  /**
   * Poll until the job finishes (done, failed, cancelled or budget_reached);
   * `progress(job)` is called on every poll (and awaited). Answers the final job.
   */
  async wait(id: string, opts: CloudJobWaitOptions = {}): Promise<CloudJob> {
    const every = opts.pollMs ?? 5000;
    const deadline = opts.timeoutMs === undefined ? undefined : Date.now() + opts.timeoutMs;
    for (;;) {
      const job = await this.get(id);
      if (opts.progress) await opts.progress(job);
      if (jobDone(job)) return job;
      if (deadline !== undefined && Date.now() + every > deadline) {
        throw new Kosa8TimeoutError(`job ${id} not finished after ${opts.timeoutMs} ms (status ${job.status})`);
      }
      await sleepMs(every);
    }
  }
}


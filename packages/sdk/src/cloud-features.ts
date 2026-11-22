// Copyright (c) 2026 kosa8. Licensed under the MIT License; see LICENSE.

/**
 * kosa8 Cloud features beyond a sandbox's basics: background commands,
 * durable snapshots, previews, secrets, egress, schedules, the code
 * interpreter and Pipelines. `cloud.ts` wires these onto `Kosa8Cloud` and
 * `CloudSandbox`; the types here are the API's own (snake_case fields, times
 * as the API sends them).
 */

import { Kosa8Error, Kosa8TimeoutError } from './errors.js';
import { CloudPreviewDomains } from './cloud-more.js';

type Json = Record<string, unknown>;

/** @internal What the resources here need from `Kosa8Cloud`. */
export interface CloudRequester {
  request<T = Json>(method: string, path: string, body?: unknown, opts?: { idempotencyKey?: string; signal?: AbortSignal }): Promise<T>;
  requestBytes(method: string, path: string, bytes?: Uint8Array): Promise<Uint8Array>;
}

const enc = encodeURIComponent;

/** The (encoded) sandbox id in `/v1/sandboxes/{id}`, so calls can spell their path out in full. */
function sandboxIdOf(sandboxPath: string): string {
  return sandboxPath.startsWith('/v1/sandboxes/') ? sandboxPath.slice('/v1/sandboxes/'.length) : sandboxPath;
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** `{K: v}` as the exec API's `["K=v"]`. */
export function envList(env: Record<string, string> | undefined): string[] | undefined {
  if (!env) return undefined;
  return Object.entries(env).map(([k, v]) => `${k}=${v}`);
}

// ---------------------------------------------------------------------------
// Background commands

/** A command started with `exec(cmd, { background: true })`, as the API reports it. */
export interface CloudBackgroundExecInfo {
  /** bg_… */
  id: string;
  sandbox_id: string;
  state: 'running' | 'exited' | (string & {});
  pid: number | null;
  /** Its exit code once it has exited. */
  exit: number | null;
  /** Where its stdout and stderr go, in the sandbox. */
  output_path: string | null;
  exit_path: string | null;
  /** Its output so far (status reads only). */
  output?: string | null;
  output_bytes?: number | null;
  output_truncated?: boolean;
  /** It was ended by `stop()`. */
  stopped?: boolean;
  /** It was ended because its `timeoutS` ran out. */
  timed_out?: boolean;
}

export interface CloudWaitOptions {
  /** Give up after this long. Default 10 minutes. */
  timeoutMs?: number;
  /** Time between polls. Default 1 s. */
  intervalMs?: number;
}

/**
 * A command that keeps running after `execBackground` returns. `status()`
 * reads its state and output so far; `wait()` polls until it exits.
 */
export class CloudBackgroundExec {
  constructor(
    private readonly cloud: CloudRequester,
    private readonly sandboxPath: string,
    public info: CloudBackgroundExecInfo,
  ) {}

  get id(): string {
    return this.info.id;
  }

  /** Running or exited, its exit code and its output so far. */
  async status(): Promise<CloudBackgroundExecInfo> {
    const r = await this.cloud.request<{ exec: CloudBackgroundExecInfo }>(
      'GET', `/v1/sandboxes/${sandboxIdOf(this.sandboxPath)}/exec/${enc(this.info.id)}`,
    );
    this.info = r.exec;
    return r.exec;
  }

  /**
   * Stop it and what it started (SIGTERM, then SIGKILL after 5 s). Resolves
   * with `stopping`, or `exited` when it had already ended; `status()` then
   * reports its exit code (143 or 137) and `stopped: true`.
   */
  async stop(): Promise<{ id: string; state: 'stopping' | 'exited' | (string & {}) }> {
    const r = await this.cloud.request<{ exec: { id: string; state: string } }>(
      'POST', `/v1/sandboxes/${sandboxIdOf(this.sandboxPath)}/exec/${enc(this.info.id)}/stop`, {},
    );
    return { id: r.exec?.id ?? this.info.id, state: r.exec?.state ?? 'stopping' };
  }

  /** Poll until it exits; resolves with its final status (exit code and output). */
  async wait(opts: CloudWaitOptions = {}): Promise<CloudBackgroundExecInfo> {
    const deadline = Date.now() + (opts.timeoutMs ?? 600_000);
    const every = opts.intervalMs ?? 1000;
    for (;;) {
      const s = await this.status();
      if (s.state === 'exited') return s;
      if (Date.now() + every > deadline) {
        throw new Kosa8TimeoutError(`background command ${this.info.id} still running after ${opts.timeoutMs ?? 600_000} ms`);
      }
      await sleepMs(every);
    }
  }
}

// ---------------------------------------------------------------------------
// Snapshots

/** A durable snapshot of a sandbox: memory, processes and disk, kept until deleted. */
export interface CloudSnapshot {
  /** snap_… */
  id: string;
  name: string | null;
  state: 'ready' | 'creating' | 'deleted' | 'error' | (string & {});
  source_sandbox_id: string;
  template: string;
  cpus: number;
  mem_mb: number;
  image: string | null;
  disk_gb: number | null;
  persistent: boolean;
  bytes: number;
  region: string | null;
  created_at: number;
  deleted_at: number | null;
  last_error: string | null;
}

/** The org's snapshots. Start a sandbox from one with `cloud.sandboxes.create({ snapshot })`. */
export class CloudSnapshots {
  constructor(private readonly cloud: CloudRequester) {}

  /** Snapshot a sandbox (by id). Same as `sandbox.snapshot(name)`. */
  async create(sandboxId: string, opts: { name?: string } = {}): Promise<CloudSnapshot> {
    const r = await this.cloud.request<{ snapshot: CloudSnapshot }>(
      'POST', `/v1/sandboxes/${enc(sandboxId)}/snapshots`, opts.name !== undefined ? { name: opts.name } : {},
    );
    return r.snapshot;
  }

  /** The org's snapshots, newest first; with `sandboxId`, only those of that sandbox. */
  async list(opts: { sandboxId?: string } = {}): Promise<CloudSnapshot[]> {
    const q = opts.sandboxId ? `?sandbox_id=${enc(opts.sandboxId)}` : '';
    return (await this.cloud.request<{ snapshots?: CloudSnapshot[] }>('GET', `/v1/snapshots${q}`)).snapshots ?? [];
  }

  async get(id: string): Promise<CloudSnapshot> {
    return (await this.cloud.request<{ snapshot: CloudSnapshot }>('GET', `/v1/snapshots/${enc(id)}`)).snapshot;
  }

  /** Delete a snapshot; sandboxes made from it keep running. */
  async delete(id: string): Promise<void> {
    await this.cloud.request('DELETE', `/v1/snapshots/${enc(id)}`);
  }
}

// ---------------------------------------------------------------------------
// Previews

/** A port of a sandbox at its own https URL. */
export interface CloudPreview {
  /** {sandbox_id}:{port}; `cloud.previewDomains(id)` takes it. */
  id?: string;
  port: number;
  /** Public previews need no token. */
  public: boolean;
  /** The URL to open; a private preview's carries its signed token. */
  url: string;
  host: string;
  token?: string;
  expires_at?: string;
  created_at?: number;
  /** A request to a sleeping sandbox wakes it. */
  wake?: boolean;
  wake_per_hour?: number;
}

export interface CloudPreviewOptions {
  /** Anyone with the URL can open it. Default false: a signed link. */
  public?: boolean;
  /** A private preview's link lasts this long, in seconds. */
  expiresInS?: number;
  /** Wake a sleeping sandbox on a request. */
  wake?: boolean;
  /** At most this many wakes an hour. */
  wakePerHour?: number;
}

function checkPort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Kosa8Error(`port must be 1 to 65535, got ${port}`);
}

/** A sandbox's previews: `sandbox.previews.create(3000)` gives an https URL for port 3000. */
export class CloudPreviews {
  constructor(private readonly cloud: CloudRequester, private readonly sandboxPath: string) {}

  /** Open a port at its own https URL (private, with a signed link, unless `public`). */
  async create(port: number, opts: CloudPreviewOptions = {}): Promise<CloudPreview> {
    checkPort(port);
    const body: Json = { port };
    if (opts.public !== undefined) body.public = opts.public;
    if (opts.expiresInS !== undefined) body.expires_in_s = opts.expiresInS;
    if (opts.wake !== undefined) body.wake = opts.wake;
    if (opts.wakePerHour !== undefined) body.wake_per_hour = opts.wakePerHour;
    return (await this.cloud.request<{ preview: CloudPreview }>('POST', `${this.sandboxPath}/previews`, body)).preview;
  }

  /** Its previews (no tokens). */
  async list(): Promise<CloudPreview[]> {
    return (await this.cloud.request<{ previews?: CloudPreview[] }>('GET', `${this.sandboxPath}/previews`)).previews ?? [];
  }

  /** A fresh signed link for a private preview. */
  async link(port: number, opts: { expiresInS?: number } = {}): Promise<CloudPreview> {
    checkPort(port);
    const body = opts.expiresInS !== undefined ? { expires_in_s: opts.expiresInS } : {};
    return (await this.cloud.request<{ preview: CloudPreview }>('POST', `${this.sandboxPath}/previews/${port}/link`, body)).preview;
  }

  /** A new host name for the preview; links to the old one stop working. */
  async rotate(port: number): Promise<CloudPreview> {
    checkPort(port);
    return (await this.cloud.request<{ preview: CloudPreview }>('POST', `${this.sandboxPath}/previews/${port}/rotate`, {})).preview;
  }

  /** Close the preview. */
  async delete(port: number): Promise<void> {
    checkPort(port);
    await this.cloud.request('DELETE', `/v1/sandboxes/${sandboxIdOf(this.sandboxPath)}/previews/${port}`);
  }
  /** The preview's custom domains: serve it at your own hostname. */
  domains(port: number): CloudPreviewDomains {
    checkPort(port);
    return new CloudPreviewDomains(this.cloud, `${this.sandboxPath}/previews/${port}`);
  }
}

// ---------------------------------------------------------------------------
// Egress

/** What a sandbox may reach on the network. */
export interface CloudEgressPolicy {
  /** Reach the whole internet (less `deny`). */
  internet?: boolean;
  /** Hosts or CIDRs it may reach, e.g. `pypi.org`, `*.github.com`. */
  allow?: string[];
  deny?: string[];
  /** Named sets from `cloud.egressPresets()`, e.g. `pypi`, `npm`. */
  presets?: string[];
}

export interface CloudEgress extends Required<CloudEgressPolicy> {
  /** Where the policy comes from: sandbox, org or default. */
  source: string;
  enforced: string;
}

// ---------------------------------------------------------------------------
// Secrets

/** A secret as the API lists it: never its value. */
export interface CloudSecret {
  name: string;
  /** The upstream host the placeholder is swapped for the value on, e.g. api.openai.com. */
  upstream?: string;
  header?: string;
  scheme?: string;
  methods?: string[];
  paths?: string[];
  env?: Record<string, string>;
  /** Pipelines runs may use it. */
  pipelines?: boolean;
  created_at?: number;
  updated_at?: number;
  last_used_at?: number | null;
}

export interface CloudSecretOptions {
  /** The host the secret may be sent to, e.g. api.openai.com. */
  upstream?: string;
  /** The header it goes in. Default Authorization. */
  header?: string;
  /** e.g. Bearer. */
  scheme?: string;
  methods?: string[];
  paths?: string[];
  /** Environment variables to set in sandboxes holding it (to the placeholder). */
  env?: Record<string, string>;
  /** Let Pipelines runs use it. */
  pipelines?: boolean;
}

/**
 * The org's secrets, kept encrypted. A sandbox created with
 * `secrets: ['NAME']` holds only a placeholder, swapped for the value on the
 * way out to `upstream`. Values are sent once, in a request body, and are
 * never returned or logged.
 */
export class CloudSecrets {
  constructor(private readonly cloud: CloudRequester) {}

  /** Store (or replace) a secret. */
  async set(name: string, value: string, opts: CloudSecretOptions = {}): Promise<{ secret: CloudSecret; replaced: boolean }> {
    if (!name) throw new Kosa8Error('a secret needs a name');
    if (typeof value !== 'string' || value === '') throw new Kosa8Error('a secret needs a value');
    const body: Json = { value };
    for (const k of ['upstream', 'header', 'scheme', 'methods', 'paths', 'env', 'pipelines'] as const) {
      if (opts[k] !== undefined) body[k] = opts[k];
    }
    const r = await this.cloud.request<{ secret: CloudSecret; replaced?: boolean }>('PUT', `/v1/secrets/${enc(name)}`, body);
    return { secret: r.secret, replaced: r.replaced === true };
  }

  async list(): Promise<CloudSecret[]> {
    return (await this.cloud.request<{ secrets?: CloudSecret[] }>('GET', '/v1/secrets')).secrets ?? [];
  }

  /** Delete a secret. Sandboxes holding it keep it until they are deleted; `stillHeldBy` names them. */
  async delete(name: string): Promise<{ deleted: string; stillHeldBy: string[] }> {
    const r = await this.cloud.request<{ deleted: string; still_held_by?: string[] }>('DELETE', `/v1/secrets/${enc(name)}`);
    return { deleted: r.deleted, stillHeldBy: r.still_held_by ?? [] };
  }
}

// ---------------------------------------------------------------------------
// Schedules

export interface CloudScheduleRun {
  at?: string;
  status: string;
  exit: number | null;
  error: string | null;
  output: string | null;
  ms: number | null;
}

export interface CloudSchedule {
  id: string;
  sandbox_id: string;
  name: string | null;
  /** Five-field cron, UTC. */
  cron: string;
  cmd: string[];
  env_names: string[];
  wake: boolean;
  next_run_at: string | null;
  runs: number;
  created_at: string;
  last_run: CloudScheduleRun | null;
}

export interface CloudScheduleOptions {
  /** Five-field cron, UTC, e.g. `0 * * * *`. */
  cron: string;
  /** A string runs through `sh -c`. */
  cmd: string | string[];
  env?: Record<string, string>;
  name?: string;
  /** Wake a sleeping sandbox for the run. */
  wake?: boolean;
}

/** Commands a sandbox runs on a cron schedule. */
export class CloudSchedules {
  constructor(private readonly cloud: CloudRequester, private readonly sandboxPath: string) {}

  async create(opts: CloudScheduleOptions): Promise<CloudSchedule> {
    if (!opts.cron) throw new Kosa8Error('a schedule needs a cron, e.g. "0 * * * *"');
    const body: Json = { cron: opts.cron, cmd: typeof opts.cmd === 'string' ? ['sh', '-c', opts.cmd] : opts.cmd };
    const env = envList(opts.env);
    if (env) body.env = env;
    if (opts.name !== undefined) body.name = opts.name;
    if (opts.wake !== undefined) body.wake = opts.wake;
    return (await this.cloud.request<{ schedule: CloudSchedule }>('POST', `${this.sandboxPath}/schedules`, body)).schedule;
  }

  async list(): Promise<CloudSchedule[]> {
    return (await this.cloud.request<{ schedules?: CloudSchedule[] }>('GET', `${this.sandboxPath}/schedules`)).schedules ?? [];
  }

  async delete(id: string): Promise<void> {
    await this.cloud.request('DELETE', `/v1/sandboxes/${sandboxIdOf(this.sandboxPath)}/schedules/${enc(id)}`);
  }

  /** Run it now; resolves with the run's result. */
  async run(id: string): Promise<{ schedule: CloudSchedule; run: CloudScheduleRun }> {
    return this.cloud.request('POST', `${this.sandboxPath}/schedules/${enc(id)}/run`, {});
  }
}

// ---------------------------------------------------------------------------
// Code interpreter

/** One output of a code cell: text, an image (base64 png), html, json and so on. */
export interface CloudCodeResult {
  type: 'text' | 'image/png' | 'html' | 'json' | (string & {});
  data: unknown;
  name?: string;
}

export interface CloudCodeRun {
  context: string;
  execution_count: number;
  results: CloudCodeResult[];
  stdout: string;
  stderr: string;
  /** Set when the cell raised. */
  error?: { name: string; value: string; traceback: string } | null;
  truncated?: boolean;
  woke_ms?: number;
}

export interface CloudCodeOptions {
  /** A named context: its globals persist between calls. Default `default`. */
  context?: string;
  /** Only python today. */
  language?: 'python';
  timeoutS?: number;
}

export interface CloudCodeContext {
  name: string;
  execution_count: number;
}

/** A sandbox's code-interpreter contexts. */
export class CloudCodeContexts {
  constructor(private readonly cloud: CloudRequester, private readonly sandboxPath: string) {}

  async list(): Promise<CloudCodeContext[]> {
    return (await this.cloud.request<{ contexts?: CloudCodeContext[] }>('GET', `${this.sandboxPath}/code/contexts`)).contexts ?? [];
  }

  async create(name?: string): Promise<CloudCodeContext> {
    return (await this.cloud.request<{ context: CloudCodeContext }>(
      'POST', `${this.sandboxPath}/code/contexts`, name !== undefined ? { name } : {},
    )).context;
  }

  /** Clear its globals. */
  async reset(name: string): Promise<void> {
    await this.cloud.request('POST', `${this.sandboxPath}/code/contexts/${enc(name)}/reset`, {});
  }

  async delete(name: string): Promise<void> {
    await this.cloud.request('DELETE', `/v1/sandboxes/${sandboxIdOf(this.sandboxPath)}/code/contexts/${enc(name)}`);
  }
}

// ---------------------------------------------------------------------------
// Pipelines

export interface CloudPipelineJob {
  name: string;
  kind: string;
  state: string;
  [k: string]: unknown;
}

/** One Pipelines run of a repository's `.kosa8/pipeline.yml` (or its GitHub workflows). */
export interface CloudPipelineRun {
  id: string;
  repo_url: string;
  ref: string;
  sha: string | null;
  branch: string | null;
  event: string;
  workflow: string | null;
  job: string | null;
  mode: string | null;
  state: 'queued' | 'running' | 'success' | 'failure' | 'cancelled' | 'error' | (string & {});
  error: string | null;
  warnings: string[];
  size: string | null;
  secrets: string[];
  hook_id: string | null;
  timeout_s: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  jobs: CloudPipelineJob[];
  [k: string]: unknown;
}

export interface CloudPipelineRunOptions {
  /** https URL of the repository. */
  repoUrl: string;
  /** Branch, tag or commit. Default the default branch. */
  ref?: string;
  event?: 'push' | 'pull_request' | 'workflow_dispatch' | 'schedule';
  /** A .github/workflows file to run through act instead of .kosa8/pipeline.yml. */
  workflow?: string;
  /** Only this job. */
  job?: string;
  inputs?: Record<string, string>;
  /** Sandbox size for the jobs, e.g. 4x8. */
  size?: string;
  /** Names of org secrets (stored with `pipelines: true`) the run may use. */
  secrets?: string[];
  /** The secret holding a token to clone a private repository. */
  tokenSecret?: string;
  /** The secret holding a token to post commit statuses. */
  statusSecret?: string;
  timeoutS?: number;
}

export interface CloudPipelineLogs {
  run_id: string;
  state: string;
  /** The run has finished and every log is complete. */
  done: boolean;
  /** Per job: `text` from the offset asked for; pass `next` as `after` for more. */
  logs: { job: string; state: string; text: string; next: number; bytes: number; truncated?: boolean }[];
}

export interface CloudPipelineArtifact {
  job: string;
  idx: number;
  path: string;
  bytes: number;
  url: string;
  created_at?: string;
}

export interface CloudPipelineHook {
  id: string;
  name: string | null;
  provider: 'github' | 'gitlab' | (string & {});
  repo_url: string;
  /** The webhook URL to give the git host. */
  url: string;
  /** The webhook's signing secret: shown in full only when the hook is made. */
  secret: string;
  size: string | null;
  secrets: string[];
  token_secret: string | null;
  status_secret: string | null;
  workflow: string | null;
  timeout_s: number | null;
  cron: string | null;
  cron_ref: string | null;
  next_run_at: string | null;
  deliveries: number;
  last_delivery_at: string | null;
  created_at: string;
}

export interface CloudPipelineHookOptions {
  repoUrl: string;
  provider?: 'github' | 'gitlab';
  name?: string;
  /** Your own signing secret; default one is made for you. */
  secret?: string;
  size?: string;
  secrets?: string[];
  tokenSecret?: string;
  statusSecret?: string;
  workflow?: string;
  timeoutS?: number;
  /** Also run on this cron schedule (UTC). */
  cron?: string;
  /** The ref a cron run builds. */
  cronRef?: string;
}

const DONE_STATES = new Set(['success', 'failure', 'cancelled', 'skipped', 'error']);

/** Is a run finished? */
export function pipelineRunDone(run: Pick<CloudPipelineRun, 'state' | 'finished_at'>): boolean {
  return DONE_STATES.has(run.state) || (run.finished_at !== null && run.finished_at !== undefined);
}

function pipelineBody(o: CloudPipelineRunOptions | CloudPipelineHookOptions): Json {
  if (!o.repoUrl) throw new Kosa8Error('a pipeline needs repoUrl');
  const body: Json = { repo_url: o.repoUrl };
  const map: [string, string][] = [
    ['ref', 'ref'], ['event', 'event'], ['workflow', 'workflow'], ['job', 'job'], ['inputs', 'inputs'],
    ['size', 'size'], ['secrets', 'secrets'], ['tokenSecret', 'token_secret'], ['statusSecret', 'status_secret'],
    ['timeoutS', 'timeout_s'], ['provider', 'provider'], ['name', 'name'], ['secret', 'secret'],
    ['cron', 'cron'], ['cronRef', 'cron_ref'],
  ];
  for (const [from, to] of map) {
    const v = (o as unknown as Json)[from];
    if (v !== undefined) body[to] = v;
  }
  return body;
}

/** CI on kosa8 Cloud: runs, their logs and artifacts, and webhook/cron triggers. */
export class CloudPipelines {
  readonly hooks: CloudPipelineHooks;

  constructor(private readonly cloud: CloudRequester) {
    this.hooks = new CloudPipelineHooks(cloud);
  }

  /** Start a run of a repository's `.kosa8/pipeline.yml` (or a GitHub workflow through act). */
  async run(opts: CloudPipelineRunOptions): Promise<CloudPipelineRun> {
    return (await this.cloud.request<{ run: CloudPipelineRun }>('POST', '/v1/pipelines/runs', pipelineBody(opts))).run;
  }

  /** Runs, newest first. */
  async list(opts: { state?: string; limit?: number } = {}): Promise<CloudPipelineRun[]> {
    const q = new URLSearchParams();
    if (opts.state) q.set('state', opts.state);
    if (opts.limit !== undefined) q.set('limit', String(opts.limit));
    const s = q.toString();
    return (await this.cloud.request<{ runs?: CloudPipelineRun[] }>('GET', `/v1/pipelines/runs${s ? `?${s}` : ''}`)).runs ?? [];
  }

  async get(id: string): Promise<CloudPipelineRun> {
    return (await this.cloud.request<{ run: CloudPipelineRun }>('GET', `/v1/pipelines/runs/${enc(id)}`)).run;
  }

  /** Logs by job, secrets replaced with ***. `after` is a byte offset (a previous answer's `next`). */
  logs(id: string, opts: { job?: string; after?: number } = {}): Promise<CloudPipelineLogs> {
    const q = new URLSearchParams();
    if (opts.job) q.set('job', opts.job);
    if (opts.after !== undefined) q.set('after', String(opts.after));
    const s = q.toString();
    return this.cloud.request('GET', `/v1/pipelines/runs/${enc(id)}/logs${s ? `?${s}` : ''}`);
  }

  async cancel(id: string): Promise<CloudPipelineRun> {
    return (await this.cloud.request<{ run: CloudPipelineRun }>('POST', `/v1/pipelines/runs/${enc(id)}/cancel`, {})).run;
  }

  async artifacts(id: string): Promise<CloudPipelineArtifact[]> {
    return (await this.cloud.request<{ artifacts?: CloudPipelineArtifact[] }>('GET', `/v1/pipelines/runs/${enc(id)}/artifacts`)).artifacts ?? [];
  }

  /** An artifact's bytes (a .tar.gz). */
  downloadArtifact(id: string, job: string, idx: number): Promise<Uint8Array> {
    return this.cloud.requestBytes('GET', `/v1/pipelines/runs/${enc(id)}/artifacts/${enc(job)}/${idx}`);
  }

  /** Poll until the run finishes; resolves with it. */
  async wait(id: string, opts: CloudWaitOptions = {}): Promise<CloudPipelineRun> {
    const limit = opts.timeoutMs ?? 3_600_000;
    const deadline = Date.now() + limit;
    const every = opts.intervalMs ?? 3000;
    for (;;) {
      const run = await this.get(id);
      if (pipelineRunDone(run)) return run;
      if (Date.now() + every > deadline) throw new Kosa8TimeoutError(`pipeline run ${id} not finished after ${limit} ms`);
      await sleepMs(every);
    }
  }
}

/** Webhook (push / pull request) and cron triggers for Pipelines. */
export class CloudPipelineHooks {
  constructor(private readonly cloud: CloudRequester) {}

  /** Make a webhook URL for a repository; give `url` and `secret` to the git host. */
  async create(opts: CloudPipelineHookOptions): Promise<CloudPipelineHook> {
    return (await this.cloud.request<{ hook: CloudPipelineHook }>('POST', '/v1/pipelines/hooks', pipelineBody(opts))).hook;
  }

  async list(): Promise<CloudPipelineHook[]> {
    return (await this.cloud.request<{ hooks?: CloudPipelineHook[] }>('GET', '/v1/pipelines/hooks')).hooks ?? [];
  }

  async delete(id: string): Promise<void> {
    await this.cloud.request('DELETE', `/v1/pipelines/hooks/${enc(id)}`);
  }
}

// ---------------------------------------------------------------------------
// Observability

export interface CloudMetrics {
  id: string;
  state: string;
  cpus: number;
  mem_mb: number;
  disk_gb: number;
  cpu_pct: number | null;
  cpu_seconds: number | null;
  mem_bytes: number | null;
  mem_pct: number | null;
  disk_bytes: number;
  net: { out_frames: number; out_bytes: number; in_frames: number; in_bytes: number };
  egress_denied: number;
  sleep_bytes: number;
  at: string;
}

export interface CloudLogEntry {
  at: string;
  cmd: string[];
  exit: number | null;
  ms: number;
  stream: boolean;
  direct: boolean;
  stdout_tail: string;
  stderr_tail: string;
  error?: string;
  oom?: boolean;
}

/** An interactive terminal: open `url` as a WebSocket (binary frames are the PTY). */
export interface CloudTerminal {
  url: string;
  expires_at: number;
  protocol: string;
}

/** A presigned URL for one GET or PUT of one file, straight to the host. */
export interface CloudFileLink {
  url: string;
  method: 'GET' | 'PUT';
  path: string;
  expires_at: number;
}

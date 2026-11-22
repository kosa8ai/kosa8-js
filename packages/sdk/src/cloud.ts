// Copyright (c) 2026 kosa8. Licensed under the MIT License; see LICENSE.

/**
 * kosa8 Cloud: the same sandboxes, run on kosa8's hosts (or your own, with
 * bring-your-own-cloud) instead of the local daemon.
 *
 * ```ts
 * import { Kosa8Cloud } from '@kosa8/sdk';
 *
 * const cloud = new Kosa8Cloud(); // KOSA8_API_KEY from the environment
 * const sbx = await cloud.sandboxes.create({ template: 'python', ttlS: 3600 });
 * const r = await sbx.exec(['python3', '-c', 'print(6 * 7)']);
 * console.log(r.stdout); // "42\n"
 * await sbx.delete();
 * ```
 *
 * Authentication is an API key (`k8c_live_…`) made in the cloud dashboard.
 * Errors are the SDK's usual typed errors; each carries the cloud's stable
 * `code` (for example `payment_required`, `quota_exceeded`).
 */

import {
  Kosa8ConnectionError,
  Kosa8Error,
  Kosa8ExecTimeoutError,
  Kosa8NotFoundError,
  Kosa8TimeoutError,
  classifyFailure,
  errorFromResponse,
} from './errors.js';
import type { FailureClass } from './errors.js';
import { NO_RETRY, RetryPolicy, callWithRetry } from './retry.js';
import type { RetryPolicyOptions } from './retry.js';
import { ensureDisposeSymbols } from './dispose.js';
import {
  CloudBurst,
  CloudEmbeds,
  CloudOrgTemplates,
  CloudPreviewDomains,
  CloudRecordings,
  CloudTokens,
} from './cloud-more.js';
import { CloudJobs } from './jobs.js';
import type { CloudRecording } from './cloud-more.js';
import { forkMap } from './forkmap.js';
import type { ForkMapOptions, ForkResult } from './forkmap.js';
import {
  CloudBackgroundExec,
  CloudCodeContexts,
  CloudPipelines,
  CloudPreviews,
  CloudSchedules,
  CloudSecrets,
  CloudSnapshots,
  envList,
} from './cloud-features.js';
import type {
  CloudBackgroundExecInfo,
  CloudCodeOptions,
  CloudCodeRun,
  CloudEgress,
  CloudEgressPolicy,
  CloudFileLink,
  CloudLogEntry,
  CloudMetrics,
  CloudSnapshot,
  CloudTerminal,
} from './cloud-features.js';

ensureDisposeSymbols();

export const DEFAULT_CLOUD_URL = 'https://api.kosa8.com';
export const CLOUD_KEY_PREFIX = 'k8c_live_';
/** A capability token from `cloud.tokens.create()` works as an API key too. */
export const CLOUD_TOKEN_PREFIX = 'k8c_tok_';
/** The label a run's sandboxes carry: `kosa8.run=<run id>`. Heartbeat and drain select by it. */
export const RUN_LABEL = 'kosa8.run';

export interface Kosa8CloudOptions {
  /** API key. Defaults to the KOSA8_API_KEY environment variable. */
  apiKey?: string;
  /** Control-plane address. Defaults to KOSA8_CLOUD_URL, then https://api.kosa8.com. */
  baseUrl?: string;
  /** Where to read KOSA8_API_KEY and KOSA8_CLOUD_URL from. Defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** A fetch to use instead of the global one (tests, proxies). */
  fetch?: typeof fetch;
  /** Per-request timeout. Default 120 s. */
  timeoutMs?: number;
  /**
   * Retries with backoff and jitter (default `new RetryPolicy()`: 3 tries).
   * Applied where sending again is safe: reads, PUTs, deletes, heartbeats and
   * drains on infra failures; creates, batches, forks and grades too, since
   * they carry an Idempotency-Key; any request on a 429 that may pass
   * (waiting at least its Retry-After). `false` turns it off.
   */
  retry?: RetryPolicy | RetryPolicyOptions | false;
}

/** Shortest and longest lifetime `ttlS` accepts, in seconds (1 minute to 90 days). */
export const MIN_TTL_S = 60;
export const MAX_TTL_S = 7_776_000;
/** Longest idle time before sleep `sleepAfterS` accepts, in seconds (7 days). */
export const MAX_SLEEP_AFTER_S = 604_800;
/** Most copies an all-or-nothing fork (a plain `fork(n)`) makes. */
export const MAX_FORK_N = 100;
/** Most copies one fork call makes (partial: made 100 at a time). */
export const MAX_FORK = 1000;
/** Most sandboxes one `createMany` makes. */
export const MAX_BATCH = 1000;
/** Shortest and longest lease `leaseS` accepts, in seconds (1 minute to 1 day). */
export const MIN_LEASE_S = 60;
export const MAX_LEASE_S = 86_400;

/** A cloud sandbox as the API reports it (the OpenAPI `Sandbox` schema). Times are Unix ms. */
export interface CloudSandboxInfo {
  id: string;
  state:
    | 'creating' | 'running' | 'paused' | 'sleeping' | 'stopped' | 'error' | 'deleted' | 'host_removed' | 'host_lost'
    | (string & {});
  template: string;
  /** The kosa8 Store version it was started (or forked) from. */
  origin_item_version?: string | null;
  cpus: number;
  mem_mb: number;
  source: 'pool' | 'restore' | 'cold' | 'fork' | null;
  /** The sandbox it was forked from, if any. */
  parent_id?: string | null;
  region: string | null;
  own_host: boolean;
  created_at: number;
  started_at: number | null;
  stopped_at: number | null;
  deleted_at: number | null;
  /** Unix ms when it is deleted automatically; null for no limit. */
  delete_after?: number | null;
  /** Idle seconds before it sleeps; 0 never. */
  sleep_after_s?: number | null;
  last_error: string | null;
  /** Its host has missed heartbeats; the sandbox is kept and is back when the host is. */
  host_unreachable?: boolean;
  running_s: number;
  asleep_s: number;
  sleep_bytes?: number;
  /** Cost estimate so far, USD. */
  cost_usd: number;
  /** Your name for it (`name` at create). */
  name?: string | null;
  /** The snapshot it was made from, if any. */
  snapshot_id?: string | null;
  image?: string | null;
  disk_gb?: number | null;
  persistent?: boolean;
  docker?: boolean;
  cpu?: 'shared' | 'dedicated' | (string & {}) | null;
  labels?: Record<string, string>;
  /** A lease's window in seconds (heartbeats move `delete_after` to now + it); null when not leased. */
  lease_s?: number | null;
  /** It records its desktop to MP4 (saved to Recordings when it is deleted). */
  record?: boolean;
  [k: string]: unknown;
}

/** vCPU x GiB sizes a sized create takes (the standard size and up). */
export const CLOUD_SIZES = ['2x4', '4x8', '8x16', '16x32'] as const;
/**
 * Small sizes for fleets of mostly idle sandboxes: that much vCPU reserved
 * and billed, bursting above it (to 1, 1 and 2 vCPU) while the host has idle
 * CPU. Only a create takes them, on hosts that run them (else 501).
 */
export const SMALL_CLOUD_SIZES = ['0.25x0.5', '0.5x1', '1x2'] as const;
export type CloudSize = (typeof CLOUD_SIZES)[number] | (typeof SMALL_CLOUD_SIZES)[number];

export interface CloudCreateOptions {
  /**
   * Template key from `cloud.templates()`, such as base, python or node, or a
   * kosa8 Store item (creator/name or creator/name@1.2.3). Defaults to the
   * org's setting.
   */
  template?: string;
  /** Region id, such as eu-hel1. Defaults to the org's setting (any region). */
  region?: string;
  /** Idle seconds before the sandbox sleeps (0..604800); 0 never. Defaults to the org's setting. */
  sleepAfterS?: number;
  /** Delete it this many seconds from now (60..7776000). Not with `deleteAfter`. */
  ttlS?: number;
  /** Or delete it at this time (Unix ms or a Date). Not with `ttlS`. */
  deleteAfter?: number | Date;
  /** A paid kosa8 Store item only: its current price in USD, which the person agreed to. */
  acceptPrice?: number;
  /**
   * vCPU x GiB: 2x4, 4x8, 8x16 or 16x32, or a small size (0.25x0.5, 0.5x1,
   * 1x2; `SMALL_CLOUD_SIZES`). With a size, `cpus`+`memMb`,
   * `image` or `diskGb` the sandbox boots cold at that size (needs a payment
   * method); `create` waits until it is running unless `wait: false`.
   */
  size?: CloudSize | (string & {});
  /** Or: the cpus and memMb of one of the sizes (4 and 8192 for 4x8, 0.25 and 512 for 0.25x0.5). */
  cpus?: number;
  memMb?: number;
  /**
   * An OCI image to run, e.g. `kosa8-template/universal-24.04-20261115.2`
   * (Ubuntu with common toolchains), `kosa8-template/universal-full-24.04-20261115.2`
   * or any registry image.
   */
  image?: string;
  /** Data disk (holds / and /workspace), 8..200 GiB; default 32. */
  diskGb?: number;
  /** One long-lived container: installs, $HOME and `nohup cmd &` persist between execs. */
  persistent?: boolean;
  /** Run a Docker engine in the sandbox (start `dockerd`); implies persistent and needs a size or image. */
  docker?: boolean;
  /** dedicated: whole physical cores of its own (never sleeps, no checkpoint or fork). Default shared. */
  cpu?: 'shared' | 'dedicated';
  /** Your name for it; `list({ name })` finds it. */
  name?: string;
  /** Environment variables every command in the sandbox gets. Never logged or returned. */
  env?: Record<string, string>;
  /**
   * Start from a snapshot (`snap_…` or a CloudSnapshot): files, packages and
   * processes as they were. Its template, size and image are the snapshot's.
   */
  snapshot?: string | CloudSnapshot;
  /** The network policy it starts with. */
  egress?: CloudEgressPolicy;
  /** Names of org secrets it holds (as placeholders). */
  secrets?: string[];
  /** Labels (at most 16, kosa8.run included), sent with the create and stored before it answers. */
  labels?: Record<string, string>;
  /**
   * A lease (60..86400 s): it is deleted this long from now unless a
   * heartbeat (`cloud.sandboxes.heartbeat`, or `rl.lease` in the
   * background) extends it, so a crashed client leaks nothing. Not with
   * `ttlS` or `deleteAfter`. Inside an `rl.Run` it defaults to the run's.
   */
  leaseS?: number;
  /** Label it `kosa8.run=<runId>` for heartbeat, drain and the RL runs page. Inside an `rl.Run` it defaults to the run's. */
  runId?: string;
  /** The kosa8-desktop image and persistent only: record the desktop to MP4, saved to Recordings when it is deleted. */
  record?: boolean;
  /**
   * The Idempotency-Key header. Default: a fresh UUID per call, reused
   * across that call's retries, so a retried create never makes two.
   */
  idempotencyKey?: string;
  /** Wait until a cold-booting (202 creating) sandbox is running. Default true. */
  wait?: boolean;
  /** How long to wait for it. Default 5 minutes. */
  waitTimeoutMs?: number;
}

/** Options `createMany` and `fork` share. */
export interface CloudFanoutOptions {
  /** Labels for every sandbox made (at most 16, kosa8.run included). */
  labels?: Record<string, string>;
  /** Adds the label kosa8.run=<runId>. Inside an `rl.Run` it defaults to the run's. */
  runId?: string;
  /** Lease each one (60..86400 s); see `CloudCreateOptions.leaseS`. Inside an `rl.Run` it defaults to the run's. */
  leaseS?: number;
  /** Name them `<prefix>-0001`, `<prefix>-0002`, … */
  prefix?: string;
  /** true: make what fits and list the rest in `failed`; false: all or nothing. */
  partialOk?: boolean;
  /** The Idempotency-Key header (default a fresh UUID, reused across retries). */
  idempotencyKey?: string;
}

/** `cloud.sandboxes.createMany(n, opts)`: any create field applies to every one. */
export interface CloudBatchOptions
  extends Omit<CloudCreateOptions, 'name' | 'labels' | 'runId' | 'leaseS' | 'idempotencyKey' | 'deleteAfter'>,
    CloudFanoutOptions {
  /** Default true here: make what fits. */
  partialOk?: boolean;
  /** Wait until every one is running (one that fails to boot is deleted and moved to `failed`). Default true. */
  wait?: boolean;
}

/** `box.fork(n, opts)`. */
export interface CloudForkOptions extends CloudFanoutOptions {
  /** How many copies, 1..1000. Default 1. Over 100, or with any other option, the fork is partial unless `partialOk: false`. */
  n?: number;
}

/** One sandbox a batch or fork did not make. */
export interface CloudFanoutFailure {
  /** Which of the requested sandboxes (0-based). */
  index: number;
  /** The error code, e.g. running_limit, quota_exceeded, no_capacity, host_failed. */
  code: string;
  message: string;
  failure_class: FailureClass | (string & {});
  retryable: boolean;
  /** Set when it was made but failed to boot (and was deleted). */
  id?: string;
}

/**
 * The sandboxes a batch create or a fork made: a plain array of
 * `CloudSandbox`, plus `failed` (one entry per sandbox not made),
 * `requested` and `created`.
 */
export type CloudSandboxBatch = CloudSandbox[] & {
  failed: CloudFanoutFailure[];
  requested: number;
  created: number;
  /** The run they were labelled for, when there was one. */
  runId?: string;
};

/** Which sandboxes a heartbeat or a drain is for: at least one; given together, all must match. */
export interface CloudSelector {
  /** Sandboxes labelled kosa8.run=<runId>. */
  runId?: string;
  /** Sandboxes with all of these labels. */
  labels?: Record<string, string>;
  /** These sandboxes (ids or `CloudSandbox`es), up to 1000. */
  ids?: (string | { id: string })[];
}

/** What `cloud.sandboxes.drain` answered. */
export interface CloudDrainResult {
  deleted: number;
  ids: string[];
  failed: { id: string; code: string; message: string; failure_class?: string; retryable?: boolean }[];
  /** More than 1000 matched: call again. */
  more: boolean;
}

/** `box.grade(cmd, opts)`. */
export interface CloudGradeOptions {
  /** Hidden files, `{ '/abs/path': 'text' | Uint8Array }`: at most 64, 8 MiB in all. Written only in the sealed copy. */
  files?: Record<string, string | Uint8Array>;
  /** 1..90 s. */
  timeoutS?: number;
  env?: Record<string, string>;
  /** Keep the copy (with a 1 h lease) to look at. Default false deletes it. */
  keep?: boolean;
  /** Record the result as a rollout of this RL run. Inside an `rl.Run` it defaults to the run's. */
  runId?: string;
  /** The rollout's place in the run. */
  rollout?: { step?: number; group?: string | number; index?: number; meta?: Record<string, unknown> };
  /** The Idempotency-Key header (default a fresh UUID, reused across retries). */
  idempotencyKey?: string;
  signal?: AbortSignal;
}

/** What `box.grade` answered. */
export interface CloudGradeResult {
  /**
   * The last stdout line that is JSON with a numeric `reward`, else 1.0 on
   * exit 0 and 0.0 otherwise; null when the command did not finish (mask
   * it rather than scoring it 0).
   */
  reward: number | null;
  metrics: Record<string, unknown>;
  rewardFrom: 'json' | 'exit' | null;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** ok, exit_nonzero, timeout, infra or quota. */
  failureClass: FailureClass | (string & {});
  retryable: boolean;
  ms: number | null;
  /** The sealed copy's id (deleted unless `keep`). */
  graderId: string | null;
  kept: boolean;
  /** Whether it was recorded on the run. */
  recorded: boolean;
  /** The whole answer. */
  raw: Record<string, unknown>;
}

export interface CloudUpdateOptions {
  /** Delete it this many seconds from now (60..7776000); `null` clears the lifetime. Not with `deleteAfter`. */
  ttlS?: number | null;
  /** Delete it at this time (Unix ms or a Date); `null` clears the lifetime. Not with `ttlS`. */
  deleteAfter?: number | Date | null;
  /** Idle seconds before it sleeps (0..604800); 0 never. */
  sleepAfterS?: number;
}

export interface CloudListOptions {
  /** Include deleted sandboxes. */
  all?: boolean;
  /** Page size. Sent to the API; servers without pagination ignore it. */
  limit?: number;
  /** `nextCursor` of the previous page. */
  cursor?: string;
  /** Only sandboxes with this name. */
  name?: string;
  /** Only sandboxes with these labels: `{ team: 'ml' }`; `true` matches any value. */
  labels?: Record<string, string | true>;
}

/** One page of `cloud.sandboxes.listPage()`. */
export interface CloudSandboxPage {
  sandboxes: CloudSandbox[];
  /** Pass as `cursor` for the next page; null when this is the last (or the server does not paginate). */
  nextCursor: string | null;
}

/** A file or folder in a cloud sandbox. */
export interface CloudFileInfo {
  name?: string;
  path: string;
  /** file | dir */
  type?: 'file' | 'dir' | (string & {});
  size?: number;
  mode?: string;
  mod_time?: string;
}

/** A saved checkpoint of a cloud sandbox: memory, processes and disk. */
export interface CloudCheckpoint {
  id: string;
  label?: string;
  /** Saved automatically before a rewind. */
  auto?: boolean;
  created_at?: string | null;
  bytes?: number;
}

export interface CloudRewindResult {
  /** The checkpoint it went back to. */
  checkpoint: CloudCheckpoint;
  /** The sandbox as it was before the rewind, saved automatically. */
  backup: CloudCheckpoint;
  ms: number | null;
}

/** A TCP port listening in a cloud sandbox. */
export interface CloudPort {
  port: number;
  address: string;
  container: string;
  loopback: boolean;
}

/** A template the org can create sandboxes from. */
export interface CloudTemplate {
  key: string;
  cpus?: number;
  mem_mb?: number;
  image?: string;
  regions?: string[];
  hosts?: number;
  warm?: number;
  own_host?: boolean;
  [k: string]: unknown;
}

export interface CloudExecOptions {
  /** Image to run the command in. Defaults to the template's own image. */
  image?: string;
  /** Environment variables for the command (over the sandbox's own `env`). */
  env?: Record<string, string>;
  /**
   * Stop the command after this many seconds (the API's `timeout_s`, 1..86400).
   * A buffered exec is held to 90 s whatever this says.
   */
  timeoutS?: number;
  /** Abort the request. The command itself may keep running in the sandbox. */
  signal?: AbortSignal;
}


export interface CloudExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** Set when the sandbox was asleep and woke for this command. */
  wokeMs?: number;
  /** ok (exit 0), exit_nonzero, or infra (the host gave no exit code); as the API sent it, else worked out from the exit code. */
  failureClass: 'ok' | 'exit_nonzero' | 'infra' | (string & {});
  /** Whether running it again may give another result (true only for infra). */
  retryable: boolean;
  /** The middle of stdout was dropped (a buffered exec keeps the first and last 1 MiB). */
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
}

export interface CloudInvocation {
  id: string;
  function: string;
  function_id: string;
  version: number;
  trigger: 'api' | 'web' | 'map' | 'cron' | string;
}

export interface CloudInvokeResult<T = unknown> {
  invocation: CloudInvocation | null;
  /** False when the handler raised; `error` then says what. */
  ok: boolean;
  result?: T;
  error?: { type: string; message: string };
  logs?: string;
  source?: 'pool' | 'restore' | null;
  timings_ms?: { start: number | null; run: number | null; host_total: number | null; total: number };
}

export interface CloudFunctionSpec {
  runtime: 'python3.12' | 'node22' | string;
  code: string;
  env?: Record<string, string>;
  timeout_s?: number;
  web?: 'off' | 'public' | 'key' | string;
  schedule?: string | null;
  [k: string]: unknown;
}

type Json = Record<string, unknown>;

/** @internal What `Kosa8Cloud.request` takes besides the call. */
export interface CloudRequestOptions {
  signal?: AbortSignal;
  /** Send this Idempotency-Key (and so retry a POST on infra failures too). */
  idempotencyKey?: string;
  /** This call's retry policy instead of the client's. */
  retry?: RetryPolicy;
}

/** A random UUID v4, for Idempotency-Key. */
export function newIdempotencyKey(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  const h = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16));
  h[12] = '4';
  h[16] = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  const s = h.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'PUT', 'DELETE']);
const SAFE_POSTS = new Set(['/v1/sandboxes/heartbeat', '/v1/sandboxes/drain']);

/** Whether a failed request may be sent again: safe to repeat, or a 429 (refused before anything was done). */
function retrySafe(method: string, path: string, idempotent: boolean, e: unknown): boolean {
  if (idempotent || SAFE_METHODS.has(method) || SAFE_POSTS.has(path.split('?')[0]!)) return true;
  return e instanceof Kosa8Error && e.status === 429;
}

function toPolicy(r: Kosa8CloudOptions['retry']): RetryPolicy {
  if (r === false) return NO_RETRY;
  if (r instanceof RetryPolicy) return r;
  return new RetryPolicy(r ?? {});
}

interface RawOptions {
  /** A JSON body. */
  json?: unknown;
  /** Raw bytes, sent as application/octet-stream. */
  bytes?: Uint8Array;
}

function toMs(v: number | Date): number {
  return v instanceof Date ? v.getTime() : v;
}

function checkInt(name: string, v: number, min: number, max: number): void {
  if (!Number.isInteger(v) || v < min || v > max) {
    throw new Kosa8Error(`${name} must be a whole number from ${min} to ${max}, got ${v}`);
  }
}

const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const PREFIX_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,58}$/;

function checkLease(name: string, v: number | undefined): void {
  if (v !== undefined) checkInt(name, v, MIN_LEASE_S, MAX_LEASE_S);
}

function checkRunId(v: string | undefined): void {
  if (v !== undefined && !RUN_ID_RE.test(v)) {
    throw new Kosa8Error("runId must be 1-128 letters, digits, '_', '.', ':' or '-', starting with a letter or digit");
  }
}

function checkLabels(labels: Record<string, string> | undefined): void {
  if (labels !== undefined && Object.keys(labels).length > 16) throw new Kosa8Error('a sandbox has at most 16 labels');
}

/** The run an `rl.Run` set on this client while it is open (runId, leaseS). */
function ambient(cloud: Kosa8Cloud): { runId?: string; leaseS?: number } {
  return cloud._runDefaults ?? {};
}

function fanoutBody(o: CloudFanoutOptions): Json {
  const body: Json = {};
  checkRunId(o.runId);
  checkLease('leaseS', o.leaseS);
  const labels = o.labels !== undefined || o.runId !== undefined ? { ...(o.labels ?? {}) } : undefined;
  if (labels && o.runId !== undefined) labels[RUN_LABEL] = o.runId;
  checkLabels(labels);
  if (o.labels !== undefined) body.labels = o.labels;
  if (o.runId !== undefined) body.run_id = o.runId;
  if (o.leaseS !== undefined) body.lease_s = o.leaseS;
  if (o.prefix !== undefined) {
    if (!PREFIX_RE.test(o.prefix)) throw new Kosa8Error("prefix must be 1-59 letters, digits, '.', '_' or '-', starting with a letter or digit");
    body.prefix = o.prefix;
  }
  if (o.partialOk !== undefined) body.partial_ok = o.partialOk;
  return body;
}

function selectorBody(sel: CloudSelector): Json {
  const body: Json = {};
  if (sel.runId) body.run_id = sel.runId;
  if (sel.labels && Object.keys(sel.labels).length) body.labels = sel.labels;
  if (sel.ids && sel.ids.length) {
    if (sel.ids.length > 1000) throw new Kosa8Error('at most 1000 ids a call');
    body.ids = sel.ids.map((i) => (typeof i === 'string' ? i : i.id));
  }
  if (Object.keys(body).length === 0) throw new Kosa8Error('give runId, labels or ids: which sandboxes');
  return body;
}

function toBatch(boxes: CloudSandbox[], failed: CloudFanoutFailure[], requested: number, runId?: string): CloudSandboxBatch {
  const out = boxes as CloudSandboxBatch;
  out.failed = failed;
  out.requested = requested;
  Object.defineProperty(out, 'created', { get: () => out.length, enumerable: false, configurable: true });
  if (runId !== undefined) out.runId = runId;
  return out;
}

function b64(data: string | Uint8Array): string {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const B = (globalThis as { Buffer?: { from(b: Uint8Array): { toString(enc: string): string } } }).Buffer;
  if (B) return B.from(bytes).toString('base64');
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function execResult(r: {
  exit: number | null; stdout?: string; stderr?: string; woke_ms?: number; failure_class?: string; retryable?: boolean;
  stdout_truncated?: boolean; stderr_truncated?: boolean;
}): CloudExecResult {
  const exit = r.exit ?? null;
  const fc = typeof r.failure_class === 'string' ? r.failure_class : !Number.isInteger(exit) ? 'infra' : exit === 0 ? 'ok' : 'exit_nonzero';
  const out: CloudExecResult = {
    exitCode: exit, stdout: r.stdout ?? '', stderr: r.stderr ?? '', failureClass: fc,
    retryable: typeof r.retryable === 'boolean' ? r.retryable : fc === 'infra',
  };
  if (typeof r.woke_ms === 'number') out.wokeMs = r.woke_ms;
  if (r.stdout_truncated) out.stdoutTruncated = true;
  if (r.stderr_truncated) out.stderrTruncated = true;
  return out;
}

function gradeResult(r: Json): CloudGradeResult {
  const exit = typeof r.exit === 'number' ? r.exit : null;
  const reward = typeof r.reward === 'number' ? r.reward : null;
  const fc = typeof r.failure_class === 'string' ? r.failure_class : exit === 0 ? 'ok' : exit === null ? 'infra' : 'exit_nonzero';
  return {
    reward,
    metrics: typeof r.metrics === 'object' && r.metrics !== null ? (r.metrics as Json) : {},
    rewardFrom: r.reward_from === 'json' || r.reward_from === 'exit' ? r.reward_from : null,
    exitCode: exit,
    stdout: typeof r.stdout === 'string' ? r.stdout : '',
    stderr: typeof r.stderr === 'string' ? r.stderr : '',
    failureClass: fc,
    retryable: typeof r.retryable === 'boolean' ? r.retryable : fc === 'infra',
    ms: typeof r.ms === 'number' ? r.ms : null,
    graderId: typeof r.grader_id === 'string' ? r.grader_id : null,
    kept: r.kept === true,
    recorded: r.recorded === true,
    raw: r,
  };
}

/** Delete, ignoring a sandbox that is gone already or an API that does not answer (its lease or TTL then deletes it). */
async function quietDelete(box: CloudSandbox): Promise<void> {
  try {
    await box.delete();
  } catch {
    // best effort
  }
}

/** Seconds from a Retry-After header (seconds or an HTTP date). */
function parseRetryAfter(h: string | null): number | undefined {
  if (!h) return undefined;
  const t = h.trim();
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
  const at = Date.parse(t);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, Math.ceil((at - Date.now()) / 1000));
}

function trimSlash(s: string): string {
  return s.replace(/\/+$/, '');
}

function checkBase(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Kosa8Error(`kosa8 Cloud address is not a URL: ${url}`);
  }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) {
    // The API key travels in every request.
    throw new Kosa8Error(`kosa8 Cloud address must use https: ${url}`);
  }
  return trimSlash(u.toString());
}

/** A client for the kosa8 Cloud control plane. */
export class Kosa8Cloud {
  readonly baseUrl: string;
  readonly sandboxes: CloudSandboxes;
  readonly functions: CloudFunctions;
  /** Durable snapshots. */
  readonly snapshots: CloudSnapshots;
  /** Org secrets (values go in, never come out). */
  readonly secrets: CloudSecrets;
  /** CI runs, logs, artifacts and triggers. */
  readonly pipelines: CloudPipelines;
  /** The org's own templates, built from an image or a Dockerfile and kept as a snapshot. */
  readonly orgTemplates: CloudOrgTemplates;
  /** Burst Passes: a raised running limit for some hours. */
  readonly burst: CloudBurst;
  /** Short-lived capability tokens limited to some scopes and sandboxes. */
  readonly tokens: CloudTokens;
  /** Desktop session recordings. */
  readonly recordings: CloudRecordings;
  /** Hosted jobs: kosa8 runs every task's rollout and grade server-side. */
  readonly jobs: CloudJobs;
  /** The retry policy every request uses unless it says otherwise. */
  readonly retry: RetryPolicy;
  /** @internal The run an `rl.Run` set while it is open: its sandboxes default to these. */
  _runDefaults?: { runId?: string; leaseS?: number };
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: Kosa8CloudOptions = {}) {
    const env = options.env ?? (typeof process !== 'undefined' ? process.env : {});
    const key = (options.apiKey ?? env.KOSA8_API_KEY ?? '').trim();
    if (!key) throw new Kosa8Error(`no kosa8 Cloud API key: set KOSA8_API_KEY or pass { apiKey }; make one at ${KEYS_URL}`);
    if (!key.startsWith(CLOUD_KEY_PREFIX) && !key.startsWith(CLOUD_TOKEN_PREFIX)) {
      throw new Kosa8Error(
        `a kosa8 Cloud API key starts with ${CLOUD_KEY_PREFIX} (a capability token with ${CLOUD_TOKEN_PREFIX}); ` +
          `check KOSA8_API_KEY or copy the whole key from ${KEYS_URL}`,
      );
    }
    this.apiKey = key;
    this.baseUrl = checkBase(options.baseUrl ?? env.KOSA8_CLOUD_URL ?? DEFAULT_CLOUD_URL);
    const f = options.fetch ?? globalThis.fetch;
    if (typeof f !== 'function') throw new Kosa8Error('no fetch available; pass options.fetch');
    this.fetchImpl = f;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.sandboxes = new CloudSandboxes(this);
    this.functions = new CloudFunctions(this);
    this.snapshots = new CloudSnapshots(this);
    this.secrets = new CloudSecrets(this);
    this.pipelines = new CloudPipelines(this);
    this.orgTemplates = new CloudOrgTemplates(this);
    this.burst = new CloudBurst(this);
    this.tokens = new CloudTokens(this);
    this.recordings = new CloudRecordings(this);
    this.jobs = new CloudJobs(this);
    this.retry = toPolicy(options.retry);
  }

  /**
   * The custom domains of a preview by its id (`{sandbox_id}:{port}`, the
   * `id` of a `CloudPreview`). `box.previews.domains(port)` is the same.
   */
  previewDomains(previewId: string): CloudPreviewDomains {
    return new CloudPreviewDomains(this, `/v1/previews/${encodeURIComponent(previewId)}`);
  }

  /**
   * Run `fn(child, item)` for every item, each in its own fork of `base`,
   * `concurrency` at a time; results in input order. Children are forked
   * ahead in batches, always deleted when `fn` settles, and all deleted if
   * the map is aborted (`signal`). A failure is not thrown: its result has
   * `error` and `failureClass`. Infra failures and rate limits are retried
   * `retries` times on a fresh fork, with backoff and jitter; `timeoutMs`
   * gives up on an item (`failureClass: 'timeout'`) and deletes its child.
   */
  forkMap<I, R>(
    base: CloudSandbox,
    fn: (child: CloudSandbox, item: I, index: number) => Promise<R>,
    items: Iterable<I>,
    opts: ForkMapOptions = {},
  ): Promise<ForkResult<I, R>[]> {
    return forkMap(base, fn, items, opts);
  }

  /** What this API offers, for feature detection. */
  capabilities(): Promise<Json> {
    return this.request('GET', '/v1/capabilities');
  }

  /** Named egress presets (e.g. pypi, npm) and the hosts each allows. */
  async egressPresets(): Promise<Record<string, unknown>> {
    return (await this.request<{ presets?: Record<string, unknown> }>('GET', '/v1/egress/presets')).presets ?? {};
  }

  /** The organization's default egress policy; null when there is none (open internet). */
  async orgEgress(): Promise<{ default: CloudEgressPolicy; enforce: boolean; enforced?: unknown } | null> {
    return (await this.request<{ egress: { default: CloudEgressPolicy; enforce: boolean } | null }>('GET', '/v1/org/egress')).egress;
  }

  /**
   * Set the org's default egress policy (admin key); `null` clears it. It is
   * pushed at once to the running and sleeping sandboxes it changes. With
   * `enforce`, it is a ceiling sandboxes cannot widen.
   */
  setOrgEgress(policy: CloudEgressPolicy | null, opts: { enforce?: boolean } = {}): Promise<Json> {
    const body: Json = { default: policy };
    if (policy !== null && opts.enforce !== undefined) body.enforce = opts.enforce;
    return this.request('PUT', '/v1/org/egress', body);
  }

  /** The org, the key in use and, for a member's key, the member. */
  me(): Promise<Json> {
    return this.request('GET', '/v1/me');
  }

  /** This month's usage, bill estimate and whether work is paused for payment. */
  usage(): Promise<Json> {
    return this.request('GET', '/v1/usage');
  }

  /** Templates the org can create sandboxes from now. */
  async templates(): Promise<CloudTemplate[]> {
    return (await this.request<{ templates: CloudTemplate[] }>('GET', '/v1/templates')).templates ?? [];
  }

  /** @internal One call, retried as the policy and the call allow. */
  request<T = Json>(method: string, path: string, body?: unknown, opts: CloudRequestOptions = {}): Promise<T> {
    const policy = opts.retry ?? this.retry;
    const idem = opts.idempotencyKey !== undefined;
    return callWithRetry(() => this.requestOnce<T>(method, path, body, opts), policy, {
      signal: opts.signal,
      shouldRetry: (e, attempt) => policy.shouldRetry(e, attempt) && retrySafe(method, path, idem, e),
    });
  }

  private async requestOnce<T>(method: string, path: string, body: unknown, opts: CloudRequestOptions): Promise<T> {
    const extra: Record<string, string> = {};
    if (opts.idempotencyKey !== undefined) extra['Idempotency-Key'] = opts.idempotencyKey;
    const resp = await this.send(method, path, body !== undefined ? { json: body } : {}, 'application/json', opts.signal, extra);
    const text = await resp.text();
    let data: unknown = text;
    try {
      data = text === '' ? null : JSON.parse(text);
    } catch {
      // not JSON; kept as text
    }
    if (!resp.ok) throw cloudError(resp, data, { method, path });
    return data as T;
  }

  /** @internal Raw bytes in and/or out (the files endpoints), retried as `request` is. */
  requestBytes(method: string, path: string, bytes?: Uint8Array): Promise<Uint8Array> {
    return callWithRetry(() => this.requestBytesOnce(method, path, bytes), this.retry, {
      shouldRetry: (e, attempt) => this.retry.shouldRetry(e, attempt) && retrySafe(method, path, false, e),
    });
  }

  private async requestBytesOnce(method: string, path: string, bytes?: Uint8Array): Promise<Uint8Array> {
    const resp = await this.send(method, path, bytes !== undefined ? { bytes } : {}, 'application/octet-stream, application/json');
    const buf = new Uint8Array(await resp.arrayBuffer());
    if (!resp.ok) {
      const text = new TextDecoder().decode(buf);
      let data: unknown = text;
      try {
        data = text === '' ? null : JSON.parse(text);
      } catch {
        // not JSON; kept as text
      }
      throw cloudError(resp, data, { method, path });
    }
    return buf;
  }

  private async send(
    method: string, path: string, raw: RawOptions, accept: string, signal?: AbortSignal, extra: Record<string, string> = {},
  ): Promise<Response> {
    signal?.throwIfAborted();
    const ctl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctl.abort();
    }, this.timeoutMs);
    // The caller's signal also ends the request, body included.
    const anyOf = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
    let fetchSignal = ctl.signal;
    if (signal && anyOf) fetchSignal = anyOf([ctl.signal, signal]);
    else if (signal) signal.addEventListener('abort', () => ctl.abort(signal.reason), { once: true });
    const headers: Record<string, string> = { Authorization: `Bearer ${this.apiKey}`, Accept: accept, ...extra };
    let body: BodyInit | undefined;
    if (raw.bytes !== undefined) {
      headers['Content-Type'] = 'application/octet-stream';
      body = raw.bytes as unknown as BodyInit;
    } else if (raw.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(raw.json);
    }
    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, { method, headers, body, signal: fetchSignal });
    } catch (e) {
      if (signal?.aborted && !timedOut) throw signal.reason ?? e;
      if (ctl.signal.aborted) {
        throw new Kosa8TimeoutError(
          `kosa8 Cloud did not answer ${method} ${path} within ${this.timeoutMs} ms; retry, or raise timeoutMs in new Kosa8Cloud({ timeoutMs })`,
          { method, path, cause: e },
        );
      }
      throw new Kosa8ConnectionError(
        `could not reach kosa8 Cloud at ${this.baseUrl}: ${String((e as Error)?.message ?? e)}; ` +
          'check the network connection and KOSA8_CLOUD_URL (unset it for https://api.kosa8.com), then retry',
        { method, path, cause: e },
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

const EXEC_LIMIT_HINT =
  'a buffered kosa8 Cloud exec is stopped after 90 s; run long jobs in the background ' +
  "(sh -c 'nohup cmd > /workspace/out.log 2>&1 &') and poll /workspace for the result";

/**
 * The cloud answers {error: code, message, upgrade_url?, agent_message?}. The
 * SDK's errors read the sentence as their message, keep the code, and keep
 * the whole answer as `body`.
 */
function cloudError(resp: Response, body: unknown, ctx: { method: string; path: string }): Kosa8Error {
  const status = resp.status;
  let code: string | undefined;
  let message: string | undefined;
  if (typeof body === 'object' && body !== null) {
    const b = body as Json;
    if (typeof b.error === 'string') code = b.error;
    const m = typeof b.message === 'string' && b.message ? b.message : b.error;
    if (typeof m === 'string' && m) message = m;
  } else if (typeof body === 'string' && body.trim() !== '') {
    message = body.trim();
  }
  const pathOnly = ctx.path.split('?')[0]!;
  const execTimeout =
    status === 504 ||
    code === 'exec_timeout' ||
    (status === 502 && code === 'host_failed' && pathOnly.endsWith('/exec') && /timed out/i.test(message ?? ''));
  const requestId = resp.headers?.get?.('X-Request-Id') || resp.headers?.get?.('cf-ray') || undefined;
  if (execTimeout) {
    const base = message ?? `request failed with HTTP ${status}`;
    // Its own timeoutS (exec(cmd, { timeoutS })) needs no hint about the 90 s limit.
    const hint = /timeout_s/.test(message ?? '') ? '' : ` (${EXEC_LIMIT_HINT})`;
    return new Kosa8ExecTimeoutError(`${base}${hint}${requestId ? ` [request ${requestId}]` : ''}`, {
      status, daemonMessage: message, body, code, ...ctx, ...(requestId ? { requestId } : {}),
    });
  }
  let retryAfter = parseRetryAfter(resp.headers?.get?.('Retry-After') ?? null);
  const b = typeof body === 'object' && body !== null ? (body as Json) : undefined;
  if (retryAfter === undefined && typeof b?.retry_after_s === 'number' && b.retry_after_s > 0) {
    retryAfter = b.retry_after_s;
  }
  const e = errorFromResponse(status, message !== undefined ? { error: message } : body, {
    ...ctx, code, body, ...(retryAfter !== undefined ? { retryAfter } : {}), ...(requestId ? { requestId } : {}),
  });
  e.message = actionableMessage(e.message, { status, code, retryAfter, requestId, upgradeUrl: typeof b?.upgrade_url === 'string' ? b.upgrade_url : undefined });
  return e;
}

/** Where a person makes or replaces a kosa8 Cloud API key. */
export const KEYS_URL = 'https://app.kosa8.com/app#keys';

/**
 * The server's sentence plus what a reader needs to act: a key hint on a
 * 401, then `[HTTP status code; retry in n s; request id; upgrade: url]`.
 */
function actionableMessage(
  sentence: string,
  o: { status: number; code?: string; retryAfter?: number; requestId?: string; upgradeUrl?: string },
): string {
  let m = sentence;
  if (o.status === 401) m += ` (check KOSA8_API_KEY; make a new key at ${KEYS_URL})`;
  const parts = [`HTTP ${o.status}${o.code ? ` ${o.code}` : ''}`];
  if (o.retryAfter !== undefined) parts.push(`retry in ${Math.round(o.retryAfter * 10) / 10} s`);
  if (o.requestId) parts.push(`request ${o.requestId}`);
  if (o.upgradeUrl && !sentence.includes(o.upgradeUrl)) parts.push(`upgrade: ${o.upgradeUrl}`);
  return `${m} [${parts.join('; ')}]`;
}

function createBody(opts: CloudCreateOptions): Json {
  const body: Json = {};
  if (opts.ttlS !== undefined && opts.deleteAfter !== undefined) {
    throw new Kosa8Error('give ttlS or deleteAfter, not both');
  }
  if (opts.template !== undefined) body.template = opts.template;
  if (opts.region !== undefined) body.region = opts.region;
  if (opts.sleepAfterS !== undefined) {
    checkInt('sleepAfterS', opts.sleepAfterS, 0, MAX_SLEEP_AFTER_S);
    body.sleep_after_s = opts.sleepAfterS;
  }
  if (opts.ttlS !== undefined) {
    checkInt('ttlS', opts.ttlS, MIN_TTL_S, MAX_TTL_S);
    body.ttl_s = opts.ttlS;
  }
  if (opts.deleteAfter !== undefined) body.delete_after = toMs(opts.deleteAfter);
  if (opts.leaseS !== undefined) {
    if (opts.ttlS !== undefined || opts.deleteAfter !== undefined) {
      throw new Kosa8Error('give leaseS or ttlS/deleteAfter, not both: a lease is a TTL that heartbeats move forward');
    }
    checkLease('leaseS', opts.leaseS);
    body.lease_s = opts.leaseS;
  }
  if (opts.acceptPrice !== undefined) body.accept_price = opts.acceptPrice;
  if (opts.snapshot !== undefined) {
    const clash = (['template', 'size', 'cpus', 'memMb', 'image', 'diskGb', 'docker', 'persistent', 'cpu', 'region'] as const)
      .filter((k) => opts[k] !== undefined);
    if (clash.length) {
      throw new Kosa8Error(`a sandbox made from a snapshot takes its settings from the snapshot; leave out ${clash.join(', ')}`);
    }
    body.snapshot = typeof opts.snapshot === 'string' ? opts.snapshot : opts.snapshot.id;
  }
  if ((opts.cpus === undefined) !== (opts.memMb === undefined)) throw new Kosa8Error('give cpus and memMb together');
  if (opts.size !== undefined && opts.cpus !== undefined) throw new Kosa8Error('give size or cpus+memMb, not both');
  if (opts.size !== undefined) body.size = opts.size;
  if (opts.cpus !== undefined) body.cpus = opts.cpus;
  if (opts.memMb !== undefined) body.mem_mb = opts.memMb;
  if (opts.image !== undefined) body.image = opts.image;
  if (opts.diskGb !== undefined) {
    checkInt('diskGb', opts.diskGb, 8, 200);
    body.disk_gb = opts.diskGb;
  }
  if (opts.docker && opts.persistent === false) {
    throw new Kosa8Error('a sandbox with docker is persistent; leave out persistent or set it to true');
  }
  if (opts.docker !== undefined) body.docker = opts.docker;
  if (opts.persistent !== undefined) body.persistent = opts.persistent;
  if (opts.cpu !== undefined) body.cpu = opts.cpu;
  if (opts.name !== undefined) body.name = opts.name;
  if (opts.env !== undefined) body.env = opts.env;
  if (opts.egress !== undefined) body.egress = opts.egress;
  if (opts.secrets !== undefined) body.secrets = opts.secrets;
  if (opts.record !== undefined) body.record = opts.record;
  return body;
}

/** Poll every not-yet-running sandbox of `batch` until each settles; drop (and delete) the ones that fail. */
async function waitAll(batch: CloudSandboxBatch, timeoutMs: number, partialOk: boolean): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const keep: CloudSandbox[] = [];
  try {
    // One at a time, as boots run in parallel anyway: later ones have mostly settled by their turn.
    for (const [i, box] of [...batch].entries()) {
      try {
        if (!SETTLED.has(box.info.state)) {
          await box.waitUntilRunning({ timeoutMs: Math.max(1000, deadline - Date.now()) });
        } else if (box.info.state === 'error') {
          throw new Kosa8Error(`sandbox ${box.id} failed to start: ${box.info.last_error ?? 'no reason given'}`);
        }
        keep[i] = box;
      } catch (e) {
        if (!partialOk || !(e instanceof Kosa8Error)) throw e;
        await quietDelete(box);
        const fc = classifyFailure(e).failureClass;
        batch.failed.push({
          index: i, id: box.id, code: e.code ?? 'not_ready', message: e.message,
          failure_class: fc === 'error' ? 'infra' : fc, retryable: true,
        });
      }
    }
  } catch (e) {
    await Promise.all(batch.map(quietDelete));
    throw e;
  }
  const kept = keep.filter(Boolean);
  batch.length = 0;
  batch.push(...kept);
}

/** States a sandbox does not leave on its own while booting. */
const SETTLED = new Set(['running', 'error', 'deleted', 'stopped', 'host_removed', 'host_lost', 'sleeping', 'paused']);

function sleepFor(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function listQuery(opts: CloudListOptions): string {
  const q = new URLSearchParams();
  if (opts.all) q.set('all', '1');
  if (opts.limit !== undefined) q.set('limit', String(opts.limit));
  if (opts.cursor !== undefined && opts.cursor !== '') q.set('cursor', opts.cursor);
  if (opts.name !== undefined) q.set('name', opts.name);
  for (const [k, v] of Object.entries(opts.labels ?? {})) q.append('label', v === true ? k : `${k}=${v}`);
  const s = q.toString();
  return s ? `?${s}` : '';
}

export class CloudSandboxes {
  constructor(private readonly cloud: Kosa8Cloud) {}

  /**
   * Start a sandbox; resolves once it is running. Only the options you set
   * are sent. `ttlS` (60..7776000) and `deleteAfter` are checked before any
   * request, and only one of them may be given.
   */
  async create(opts: CloudCreateOptions = {}): Promise<CloudSandbox> {
    const amb = ambient(this.cloud);
    const lifetime = opts.ttlS !== undefined || opts.deleteAfter !== undefined;
    const o: CloudCreateOptions = {
      ...opts,
      leaseS: opts.leaseS ?? (lifetime ? undefined : amb.leaseS),
      runId: opts.runId ?? amb.runId,
    };
    checkRunId(o.runId);
    const labels = o.runId !== undefined ? { ...(o.labels ?? {}), [RUN_LABEL]: o.runId } : o.labels;
    checkLabels(labels);
    const body = createBody(o);
    if (labels !== undefined) body.labels = labels;
    const r = await this.cloud.request<{ sandbox: CloudSandboxInfo }>('POST', '/v1/sandboxes', body, {
      idempotencyKey: opts.idempotencyKey ?? newIdempotencyKey(),
    });
    const box = new CloudSandbox(this.cloud, r.sandbox);
    if (opts.wait !== false && !SETTLED.has(box.info.state)) {
      try {
        await box.waitUntilRunning(opts.waitTimeoutMs !== undefined ? { timeoutMs: opts.waitTimeoutMs } : {});
      } catch (e) {
        // It was made but did not come up: do not leave it running.
        await quietDelete(box);
        throw e;
      }
    }
    return box;
  }

  /**
   * Start `n` (1..1000) sandboxes in one call (`POST /v1/sandboxes/batch`);
   * kosa8 Cloud paces the creates itself, so there is no 429 storm. With
   * `partialOk` (the default here) the ones it could not make (past the
   * plan's running limit, say: code `running_limit`) are listed in
   * `failed`; with `partialOk: false` it is all or nothing and the refusal
   * is thrown. `wait` (default true) polls each one until it is running; one
   * that fails to boot is deleted and moved to `failed`.
   */
  async createMany(n: number, opts: CloudBatchOptions = {}): Promise<CloudSandboxBatch> {
    checkInt('n', n, 1, MAX_BATCH);
    const amb = ambient(this.cloud);
    const { labels, runId, leaseS, prefix, partialOk, idempotencyKey, wait, waitTimeoutMs, ...create } = opts;
    const fan: CloudFanoutOptions = {
      labels, prefix, partialOk: partialOk ?? true,
      runId: runId ?? amb.runId,
      leaseS: leaseS ?? (create.ttlS !== undefined ? undefined : amb.leaseS),
    };
    if (fan.leaseS !== undefined && create.ttlS !== undefined) throw new Kosa8Error('give leaseS or ttlS, not both');
    const body: Json = { count: n, ...createBody(create), ...fanoutBody(fan) };
    const r = await this.cloud.request<{
      sandboxes?: CloudSandboxInfo[]; failed?: CloudFanoutFailure[]; requested?: number; run_id?: string;
    }>('POST', '/v1/sandboxes/batch', body, { idempotencyKey: idempotencyKey ?? newIdempotencyKey() });
    const batch = toBatch(
      (r.sandboxes ?? []).map((s) => new CloudSandbox(this.cloud, s)), r.failed ?? [], r.requested ?? n, r.run_id ?? fan.runId,
    );
    if (wait !== false) await waitAll(batch, waitTimeoutMs ?? 300_000, fan.partialOk !== false);
    return batch;
  }

  /**
   * Push back the leases of the matching leased sandboxes to now + `extendS`
   * (default: each one's own lease). Resolves with how many moved. A lapsed
   * lease is not brought back. `rl.lease` does this in the background.
   */
  async heartbeat(sel: CloudSelector & { extendS?: number }): Promise<number> {
    const body = selectorBody(sel);
    if (sel.extendS !== undefined) {
      checkLease('extendS', sel.extendS);
      body.extend_s = sel.extendS;
    }
    const r = await this.cloud.request<{ extended?: number }>('POST', '/v1/sandboxes/heartbeat', body);
    return r?.extended ?? 0;
  }

  /** Delete every matching sandbox (up to 1000 a call; `more` says to call again). Allowed while the org is frozen. */
  async drain(sel: CloudSelector): Promise<CloudDrainResult> {
    const r = await this.cloud.request<Partial<CloudDrainResult>>('POST', '/v1/sandboxes/drain', selectorBody(sel));
    return { deleted: r?.deleted ?? 0, ids: r?.ids ?? [], failed: r?.failed ?? [], more: r?.more === true };
  }

  /** Grade a solved sandbox (an id or a `CloudSandbox`) in a sealed copy; see `CloudSandbox.grade`. */
  grade(sandbox: string | CloudSandbox, cmd: string | string[], opts: CloudGradeOptions = {}): Promise<CloudGradeResult> {
    const box = typeof sandbox === 'string' ? new CloudSandbox(this.cloud, { id: sandbox } as CloudSandboxInfo) : sandbox;
    return box.grade(cmd, opts);
  }

  /** The org's sandboxes (one page); with all, deleted ones too. */
  async list(opts: CloudListOptions = {}): Promise<CloudSandbox[]> {
    return (await this.listPage(opts)).sandboxes;
  }

  /**
   * One page of sandboxes and the cursor for the next. Servers without
   * pagination answer everything at once, with no cursor (`nextCursor: null`).
   */
  async listPage(opts: CloudListOptions = {}): Promise<CloudSandboxPage> {
    const r = await this.cloud.request<{ sandboxes?: CloudSandboxInfo[]; next_cursor?: string | null }>(
      'GET', `/v1/sandboxes${listQuery(opts)}`,
    );
    const nextCursor = typeof r.next_cursor === 'string' && r.next_cursor !== '' ? r.next_cursor : null;
    return { sandboxes: (r.sandboxes ?? []).map((s) => new CloudSandbox(this.cloud, s)), nextCursor };
  }

  /**
   * Every sandbox, page by page, following `nextCursor` until there is none.
   * Stops if the server repeats a cursor.
   */
  async *iterate(opts: Omit<CloudListOptions, 'cursor'> = {}): AsyncGenerator<CloudSandbox, void, undefined> {
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (;;) {
      const page = await this.listPage({ ...opts, ...(cursor !== undefined ? { cursor } : {}) });
      yield* page.sandboxes;
      if (page.nextCursor === null || seen.has(page.nextCursor)) return;
      seen.add(page.nextCursor);
      cursor = page.nextCursor;
    }
  }

  async get(id: string): Promise<CloudSandbox> {
    const r = await this.cloud.request<{ sandbox: CloudSandboxInfo }>('GET', `/v1/sandboxes/${encodeURIComponent(id)}`);
    return new CloudSandbox(this.cloud, r.sandbox);
  }
}

function execBody(cmd: string | string[], opts: CloudExecOptions): Json {
  const argv = typeof cmd === 'string' ? ['sh', '-c', cmd] : cmd;
  const body: Json = { cmd: argv };
  if (opts.image !== undefined) body.image = opts.image;
  const env = envList(opts.env);
  if (env) body.env = env;
  if (opts.timeoutS !== undefined) {
    checkInt('timeoutS', opts.timeoutS, 1, 86_400);
    body.timeout_s = opts.timeoutS;
  }
  return body;
}

/** One cloud sandbox. `info` is its state as of the last call. */
export class CloudSandbox {
  constructor(private readonly cloud: Kosa8Cloud, public info: CloudSandboxInfo) {}

  get id(): string {
    return this.info.id;
  }

  /** Its state as of the last call (`info.state`), e.g. `running` right after create. */
  get state(): CloudSandboxInfo['state'] {
    return this.info.state;
  }

  private path(suffix = ''): string {
    return `/v1/sandboxes/${encodeURIComponent(this.info.id)}${suffix}`;
  }

  /** Files in the sandbox. Needs the host's data plane (see `CloudSandboxFiles`). */
  get files(): CloudSandboxFiles {
    return new CloudSandboxFiles(this.cloud, this.path());
  }

  /**
   * Run a command and wait for it. A string runs through `sh -c` (busybox sh
   * on the base template). A sleeping sandbox wakes for it.
   *
   * Commands run in the sandbox's own long-lived container (one naming
   * another `image` runs in a fresh container that shares only `/workspace`).
   * The request body is capped at 64 KiB (413 too_large). A buffered exec
   * runs at most 90 s: past that the Cloud API stops the command and answers
   * 504 `exec_timeout`, raised as `Kosa8ExecTimeoutError`. Run longer
   * commands with `execBackground`, which `stop()` can end.
   */
  async exec(cmd: string | string[], opts: CloudExecOptions = {}): Promise<CloudExecResult> {
    const body = execBody(cmd, opts);
    const r = await this.cloud.request<Parameters<typeof execResult>[0]>('POST', this.path('/exec'), body, { signal: opts.signal });
    return execResult(r);
  }

  /** Snapshot it and free its VM; it then costs only snapshot storage. */
  async sleep(): Promise<this> {
    this.info = (await this.cloud.request<{ sandbox: CloudSandboxInfo }>('POST', this.path('/sleep'))).sandbox;
    return this;
  }

  /** Restore a sleeping sandbox, files and all. */
  async wake(): Promise<this> {
    this.info = (await this.cloud.request<{ sandbox: CloudSandboxInfo }>('POST', this.path('/wake'))).sandbox;
    return this;
  }

  async refresh(): Promise<this> {
    this.info = (await this.cloud.request<{ sandbox: CloudSandboxInfo }>('GET', this.path())).sandbox;
    return this;
  }

  async delete(): Promise<void> {
    await this.cloud.request('DELETE', this.path());
  }

  /**
   * Delete it, treating one that is gone already as done. `await using box =
   * await cloud.sandboxes.create()` calls this when the block ends.
   */
  async dispose(): Promise<void> {
    try {
      await this.delete();
    } catch (e) {
      if (!(e instanceof Kosa8NotFoundError)) throw e;
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.dispose();
  }

  /**
   * Push back its lease to now + `extendS` (default its own `lease_s`).
   * Resolves with 1 when it moved, 0 when it is not leased or has lapsed.
   */
  heartbeat(opts: { extendS?: number } = {}): Promise<number> {
    return this.cloud.sandboxes.heartbeat({ ids: [this.id], ...opts });
  }

  /**
   * Grade its state with hidden tests, in a sealed copy: kosa8 Cloud forks
   * one copy, takes all network away from it, writes `files` there (this
   * sandbox never sees them), runs `cmd` and deletes the copy (unless
   * `keep`). The reward is the last stdout line that is JSON with a numeric
   * `reward` (`{"reward": 0.5, "metrics": {...}}`), else 1.0 on exit 0 and
   * 0.0 otherwise; null with `failureClass` timeout or infra when the
   * command did not finish, so a trainer masks it. With `runId` it is
   * recorded as a rollout of that run.
   */
  async grade(cmd: string | string[], opts: CloudGradeOptions = {}): Promise<CloudGradeResult> {
    const body: Json = { cmd: typeof cmd === 'string' ? ['sh', '-c', cmd] : cmd };
    if (opts.files) {
      const files: Record<string, string> = {};
      for (const [p, v] of Object.entries(opts.files)) {
        if (!p.startsWith('/')) throw new Kosa8Error(`a grader file path must be absolute, got ${p}`);
        files[p] = b64(v);
      }
      if (Object.keys(files).length > 64) throw new Kosa8Error('at most 64 grader files');
      body.files = files;
    }
    if (opts.timeoutS !== undefined) {
      if (!(opts.timeoutS > 0 && opts.timeoutS <= 90)) throw new Kosa8Error('timeoutS must be more than 0 and at most 90');
      body.timeout_s = opts.timeoutS;
    }
    const env = envList(opts.env);
    if (env) body.env = env;
    if (opts.keep) body.keep = true;
    const runId = opts.runId ?? ambient(this.cloud).runId;
    if (runId !== undefined) body.run_id = runId;
    if (opts.rollout) body.rollout = opts.rollout;
    const r = await this.cloud.request<Json>('POST', this.path('/grade'), body, {
      idempotencyKey: opts.idempotencyKey ?? newIdempotencyKey(), signal: opts.signal,
    });
    return gradeResult(r ?? {});
  }

  /** Signed, expiring iframe URLs for its terminal or desktop. */
  get embeds(): CloudEmbeds {
    return new CloudEmbeds(this.cloud, this.path());
  }

  /** Its desktop recordings (made when it is deleted, for a sandbox created with `record: true`). */
  async recordings(): Promise<CloudRecording[]> {
    return (await this.cloud.request<{ recordings?: CloudRecording[] }>('GET', this.path('/recordings'))).recordings ?? [];
  }

  /**
   * Change its lifetime or sleep timer. `{ ttlS: null }` (or
   * `{ deleteAfter: null }`) clears the lifetime. Returns the server's notes,
   * if any; `info` is refreshed.
   */
  async update(opts: CloudUpdateOptions): Promise<{ sandbox: CloudSandboxInfo; notes: string[] }> {
    const body: Json = {};
    if (opts.ttlS !== undefined && opts.deleteAfter !== undefined) {
      throw new Kosa8Error('give ttlS or deleteAfter, not both');
    }
    if (opts.ttlS !== undefined) {
      if (opts.ttlS !== null) checkInt('ttlS', opts.ttlS, MIN_TTL_S, MAX_TTL_S);
      body.ttl_s = opts.ttlS;
    }
    if (opts.deleteAfter !== undefined) body.delete_after = opts.deleteAfter === null ? null : toMs(opts.deleteAfter);
    if (opts.sleepAfterS !== undefined) {
      checkInt('sleepAfterS', opts.sleepAfterS, 0, MAX_SLEEP_AFTER_S);
      body.sleep_after_s = opts.sleepAfterS;
    }
    if (Object.keys(body).length === 0) throw new Kosa8Error('update needs ttlS, deleteAfter or sleepAfterS');
    const r = await this.cloud.request<{ sandbox: CloudSandboxInfo; notes?: string[] }>('PATCH', this.path(), body);
    this.info = r.sandbox;
    return { sandbox: r.sandbox, notes: r.notes ?? [] };
  }

  /**
   * Save memory, processes and disk as a checkpoint (the newest 10 are kept).
   *
   * Needs the host's data plane; on hosts without it the API answers 501
   * (`not_available`/`not_supported`), raised as `Kosa8UnsupportedError`.
   * Not every kosa8 Cloud host has it yet.
   */
  async checkpoint(label?: string): Promise<CloudCheckpoint> {
    if (label !== undefined && label.length > 200) throw new Kosa8Error('a checkpoint label is at most 200 characters');
    const r = await this.cloud.request<{ checkpoint: CloudCheckpoint }>(
      'POST', this.path('/checkpoints'), label !== undefined ? { label } : {},
    );
    return r.checkpoint;
  }

  /**
   * Its checkpoints, oldest first. Does not wake a sleeping sandbox.
   *
   * Needs the host's data plane; on hosts without it the API answers 501
   * (`not_available`/`not_supported`), raised as `Kosa8UnsupportedError`.
   * Not every kosa8 Cloud host has it yet.
   */
  async checkpoints(): Promise<CloudCheckpoint[]> {
    return (await this.cloud.request<{ checkpoints?: CloudCheckpoint[] }>('GET', this.path('/checkpoints'))).checkpoints ?? [];
  }

  /**
   * Go back to a checkpoint (a CloudCheckpoint or its id). The sandbox as it
   * was is saved first, as `backup`. `info` is refreshed.
   *
   * Needs the host's data plane; on hosts without it the API answers 501
   * (`not_available`/`not_supported`), raised as `Kosa8UnsupportedError`.
   * Not every kosa8 Cloud host has it yet.
   */
  async rewind(checkpoint: string | CloudCheckpoint): Promise<CloudRewindResult> {
    const id = typeof checkpoint === 'string' ? checkpoint : checkpoint.id;
    if (!id) throw new Kosa8Error('rewind needs a checkpoint id');
    const r = await this.cloud.request<{ sandbox: CloudSandboxInfo; checkpoint: CloudCheckpoint; backup: CloudCheckpoint; ms?: number | null }>(
      'POST', this.path('/rewind'), { checkpoint_id: id },
    );
    if (r.sandbox) this.info = r.sandbox;
    return { checkpoint: r.checkpoint, backup: r.backup, ms: r.ms ?? null };
  }

  /**
   * Make `n` (1..1000) copies of the sandbox as it is now, on its host. A
   * plain `fork(n)` of at most 100 is all or nothing. Over 100, or with
   * `labels`, `runId`, `leaseS` or `prefix`, it is partial unless
   * `partialOk: false`: the copies made are returned and the rest are in
   * `failed` (failure_class quota or infra). Inside an `rl.Run` the copies
   * are the run's and leased. The answer is an array with `failed`,
   * `requested` and `created`.
   *
   * Needs the host's data plane; on hosts without it the API answers 501
   * (`not_available`/`not_supported`), raised as `Kosa8UnsupportedError`.
   * Not every kosa8 Cloud host has it yet.
   */
  async fork(n?: number | CloudForkOptions, opts: CloudForkOptions = {}): Promise<CloudSandboxBatch> {
    const o: CloudForkOptions = typeof n === 'object' ? n : { ...opts, n: n ?? opts.n };
    const count = o.n ?? 1;
    checkInt('n', count, 1, MAX_FORK);
    const amb = ambient(this.cloud);
    const fan: CloudFanoutOptions = { ...o, runId: o.runId ?? amb.runId, leaseS: o.leaseS ?? amb.leaseS };
    const body: Json = { n: count, ...fanoutBody(fan) };
    const r = await this.cloud.request<{
      sandboxes?: CloudSandboxInfo[]; failed?: CloudFanoutFailure[]; requested?: number; run_id?: string;
    }>('POST', this.path('/fork'), body, { idempotencyKey: o.idempotencyKey ?? newIdempotencyKey() });
    return toBatch((r.sandboxes ?? []).map((s) => new CloudSandbox(this.cloud, s)), r.failed ?? [], r.requested ?? count, r.run_id ?? fan.runId);
  }

  /**
   * TCP ports listening in its running containers.
   *
   * Needs the host's data plane; on hosts without it the API answers 501
   * (`not_available`/`not_supported`), raised as `Kosa8UnsupportedError`.
   * Not every kosa8 Cloud host has it yet.
   */
  async ports(): Promise<CloudPort[]> {
    return (await this.cloud.request<{ ports?: CloudPort[] }>('GET', this.path('/ports'))).ports ?? [];
  }

  /**
   * Poll until a cold-booting sandbox (state `creating`) is running. Raises
   * if it ends in `error` (with its `last_error`) or the time runs out.
   */
  async waitUntilRunning(opts: { timeoutMs?: number; intervalMs?: number } = {}): Promise<this> {
    const limit = opts.timeoutMs ?? 300_000;
    const deadline = Date.now() + limit;
    const every = opts.intervalMs ?? 1000;
    while (!SETTLED.has(this.info.state)) {
      if (Date.now() + every > deadline) {
        throw new Kosa8TimeoutError(`sandbox ${this.id} still ${this.info.state} after ${limit} ms`);
      }
      await sleepFor(every);
      await this.refresh();
    }
    if (this.info.state === 'error') {
      throw new Kosa8Error(`sandbox ${this.id} failed to start: ${this.info.last_error ?? 'no reason given'}`);
    }
    return this;
  }

  /**
   * Start a command that keeps running after this returns (202). Read its
   * state and output with `status()`, or wait for it with `wait()`.
   *
   * ```ts
   * const job = await sbx.execBackground('npm run build');
   * const done = await job.wait();
   * console.log(done.exit, done.output);
   * ```
   */
  async execBackground(cmd: string | string[], opts: CloudExecOptions = {}): Promise<CloudBackgroundExec> {
    const body = execBody(cmd, opts);
    body.background = true;
    const r = await this.cloud.request<{ exec: CloudBackgroundExecInfo }>('POST', this.path('/exec'), body, { signal: opts.signal });
    return new CloudBackgroundExec(this.cloud, this.path(), r.exec);
  }

  /** A background command by id (`bg_…`), e.g. one another process started. */
  async getExec(execId: string): Promise<CloudBackgroundExec> {
    const job = new CloudBackgroundExec(this.cloud, this.path(), {
      id: execId, sandbox_id: this.id, state: 'running', pid: null, exit: null, output_path: null, exit_path: null,
    });
    await job.status();
    return job;
  }

  /**
   * Save it as a durable snapshot (memory, processes and disk), kept until
   * deleted whatever happens to the sandbox. Start copies with
   * `cloud.sandboxes.create({ snapshot })`.
   */
  async snapshot(name?: string): Promise<CloudSnapshot> {
    const r = await this.cloud.request<{ snapshot: CloudSnapshot }>(
      'POST', this.path('/snapshots'), name !== undefined ? { name } : {},
    );
    return r.snapshot;
  }

  /** Its ports at https URLs: `await sbx.previews.create(3000)`. */
  get previews(): CloudPreviews {
    return new CloudPreviews(this.cloud, this.path());
  }

  /** Commands it runs on a cron schedule. */
  get schedules(): CloudSchedules {
    return new CloudSchedules(this.cloud, this.path());
  }

  /** Its code-interpreter contexts. */
  get codeContexts(): CloudCodeContexts {
    return new CloudCodeContexts(this.cloud, this.path());
  }

  /**
   * Run a Python cell in a stateful context (globals persist between calls);
   * charts come back as `image/png` results.
   */
  runCode(code: string, opts: CloudCodeOptions = {}): Promise<CloudCodeRun> {
    const body: Json = { code };
    if (opts.context !== undefined) body.context = opts.context;
    if (opts.language !== undefined) body.language = opts.language;
    if (opts.timeoutS !== undefined) body.timeout_s = opts.timeoutS;
    return this.cloud.request('POST', this.path('/code'), body);
  }

  /** A wss:// URL for an interactive terminal (PTY); open it with any WebSocket client. */
  async terminal(opts: { cols?: number; rows?: number; command?: string[] } = {}): Promise<CloudTerminal> {
    return (await this.cloud.request<{ terminal: CloudTerminal }>('POST', this.path('/terminal'), opts)).terminal;
  }

  /** The egress policy it runs with. */
  async egress(): Promise<CloudEgress> {
    return (await this.cloud.request<{ egress: CloudEgress }>('GET', this.path('/egress'))).egress;
  }

  /** Change what it may reach, at once (a sleeping sandbox when it wakes). */
  async setEgress(policy: CloudEgressPolicy): Promise<CloudEgress> {
    return (await this.cloud.request<{ egress: CloudEgress }>('PUT', this.path('/egress'), policy)).egress;
  }

  /** Back to the organization's default egress policy. */
  async resetEgress(): Promise<CloudEgress> {
    return (await this.cloud.request<{ egress: CloudEgress }>('DELETE', this.path('/egress'))).egress;
  }

  /** Names of the org secrets it holds (never values). */
  async secrets(): Promise<string[]> {
    return (await this.cloud.request<{ secrets?: string[] }>('GET', this.path('/secrets'))).secrets ?? [];
  }

  /** Replace its labels (up to 16); `{}` clears them. */
  async setLabels(labels: Record<string, string>): Promise<Record<string, string>> {
    const r = await this.cloud.request<{ labels: Record<string, string> }>('PUT', this.path('/labels'), { labels });
    this.info = { ...this.info, labels: r.labels };
    return r.labels;
  }

  /** CPU, memory, disk and network use, read on the host. */
  async metrics(): Promise<CloudMetrics> {
    return (await this.cloud.request<{ metrics: CloudMetrics }>('GET', this.path('/metrics'))).metrics;
  }

  /** Its last commands, with exit codes and output tails. */
  async logs(opts: { limit?: number } = {}): Promise<CloudLogEntry[]> {
    const q = opts.limit !== undefined ? `?limit=${opts.limit}` : '';
    return (await this.cloud.request<{ entries?: CloudLogEntry[] }>('GET', this.path(`/logs${q}`))).entries ?? [];
  }
}

/**
 * Files in a cloud sandbox, up to 8 MiB each. A sleeping sandbox wakes first.
 *
 * Needs the host's data plane; on hosts without it the API answers 501
 * (`not_available`/`not_supported`), raised as `Kosa8UnsupportedError`. Not
 * every kosa8 Cloud host has it yet.
 */
export class CloudSandboxFiles {
  constructor(private readonly cloud: Kosa8Cloud, private readonly base: string) {}

  private q(suffix: string, path: string, extra = ''): string {
    return `${this.base}${suffix}?path=${encodeURIComponent(path)}${extra}`;
  }

  /** A file's bytes. */
  read(path: string): Promise<Uint8Array> {
    return this.cloud.requestBytes('GET', this.q('/files', path));
  }

  /** A file as UTF-8 text. */
  async readText(path: string): Promise<string> {
    return new TextDecoder().decode(await this.read(path));
  }

  /** Write a file (a string is written as UTF-8). Its parent folder must exist. */
  async write(path: string, data: string | Uint8Array): Promise<CloudFileInfo> {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    const out = await this.cloud.requestBytes('PUT', this.q('/files', path), bytes);
    const r = JSON.parse(new TextDecoder().decode(out) || '{}') as { file?: CloudFileInfo | null };
    return r.file ?? { path };
  }

  /** A folder's entries (default /workspace). */
  async list(path = '/workspace'): Promise<CloudFileInfo[]> {
    return (await this.cloud.request<{ files?: CloudFileInfo[] }>('GET', this.q('/files/list', path))).files ?? [];
  }

  /** Make a folder and its parents. */
  async mkdir(path: string): Promise<CloudFileInfo> {
    const r = await this.cloud.request<{ file?: CloudFileInfo | null }>('POST', `${this.base}/files/mkdir`, { path });
    return r.file ?? { path, type: 'dir' };
  }

  /** A file's bytes with no 8 MiB cap (the streamed endpoint). */
  readRaw(path: string): Promise<Uint8Array> {
    return this.cloud.requestBytes('GET', this.q('/files/raw', path));
  }

  /** Write a file with no 8 MiB cap (the streamed endpoint). */
  async writeRaw(path: string, data: string | Uint8Array): Promise<CloudFileInfo> {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    const out = await this.cloud.requestBytes('PUT', this.q('/files/raw', path), bytes);
    let r: { file?: CloudFileInfo | null } = {};
    try {
      r = JSON.parse(new TextDecoder().decode(out) || '{}');
    } catch {
      // not JSON
    }
    return r.file ?? { path };
  }

  /**
   * A presigned URL for one download (GET, the default) or upload (PUT) of
   * `path`, straight to the host: hand it to curl or a browser for big
   * files. `ttlS` is 10..300 s.
   */
  async link(path: string, opts: { method?: 'GET' | 'PUT'; ttlS?: number } = {}): Promise<CloudFileLink> {
    const body: Json = { path };
    if (opts.method !== undefined) body.method = opts.method;
    if (opts.ttlS !== undefined) {
      checkInt('ttlS', opts.ttlS, 10, 300);
      body.ttl_s = opts.ttlS;
    }
    return (await this.cloud.request<{ link: CloudFileLink }>('POST', `${this.base}/files/link`, body)).link;
  }

  /** Remove a file, or a folder and everything in it with `recursive`. Resolves with the removed path. */
  async delete(path: string, opts: { recursive?: boolean } = {}): Promise<string> {
    const r = await this.cloud.request<{ removed?: string }>('DELETE', this.q('/files', path, opts.recursive ? '&recursive=1' : ''));
    return r.removed ?? path;
  }
}

export class CloudFunctions {
  constructor(private readonly cloud: Kosa8Cloud) {}

  /** Deploy (create or replace) a function; every deploy bumps its version. */
  deploy(name: string, spec: CloudFunctionSpec): Promise<Json> {
    return this.cloud.request('PUT', `/v1/functions/${encodeURIComponent(name)}`, spec);
  }

  async list(): Promise<Json[]> {
    return (await this.cloud.request<{ functions: Json[] }>('GET', '/v1/functions')).functions;
  }

  get(name: string): Promise<Json> {
    return this.cloud.request('GET', `/v1/functions/${encodeURIComponent(name)}`);
  }

  async delete(name: string): Promise<void> {
    await this.cloud.request('DELETE', `/v1/functions/${encodeURIComponent(name)}`);
  }

  /** Call it once. A handler that raises resolves with ok: false, not a throw. */
  invoke<T = unknown>(name: string, event: unknown = null): Promise<CloudInvokeResult<T>> {
    return this.cloud.request('POST', `/v1/functions/${encodeURIComponent(name)}/invoke`, { event });
  }

  /** One call per event, results in input order. */
  map<T = unknown>(name: string, events: unknown[], opts: { concurrency?: number } = {}): Promise<{
    function: string; version: number; count: number; succeeded: number; failed: number; total_ms: number;
    results: CloudInvokeResult<T>[];
  }> {
    const body: Json = { events };
    if (opts.concurrency !== undefined) body.concurrency = opts.concurrency;
    return this.cloud.request('POST', `/v1/functions/${encodeURIComponent(name)}/map`, body);
  }
}

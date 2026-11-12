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
  Kosa8TimeoutError,
  errorFromResponse,
} from './errors.js';

export const DEFAULT_CLOUD_URL = 'https://api.kosa8.com';
export const CLOUD_KEY_PREFIX = 'k8c_live_';

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
}

/** Shortest and longest lifetime `ttlS` accepts, in seconds (1 minute to 90 days). */
export const MIN_TTL_S = 60;
export const MAX_TTL_S = 7_776_000;
/** Longest idle time before sleep `sleepAfterS` accepts, in seconds (7 days). */
export const MAX_SLEEP_AFTER_S = 604_800;
/** Most copies one fork makes. */
export const MAX_FORK_N = 100;

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
}

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
  /** Environment variables for the command. */
  env?: Record<string, string>;
}

export interface CloudExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** Set when the sandbox was asleep and woke for this command. */
  wokeMs?: number;
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
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: Kosa8CloudOptions = {}) {
    const env = options.env ?? (typeof process !== 'undefined' ? process.env : {});
    const key = (options.apiKey ?? env.KOSA8_API_KEY ?? '').trim();
    if (!key) throw new Kosa8Error('no kosa8 Cloud API key: pass apiKey or set KOSA8_API_KEY');
    if (!key.startsWith(CLOUD_KEY_PREFIX)) throw new Kosa8Error(`a kosa8 Cloud API key starts with ${CLOUD_KEY_PREFIX}`);
    this.apiKey = key;
    this.baseUrl = checkBase(options.baseUrl ?? env.KOSA8_CLOUD_URL ?? DEFAULT_CLOUD_URL);
    const f = options.fetch ?? globalThis.fetch;
    if (typeof f !== 'function') throw new Kosa8Error('no fetch available; pass options.fetch');
    this.fetchImpl = f;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.sandboxes = new CloudSandboxes(this);
    this.functions = new CloudFunctions(this);
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

  /** @internal */
  async request<T = Json>(method: string, path: string, body?: unknown): Promise<T> {
    const resp = await this.send(method, path, body !== undefined ? { json: body } : {}, 'application/json');
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

  /** @internal Raw bytes in and/or out (the files endpoints). */
  async requestBytes(method: string, path: string, bytes?: Uint8Array): Promise<Uint8Array> {
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

  private async send(method: string, path: string, raw: RawOptions, accept: string): Promise<Response> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    const headers: Record<string, string> = { Authorization: `Bearer ${this.apiKey}`, Accept: accept };
    let body: BodyInit | undefined;
    if (raw.bytes !== undefined) {
      headers['Content-Type'] = 'application/octet-stream';
      body = raw.bytes as unknown as BodyInit;
    } else if (raw.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(raw.json);
    }
    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, { method, headers, body, signal: ctl.signal });
    } catch (e) {
      if (ctl.signal.aborted) {
        throw new Kosa8TimeoutError(`kosa8 Cloud did not answer within ${this.timeoutMs} ms`, { method, path, cause: e });
      }
      throw new Kosa8ConnectionError(`could not reach kosa8 Cloud at ${this.baseUrl}: ${String((e as Error)?.message ?? e)}`, { method, path, cause: e });
    } finally {
      clearTimeout(timer);
    }
  }
}

const EXEC_LIMIT_HINT =
  'a buffered kosa8 Cloud exec is cut off after about 30 s; run long jobs in the background ' +
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
  if (execTimeout) {
    const base = message ?? `request failed with HTTP ${status}`;
    return new Kosa8ExecTimeoutError(`${base} (${EXEC_LIMIT_HINT})`, {
      status, daemonMessage: message, body, code, ...ctx,
    });
  }
  const retryAfter = status === 429 ? parseRetryAfter(resp.headers?.get?.('Retry-After') ?? null) : undefined;
  return errorFromResponse(status, message !== undefined ? { error: message } : body, {
    ...ctx, code, body, ...(retryAfter !== undefined ? { retryAfter } : {}),
  });
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
  if (opts.acceptPrice !== undefined) body.accept_price = opts.acceptPrice;
  return body;
}

function listQuery(opts: CloudListOptions): string {
  const q = new URLSearchParams();
  if (opts.all) q.set('all', '1');
  if (opts.limit !== undefined) q.set('limit', String(opts.limit));
  if (opts.cursor !== undefined && opts.cursor !== '') q.set('cursor', opts.cursor);
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
    const body = createBody(opts);
    const r = await this.cloud.request<{ sandbox: CloudSandboxInfo }>('POST', '/v1/sandboxes', body);
    return new CloudSandbox(this.cloud, r.sandbox);
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

/** One cloud sandbox. `info` is its state as of the last call. */
export class CloudSandbox {
  constructor(private readonly cloud: Kosa8Cloud, public info: CloudSandboxInfo) {}

  get id(): string {
    return this.info.id;
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
   * Each exec runs in a fresh container; only `/workspace` persists between
   * calls. The request body is capped at 64 KiB (413 too_large). A buffered
   * exec is cut off after about 30 s by the Cloud API today, raised as
   * `Kosa8ExecTimeoutError`; run long jobs in the background
   * (`nohup cmd > /workspace/out.log 2>&1 &`) and poll.
   */
  async exec(cmd: string | string[], opts: CloudExecOptions = {}): Promise<CloudExecResult> {
    const argv = typeof cmd === 'string' ? ['sh', '-c', cmd] : cmd;
    const body: Json = { cmd: argv };
    if (opts.image !== undefined) body.image = opts.image;
    if (opts.env) body.env = Object.entries(opts.env).map(([k, v]) => `${k}=${v}`);
    const r = await this.cloud.request<{ exit: number | null; stdout: string; stderr: string; woke_ms?: number }>(
      'POST', this.path('/exec'), body,
    );
    const out: CloudExecResult = { exitCode: r.exit, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    if (typeof r.woke_ms === 'number') out.wokeMs = r.woke_ms;
    return out;
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
   * Make `n` (1..100) copies of the sandbox as it is now, on its host; all
   * or nothing.
   *
   * Needs the host's data plane; on hosts without it the API answers 501
   * (`not_available`/`not_supported`), raised as `Kosa8UnsupportedError`.
   * Not every kosa8 Cloud host has it yet.
   */
  async fork(n = 1): Promise<CloudSandbox[]> {
    checkInt('n', n, 1, MAX_FORK_N);
    const r = await this.cloud.request<{ sandboxes?: CloudSandboxInfo[] }>('POST', this.path('/fork'), { n });
    return (r.sandboxes ?? []).map((s) => new CloudSandbox(this.cloud, s));
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

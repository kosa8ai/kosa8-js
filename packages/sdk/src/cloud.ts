// Copyright (c) 2026 kosa8. Licensed under the MIT License; see LICENSE.

/**
 * kosa8 Cloud: the same sandboxes, run on kosa8's hosts (or your own, with
 * bring-your-own-cloud) instead of the local daemon.
 *
 * ```ts
 * import { Kosa8Cloud } from '@kosa8/sdk';
 *
 * const cloud = new Kosa8Cloud(); // KOSA8_API_KEY from the environment
 * const sbx = await cloud.sandboxes.create({ template: 'python' });
 * const r = await sbx.exec(['python3', '-c', 'print(6 * 7)']);
 * console.log(r.stdout); // "42\n"
 * await sbx.delete();
 * ```
 *
 * Authentication is an API key (`k8c_live_…`) made in the cloud dashboard.
 * Errors are the SDK's usual typed errors; each carries the cloud's stable
 * `code` (for example `payment_required`, `quota_exceeded`).
 */

import { Kosa8ConnectionError, Kosa8Error, Kosa8TimeoutError, errorFromResponse } from './errors.js';

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

export interface CloudSandboxInfo {
  id: string;
  state: 'creating' | 'running' | 'sleeping' | 'stopped' | 'deleted' | 'error' | string;
  template: string;
  cpus: number;
  mem_mb: number;
  source: 'pool' | 'restore' | 'cold' | null;
  region: string | null;
  own_host: boolean;
  created_at: number;
  started_at: number | null;
  stopped_at: number | null;
  deleted_at: number | null;
  last_error: string | null;
  running_s: number;
  asleep_s: number;
  sleep_bytes: number;
  cost_usd: number;
}

export interface CloudCreateOptions {
  /** Template key, such as base, python or node. Defaults to the org's setting. */
  template?: string;
  /** Region id, such as eu-hel1. Defaults to the org's setting (any region). */
  region?: string;
  /** Idle seconds before the sandbox sleeps; 0 never. Defaults to the org's setting. */
  sleepAfterS?: number;
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

  /** @internal */
  async request<T = Json>(method: string, path: string, body?: unknown): Promise<T> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    let resp: Response;
    try {
      resp = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctl.signal,
      });
    } catch (e) {
      if (ctl.signal.aborted) {
        throw new Kosa8TimeoutError(`kosa8 Cloud did not answer within ${this.timeoutMs} ms`, { method, path, cause: e });
      }
      throw new Kosa8ConnectionError(`could not reach kosa8 Cloud at ${this.baseUrl}: ${String((e as Error)?.message ?? e)}`, { method, path, cause: e });
    } finally {
      clearTimeout(timer);
    }
    const text = await resp.text();
    let data: unknown = text;
    try {
      data = text === '' ? null : JSON.parse(text);
    } catch {
      // not JSON; kept as text
    }
    if (!resp.ok) throw cloudError(resp.status, data, { method, path });
    return data as T;
  }
}

/**
 * The cloud answers {error: code, message}. The SDK's errors read the
 * sentence as their message and keep the code.
 */
function cloudError(status: number, body: unknown, ctx: { method: string; path: string }): Kosa8Error {
  let code: string | undefined;
  let msgBody: unknown = body;
  if (typeof body === 'object' && body !== null) {
    const b = body as Json;
    if (typeof b.error === 'string') code = b.error;
    msgBody = { error: typeof b.message === 'string' && b.message ? b.message : b.error };
  }
  return errorFromResponse(status, msgBody, { ...ctx, code });
}

export class CloudSandboxes {
  constructor(private readonly cloud: Kosa8Cloud) {}

  /** Start a sandbox; resolves once it is running. */
  async create(opts: CloudCreateOptions = {}): Promise<CloudSandbox> {
    const body: Json = {};
    if (opts.template !== undefined) body.template = opts.template;
    if (opts.region !== undefined) body.region = opts.region;
    if (opts.sleepAfterS !== undefined) body.sleep_after_s = opts.sleepAfterS;
    const r = await this.cloud.request<{ sandbox: CloudSandboxInfo }>('POST', '/v1/sandboxes', body);
    return new CloudSandbox(this.cloud, r.sandbox);
  }

  /** The org's sandboxes; with all, deleted ones too. */
  async list(opts: { all?: boolean } = {}): Promise<CloudSandbox[]> {
    const r = await this.cloud.request<{ sandboxes: CloudSandboxInfo[] }>('GET', `/v1/sandboxes${opts.all ? '?all=1' : ''}`);
    return r.sandboxes.map((s) => new CloudSandbox(this.cloud, s));
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

  /**
   * Run a command and wait for it. A string runs through `sh -c`. A
   * sleeping sandbox wakes for it.
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

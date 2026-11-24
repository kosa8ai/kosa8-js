// Copyright (c) 2026 kosa8. Licensed under the MIT License; see LICENSE.

/**
 * Serverless runs: `POST /v1/run` runs code or a command in a fresh sandbox
 * in one call (output, exit code and files back; the sandbox is deleted),
 * and `/v1/runs` lists what ran (kept 30 days).
 */

import { Kosa8Error } from './errors.js';

type Json = Record<string, unknown>;

/** @internal What runs need from `Kosa8Cloud`. */
export interface RunRequester {
  request<T = Json>(method: string, path: string, body?: unknown, opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<T>;
}

/** The longest `timeoutS` a run takes (the API's RUN_MAX_TIMEOUT_S). */
export const MAX_RUN_TIMEOUT_S = 3600;

/** `cloud.run(opts)`: give `code`, `command`, or both. */
export interface CloudRunOptions {
  /** Source to run; written to `filename` (main.<ext>) in /workspace. */
  code?: string;
  /** A shell string or argv; with `code`, runs instead of the language's own command. */
  command?: string | string[];
  /** python, node, typescript, bash or sh (and aliases). Default: from `filename`, else python. */
  language?: string;
  filename?: string;
  /** Default: the language's (python, node, base). */
  template?: string;
  /** `{ path: text }`, or `[{ path, content, encoding: 'utf8' | 'base64' }]`; paths are under /workspace. */
  files?: Record<string, string> | Array<{ path: string; content: string; encoding?: 'utf8' | 'base64' }>;
  env?: Record<string, string>;
  /** A sandbox size such as '2x4'. */
  size?: string;
  /** 1..3600, default 60. The call waits that long plus a minute. */
  timeoutS?: number;
  /** Files to send back, base64, 4 MiB together (at most 16). */
  outputs?: string[];
  /** true: a public read-only run card. `{ public, code }` also shows the code. */
  share?: boolean | { public?: boolean; code?: boolean };
  signal?: AbortSignal;
}

/** A file a run sent back. */
export interface CloudRunFile {
  path: string;
  bytes?: number;
  /** The file, base64; absent with `error`. */
  content_base64?: string;
  /** not_found, too_large, ... */
  error?: string;
  hint?: string;
  [key: string]: unknown;
}

/** One serverless run, as the API answers it. */
export interface CloudRun {
  id: string;
  /** ok (exit 0), failed (exit non-zero), timeout or error. */
  status: 'ok' | 'failed' | 'timeout' | 'error' | 'running' | string;
  exit: number | null;
  stdout?: string;
  stderr?: string;
  stdout_truncated?: boolean;
  stderr_truncated?: boolean;
  files?: CloudRunFile[];
  duration_ms?: number;
  cost_usd?: number;
  language?: string;
  template?: string;
  sandbox_id?: string | null;
  view_url?: string;
  error?: string | null;
  hint?: string;
  [key: string]: unknown;
}

/** A run's output file decoded to bytes. */
export function runFileBytes(f: CloudRunFile): Uint8Array {
  if (typeof f.content_base64 !== 'string') {
    throw new Kosa8Error(`the run did not send back ${f.path}${f.error ? `: ${f.error}` : ''}`, { code: f.error ?? 'not_found' });
  }
  const bin = atob(f.content_base64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** The JSON body of `POST /v1/run`, checked. */
export function runBody(opts: CloudRunOptions): Json {
  if (opts.code === undefined && opts.command === undefined) throw new Kosa8Error('a run needs code or command');
  const body: Json = {};
  if (opts.code !== undefined) body.code = opts.code;
  if (opts.command !== undefined) body.command = opts.command;
  if (opts.language !== undefined) body.language = opts.language;
  if (opts.filename !== undefined) body.filename = opts.filename;
  if (opts.template !== undefined) body.template = opts.template;
  if (opts.files !== undefined) body.files = opts.files;
  if (opts.env !== undefined) body.env = opts.env;
  if (opts.size !== undefined) body.size = opts.size;
  if (opts.timeoutS !== undefined) {
    if (!Number.isInteger(opts.timeoutS) || opts.timeoutS < 1 || opts.timeoutS > MAX_RUN_TIMEOUT_S) {
      throw new Kosa8Error(`timeoutS must be a whole number from 1 to ${MAX_RUN_TIMEOUT_S}, got ${opts.timeoutS}`);
    }
    body.timeout_s = opts.timeoutS;
  }
  if (opts.outputs !== undefined) body.outputs = opts.outputs;
  if (opts.share !== undefined) body.share = opts.share;
  return body;
}

/** Run one thing in a fresh sandbox and wait for it. A command that exits non-zero resolves with status failed. */
export async function runOnce(cloud: RunRequester, opts: CloudRunOptions, clientTimeoutMs: number): Promise<CloudRun> {
  const body = runBody(opts);
  const waitMs = Math.max(clientTimeoutMs, ((opts.timeoutS ?? 60) + 60) * 1000);
  const r = await cloud.request<{ run: CloudRun }>('POST', '/v1/run', body, { timeoutMs: waitMs, signal: opts.signal });
  return r.run;
}

/** The org's recent serverless runs (`/v1/runs`, kept 30 days). */
export class CloudRuns {
  constructor(private readonly cloud: RunRequester) {}

  /** Newest first, without output (up to 100). */
  async list(opts: { limit?: number } = {}): Promise<CloudRun[]> {
    const q = opts.limit !== undefined ? `?limit=${encodeURIComponent(String(opts.limit))}` : '';
    return (await this.cloud.request<{ runs?: CloudRun[] }>('GET', `/v1/runs${q}`)).runs ?? [];
  }

  /** One run, with the saved tail of its output. */
  async get(id: string): Promise<CloudRun> {
    return (await this.cloud.request<{ run: CloudRun }>('GET', `/v1/runs/${encodeURIComponent(id)}`)).run;
  }

  /** Publish (or unpublish) its read-only card; `code` also shows the code. */
  async share(id: string, opts: { public: boolean; code?: boolean }): Promise<CloudRun> {
    const body: Json = { public: opts.public };
    if (opts.code !== undefined) body.code = opts.code;
    return (await this.cloud.request<{ run: CloudRun }>('POST', `/v1/runs/${encodeURIComponent(id)}/share`, body)).run;
  }
}

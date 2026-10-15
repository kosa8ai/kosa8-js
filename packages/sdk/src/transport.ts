import * as http from 'node:http';
import * as https from 'node:https';
import * as os from 'node:os';
import * as path from 'node:path';
import { Kosa8ConnectionError, Kosa8Error, errorFromResponse } from './errors.js';
import type { Frame } from './types.js';

/** Who the audit log should file a request under (pkg/policyd Actor). */
export type Actor = 'human' | 'agent' | 'tool';

export interface TransportOptions {
  /**
   * Unix socket of the daemon. Default: `$HOME/.kosa8/run/kosa8.sock`.
   * Ignored when `host` (or KOSA8_HOST) is set.
   */
  socketPath?: string;
  /**
   * A remote kosa8 worker: `https://host`, `http://host:port`, `tcp://host:port`
   * or a bare `host:port`, the same spellings the kosa8 CLI accepts in
   * KOSA8_HOST. `unix:///path/to.sock` selects a socket. Defaults to the
   * KOSA8_HOST environment variable.
   */
  host?: string;
  /** Bearer token for a remote worker. Defaults to KOSA8_TOKEN when KOSA8_HOST is in use. */
  token?: string;
  /**
   * Allow plain http to a non-loopback host. Off by default, as in the CLI,
   * because the token and every request would cross the network unencrypted.
   * KOSA8_INSECURE=1 also allows it.
   */
  insecure?: boolean;
  /** Sent as X-Kosa8-Actor so the audit log files requests correctly. Default `tool`. */
  actor?: Actor;
  /** Agent identity token (X-Kosa8-Agent-Token). Defaults to KOSA8_AGENT_TOKEN. */
  agentToken?: string;
  /** Extra headers on every request. */
  headers?: Record<string, string>;
  /** Environment to read KOSA8_* variables from. Default `process.env`. */
  env?: Record<string, string | undefined>;
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** A raw (non-JSON) request body, sent as-is; an async iterable is streamed chunked. */
  rawBody?: Uint8Array | string | AsyncIterable<Uint8Array | string>;
  /** Signed-approval id, sent as X-Kosa8-Approval. */
  approval?: string;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

type Endpoint =
  | { kind: 'unix'; socketPath: string }
  | { kind: 'tcp'; url: URL; token?: string };

export const APPROVAL_HEADER = 'X-Kosa8-Approval';
export const ACTOR_HEADER = 'X-Kosa8-Actor';
export const AGENT_TOKEN_HEADER = 'X-Kosa8-Agent-Token';

/** The daemon's default socket: $HOME/.kosa8/run/kosa8.sock (pkg/paths). */
export function defaultSocketPath(): string {
  return path.join(os.homedir(), '.kosa8', 'run', 'kosa8.sock');
}

function isLoopback(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || /^127\./.test(h);
}

/** Resolve where to connect, following the CLI's KOSA8_HOST rules. */
export function resolveEndpoint(opts: TransportOptions): Endpoint {
  const env = opts.env ?? process.env;
  const fromEnv = (env.KOSA8_HOST ?? '').trim();
  const raw = (opts.host ?? fromEnv).trim().replace(/\/+$/, '');
  if (raw === '') {
    return { kind: 'unix', socketPath: opts.socketPath ?? defaultSocketPath() };
  }
  let h = raw;
  const i = h.indexOf('://');
  if (i > 0) h = h.slice(0, i).toLowerCase() + h.slice(i);
  if (h.startsWith('unix://')) {
    return { kind: 'unix', socketPath: h.slice('unix://'.length) };
  }
  if (h.startsWith('tcp://')) h = 'http://' + h.slice('tcp://'.length);
  else if (!h.startsWith('http://') && !h.startsWith('https://')) {
    if (h.includes('://')) {
      throw new Kosa8Error(
        `KOSA8_HOST scheme "${h.slice(0, h.indexOf('://'))}" is not supported; use http://, https://, tcp:// or unix://`,
      );
    }
    h = 'http://' + h;
  }
  const url = new URL(h);
  const insecure = opts.insecure === true || env.KOSA8_INSECURE === '1';
  if (url.protocol === 'http:' && !insecure && !isLoopback(url.hostname)) {
    throw new Kosa8Error(
      `refusing to talk to ${url.host} over plain http: the token and every request would cross the network unencrypted. ` +
        `Use https://${url.host} (a worker behind a TLS-terminating tunnel or proxy), or set insecure: true / KOSA8_INSECURE=1 if this link is already private and trusted`,
    );
  }
  const token = opts.token ?? (opts.host === undefined && fromEnv !== '' ? env.KOSA8_TOKEN : undefined);
  return { kind: 'tcp', url, token: token || undefined };
}

export interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  stream: http.IncomingMessage;
}

/** HTTP over the daemon's unix socket (or a remote worker). No dependencies. */
export class Transport {
  private readonly endpoint: Endpoint;
  private readonly actor: Actor;
  private readonly agentToken?: string;
  private readonly extraHeaders: Record<string, string>;

  constructor(opts: TransportOptions = {}) {
    this.endpoint = resolveEndpoint(opts);
    this.actor = opts.actor ?? 'tool';
    const env = opts.env ?? process.env;
    this.agentToken = opts.agentToken ?? (env.KOSA8_AGENT_TOKEN || undefined);
    this.extraHeaders = { ...(opts.headers ?? {}) };
  }

  /** Human-readable description of where requests go. */
  get target(): string {
    return this.endpoint.kind === 'unix' ? `unix://${this.endpoint.socketPath}` : this.endpoint.url.origin;
  }

  private buildPath(p: string, query?: RequestOptions['query']): string {
    const base = this.endpoint.kind === 'tcp' ? this.endpoint.url.pathname.replace(/\/+$/, '') : '';
    let out = base + p;
    if (query) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === false) continue;
        qs.set(k, v === true ? '1' : String(v));
      }
      const s = qs.toString();
      if (s) out += '?' + s;
    }
    return out;
  }

  /** Send a request and return the raw response once headers arrive. */
  raw(method: string, p: string, opts: RequestOptions = {}): Promise<RawResponse> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      [ACTOR_HEADER]: this.actor,
      ...this.extraHeaders,
      ...(opts.headers ?? {}),
    };
    if (opts.approval && opts.approval.trim() !== '') headers[APPROVAL_HEADER] = opts.approval.trim();
    if (this.agentToken) headers[AGENT_TOKEN_HEADER] = this.agentToken;
    let payload: Buffer | undefined;
    let streamBody: AsyncIterable<Uint8Array | string> | undefined;
    if (opts.rawBody !== undefined) {
      headers['Content-Type'] = 'application/octet-stream';
      if (typeof opts.rawBody === 'string' || opts.rawBody instanceof Uint8Array) {
        payload = Buffer.from(opts.rawBody as Uint8Array);
        headers['Content-Length'] = String(payload.length);
      } else {
        streamBody = opts.rawBody;
      }
    } else if (opts.body !== undefined) {
      payload = Buffer.from(JSON.stringify(opts.body));
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(payload.length);
    } else if (method !== 'GET' && method !== 'HEAD') {
      headers['Content-Length'] = '0';
    }
    const reqPath = this.buildPath(p, opts.query);
    let reqOpts: http.RequestOptions;
    let mod: typeof http | typeof https = http;
    if (this.endpoint.kind === 'unix') {
      reqOpts = { socketPath: this.endpoint.socketPath, path: reqPath, method, headers: { Host: 'kosa8', ...headers } };
    } else {
      const u = this.endpoint.url;
      if (this.endpoint.token) headers.Authorization = `Bearer ${this.endpoint.token}`;
      mod = u.protocol === 'https:' ? https : http;
      reqOpts = { protocol: u.protocol, hostname: u.hostname, port: u.port || undefined, path: reqPath, method, headers };
    }

    return new Promise<RawResponse>((resolve, reject) => {
      const signal = opts.signal;
      if (signal?.aborted) {
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
        return;
      }
      const req = mod.request(reqOpts, (res) => {
        resolve({ status: res.statusCode ?? 0, headers: res.headers, stream: res });
      });
      const onAbort = () => {
        req.destroy(signal?.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      req.on('close', () => signal?.removeEventListener('abort', onAbort));
      req.on('error', (err: NodeJS.ErrnoException) => {
        if (signal?.aborted) {
          reject(signal.reason ?? err);
          return;
        }
        reject(
          new Kosa8ConnectionError(
            `kosa8 daemon unreachable at ${this.target}: ${err.message}` +
              (err.code === 'ENOENT' || err.code === 'ECONNREFUSED'
                ? ' (is kosa8 installed and its daemon running? start it with `kosa8 daemon start`)'
                : ''),
            { method, path: p, cause: err },
          ),
        );
      });
      if (streamBody) {
        const src = streamBody;
        void (async () => {
          try {
            for await (const chunk of src) {
              if (!req.write(chunk)) await new Promise((r) => req.once('drain', r));
            }
            req.end();
          } catch (err) {
            req.destroy(err as Error);
          }
        })();
        return;
      }
      if (payload) req.write(payload);
      req.end();
    });
  }

  /** Send a request and decode a JSON answer; HTTP errors become typed errors. */
  async json<T>(method: string, p: string, opts: RequestOptions = {}): Promise<T> {
    const res = await this.raw(method, p, opts);
    const text = (await readAll(res.stream, opts.signal)).toString('utf8');
    let body: unknown = undefined;
    if (text.trim() !== '') {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    if (res.status >= 400) throw errorFromResponse(res.status, body, { method, path: p });
    return body as T;
  }

  /**
   * Send a request whose answer is a stream of NDJSON frames (run, exec,
   * attach). HTTP errors (a refusal before streaming began) become typed
   * errors; each frame's base64 `data` is decoded to a Buffer.
   */
  async *frames(method: string, p: string, opts: RequestOptions = {}): AsyncGenerator<Frame> {
    const res = await this.raw(method, p, opts);
    if (res.status >= 400) {
      const text = (await readAll(res.stream, opts.signal)).toString('utf8');
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {
        /* keep text */
      }
      throw errorFromResponse(res.status, body, { method, path: p });
    }
    let buf = '';
    try {
      for await (const chunk of res.stream) {
        buf += (chunk as Buffer).toString('utf8');
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line !== '') yield decodeFrame(line);
        }
      }
    } catch (err) {
      if (opts.signal?.aborted) throw opts.signal.reason ?? err;
      throw err;
    } finally {
      res.stream.destroy();
    }
    const rest = buf.trim();
    if (rest !== '') yield decodeFrame(rest);
  }
}

function decodeFrame(line: string): Frame {
  const f = JSON.parse(line) as Record<string, unknown>;
  const out: Frame = { ...f } as Frame;
  if (typeof f.data === 'string') out.data = Buffer.from(f.data, 'base64');
  return out;
}

async function readAll(stream: http.IncomingMessage, signal?: AbortSignal): Promise<Buffer> {
  const chunks: Buffer[] = [];
  try {
    for await (const c of stream) chunks.push(c as Buffer);
  } catch (err) {
    if (signal?.aborted) throw signal.reason ?? err;
    throw err;
  }
  return Buffer.concat(chunks);
}

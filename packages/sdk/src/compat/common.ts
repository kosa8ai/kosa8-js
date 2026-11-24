// Copyright (c) 2026 kosa8. Licensed under the MIT License; see LICENSE.

/**
 * What the Daytona, Modal and Vercel Sandbox shims share: the key, the
 * cloud, `Unsupported`, paths under /workspace, and a create that asks for a
 * persistent sandbox (one long-lived container, like the VMs those SDKs
 * give) and falls back to a plain one when the plan or host cannot.
 */

import { Kosa8Error } from '../errors.js';
import { Kosa8Cloud } from '../cloud.js';
import type { CloudCreateOptions, CloudFileInfo, CloudSandbox, Kosa8CloudOptions } from '../cloud.js';

export const WORKSPACE = '/workspace';
const KEY_PREFIX = 'k8c_';

/** A method of another SDK that kosa8 cannot do; `alternative` says what to use on kosa8 instead. */
export class Unsupported extends Kosa8Error {
  constructor(readonly methodName: string, readonly alternative: string, reason = '') {
    super(`${methodName} is not supported by kosa8${reason ? `: ${reason}` : ''}. On kosa8: ${alternative}`, { code: 'unsupported' });
  }
}

let defaultCloud: Kosa8Cloud | undefined;

/** Make every Daytona, Modal and Vercel shim call use `cloud` (a custom address, timeout or fetch); `undefined` goes back to the default. */
export function setDefaultCloud(cloud: Kosa8Cloud | undefined): void {
  defaultCloud = cloud;
}

function env(): Record<string, string | undefined> {
  return typeof process !== 'undefined' ? process.env : {};
}

export function isKosa8Url(url: string): boolean {
  let host = '';
  try {
    host = new URL(url.includes('//') ? url : `https://${url}`).hostname;
  } catch {
    return false;
  }
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === 'kosa8.com' || host.endsWith('.kosa8.com');
}

/** Refuse another provider's address rather than send a kosa8 key there. */
export function checkUrl(method: string, url: string | undefined): void {
  if (url && !isKosa8Url(url)) {
    throw new Unsupported(method, 'leave it out; kosa8 reads KOSA8_CLOUD_URL (default https://api.kosa8.com)',
      `${url} is not a kosa8 address and the kosa8 API key is never sent to it`);
  }
}

/**
 * The cloud a shim talks to. The key is, in order: `apiKey` when given (it
 * must be a kosa8 key), `KOSA8_API_KEY`, then the provider's own variables
 * (`DAYTONA_API_KEY`, `MODAL_TOKEN_SECRET`, `VERCEL_TOKEN`, …) only when
 * they hold a kosa8 key (`k8c_…`). Another provider's key is never sent.
 */
export function cloudFor(provider: string, apiKey: string | undefined, envNames: string[]): Kosa8Cloud {
  if (apiKey !== undefined && !apiKey.startsWith(KEY_PREFIX)) {
    throw new Kosa8Error(`${provider}: that is not a kosa8 key. Use a kosa8 Cloud key (k8c_live_…) from https://app.kosa8.com/keys, or leave it out and set KOSA8_API_KEY`);
  }
  if (defaultCloud && apiKey === undefined) return defaultCloud;
  const e = env();
  let key = apiKey ?? e.KOSA8_API_KEY?.trim();
  if (!key) {
    for (const n of envNames) {
      const v = e[n]?.trim();
      if (v && v.startsWith(KEY_PREFIX)) {
        key = v;
        break;
      }
    }
  }
  if (!key) {
    const held = envNames.filter((n) => e[n]);
    throw new Kosa8Error(`${provider}: no kosa8 Cloud key. Set KOSA8_API_KEY${envNames.length ? ` (or ${envNames.join(' / ')})` : ''} to a kosa8 key (k8c_live_…) from https://app.kosa8.com/keys` +
      (held.length ? `; ${held.join(', ')} holds another provider's key, which kosa8 never sends anywhere` : ''));
  }
  const o: Kosa8CloudOptions = { apiKey: key };
  if (defaultCloud) o.baseUrl = defaultCloud.baseUrl;
  return new Kosa8Cloud(o);
}

/** A relative path is under /workspace. */
export function absPath(path: string, cwd = WORKSPACE): string {
  if (!path) throw new Kosa8Error('a path is required', { code: 'invalid_path' });
  if (path.startsWith('/')) return path;
  const p = path.startsWith('./') ? path.slice(2) : path;
  return `${cwd}/${p}`.replace(/\/+/g, '/');
}

/** `cmd` through bash when the image has it, else sh. */
export function bashOrSh(cmd: string): string[] {
  return ['sh', '-c', 'if command -v bash >/dev/null 2>&1; then exec bash -c "$1"; fi; exec sh -c "$1"', 'sh', cmd];
}

/** `argv` run in `cwd` (relative to /workspace). */
export function inDir(argv: string[], cwd?: string): string[] {
  if (!cwd) return argv;
  return ['sh', '-c', 'cd "$1" || exit 1; shift; exec "$@"', 'sh', absPath(cwd), ...argv];
}

/** Single-quote `s` for sh. */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function persistentRefused(e: unknown): boolean {
  if (!(e instanceof Kosa8Error)) return false;
  const body = (e.body ?? {}) as { limit_name?: string };
  if (e.code === 'plan_limit' && body.limit_name === 'persistent') return true;
  return (e.code === 'not_available' || e.code === 'invalid_persistent') && /persistent/i.test(e.message);
}

/**
 * Create a sandbox, persistent unless `persistent: false`: installs, $HOME
 * and background processes then last between commands, as on the VM the
 * other SDK gave. When the plan has no persistent sandbox left, or the host
 * cannot run one for this image or size, it warns once and makes a plain one
 * (each command a fresh container; only /workspace kept).
 */
export async function createBox(cloud: Kosa8Cloud, provider: string, body: CloudCreateOptions): Promise<CloudSandbox> {
  // A snapshot brings its own settings, persistence included.
  if (body.snapshot !== undefined) {
    const { persistent: _p, ...rest } = body;
    return cloud.sandboxes.create(rest);
  }
  const want = body.persistent ?? true;
  if (!want) return cloud.sandboxes.create(body);
  try {
    return await cloud.sandboxes.create({ ...body, persistent: true });
  } catch (e) {
    if (!persistentRefused(e)) throw e;
    console.warn(`kosa8 (${provider} shim): a persistent sandbox was refused (${(e as Error).message}); ` +
      'made a plain one instead: each command runs in a fresh container and only /workspace is kept between commands');
    const { persistent: _drop, ...rest } = body;
    return cloud.sandboxes.create(rest);
  }
}

/** One file's entry from its folder's listing, or undefined when it is not there. */
export async function statEntry(box: CloudSandbox, path: string): Promise<CloudFileInfo | undefined> {
  const p = absPath(path).replace(/\/+$/, '') || '/';
  if (p === '/') return { name: '/', path: '/', type: 'dir' };
  const parent = p.slice(0, p.lastIndexOf('/')) || '/';
  const name = p.slice(p.lastIndexOf('/') + 1);
  try {
    return (await box.files.list(parent)).find((e) => e.name === name || e.path === p);
  } catch (e) {
    if (e instanceof Kosa8Error && e.status === 404) return undefined;
    throw e;
  }
}

/** Bytes from a string, Uint8Array (Buffer) or ArrayBuffer. */
export function toBytes(data: string | Uint8Array | ArrayBuffer): string | Uint8Array {
  if (typeof data === 'string' || data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  throw new Kosa8Error('cannot write this data: give a string, Uint8Array, Buffer or ArrayBuffer');
}

/** Run a command; throws when it exits non-zero (for chmod, mv and the like). */
export async function mustRun(box: CloudSandbox, argv: string[], what: string): Promise<string> {
  const r = await box.exec(argv);
  if ((r.exitCode ?? 0) !== 0) throw new Kosa8Error(`${what} failed: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout;
}

/** The size (`2x4`, …) for cpus and GiB, when kosa8 has one. */
export function sizeFor(cpus: number | undefined, memGiB: number | undefined): string | undefined {
  if (cpus === undefined && memGiB === undefined) return undefined;
  const sizes: Array<[number, number]> = [[0.25, 0.5], [0.5, 1], [1, 2], [2, 4], [4, 8], [8, 16], [16, 32]];
  const hit = sizes.find(([c, m]) => (cpus === undefined || c >= cpus) && (memGiB === undefined || m >= memGiB));
  return hit ? `${hit[0]}x${hit[1]}` : undefined;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Node's fs, for calls that take a local path (uploadFile('./a.txt', …)). */
export async function localFs(): Promise<typeof import('node:fs/promises')> {
  return import('node:fs/promises');
}

/**
 * A file's permission bits from the API's `mode` (a number such as 420 for
 * 0644); an octal string is read too. 0 when absent.
 */
export function modeBits(mode: unknown): number {
  if (typeof mode === 'number' && Number.isFinite(mode)) return mode & 0o7777;
  if (typeof mode === 'string' && /^[0-7]{3,4}$/.test(mode)) return parseInt(mode, 8);
  return 0;
}

/** `ls -l` style permissions, e.g. -rw-r--r-- or drwxr-xr-x. */
export function symbolicMode(bits: number, type?: string): string {
  const kind = type === 'dir' ? 'd' : type === 'symlink' ? 'l' : '-';
  let out = kind;
  for (const shift of [6, 3, 0]) {
    const b = (bits >> shift) & 7;
    out += (b & 4 ? 'r' : '-') + (b & 2 ? 'w' : '-') + (b & 1 ? 'x' : '-');
  }
  return out;
}

/** Octal permissions, e.g. 0644. */
export function octalMode(bits: number): string {
  return bits.toString(8).padStart(4, '0');
}

// Copyright (c) 2026 kosa8. Licensed under the MIT License; see LICENSE.

/**
 * E2B's `Sandbox` on kosa8 Cloud: change `import { Sandbox } from 'e2b'` to
 * `import { Sandbox } from '@kosa8/sdk/e2b'`.
 *
 * Mirrors the common surface of the `e2b` JS SDK (2.x): `Sandbox.create`,
 * `Sandbox.connect`, `Sandbox.kill`, `sandbox.sandboxId`, `sandbox.kill()`,
 * `setTimeout`, `getInfo`, `isRunning`, `sandbox.commands.run` (foreground
 * and `background: true`), `commands.connect` / `kill`, and `sandbox.files`
 * `read` / `write` / `list` / `exists` / `remove` / `makeDir`. Anything else
 * throws `Unsupported`, which names the method and the kosa8 way to do it; a
 * call never pretends to have worked. Like the Python shim
 * (`kosa8.compat.e2b`).
 *
 * The key is a kosa8 Cloud key (`KOSA8_API_KEY`, or `apiKey: 'k8c_live_…'`).
 *
 * How it differs from E2B:
 * - Output streams. `commands.run(cmd, { onStdout, onStderr })`, or a
 *   `timeoutMs` over 90 s (or 0, no limit), is a streamed exec: the callbacks
 *   get the output as the command prints it, and it is not held to 90 s. A
 *   plain run (no callbacks, no long timeout) is a buffered exec: 90 s at
 *   most, its output arriving when it ends.
 * - A background command's output is polled about once a second and passed
 *   on as it appears, stdout and stderr together (as stdout).
 * - Only `/workspace` outlives a command (unless the sandbox is persistent);
 *   relative paths are put under `/workspace`. No stdin or PTY.
 */

import {
  Kosa8AuthError,
  Kosa8BadRequestError,
  Kosa8Error,
  Kosa8ExecTimeoutError,
  Kosa8NotFoundError,
  Kosa8RateLimitError,
  Kosa8TimeoutError,
} from '../errors.js';
import { EXEC_LIMIT_S, Kosa8Cloud } from '../cloud.js';
import type { CloudCreateOptions, CloudExecResult, CloudFileInfo, CloudSandbox, CloudSandboxInfo, Kosa8CloudOptions } from '../cloud.js';
import type { CloudBackgroundExec } from '../cloud-features.js';
import { modeBits, symbolicMode } from './common.js';

/** The E2B JS SDK version this module follows. */
export const MIRRORS = { e2b: '2.x' } as const;

const DEFAULT_TIMEOUT_MS = 300_000;
const MIN_TTL_S = 60;
const MAX_TTL_S = 7_776_000;
const WORKSPACE = '/workspace';

// --- errors, as E2B names them -----------------------------------------------------------

/** A method of E2B's SDK that kosa8 cannot do; `alternative` says what to use instead. */
export class Unsupported extends Kosa8Error {
  constructor(readonly methodName: string, readonly alternative: string, reason = '') {
    super(`${methodName} is not supported by kosa8${reason ? `: ${reason}` : ''}. On kosa8: ${alternative}`, { code: 'unsupported' });
  }
}

export class SandboxError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}
export class TimeoutError extends SandboxError {}
export class InvalidArgumentError extends SandboxError {}
export class NotFoundError extends SandboxError {}
export class AuthenticationError extends SandboxError {}
export class RateLimitError extends SandboxError {}

/** A foreground command exited non-zero (E2B throws; so does this). */
export class CommandExitError extends SandboxError implements CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: string;
  constructor(r: { exitCode: number; stdout: string; stderr: string; error?: string }) {
    super(`Command exited with code ${r.exitCode} and error:\n${r.stderr}`);
    this.exitCode = r.exitCode;
    this.stdout = r.stdout;
    this.stderr = r.stderr;
    if (r.error !== undefined) this.error = r.error;
  }
}

function convert(e: unknown): unknown {
  if (e instanceof Unsupported || !(e instanceof Kosa8Error)) return e;
  const o = { cause: e };
  if (e instanceof Kosa8ExecTimeoutError || e instanceof Kosa8TimeoutError) return new TimeoutError(e.message, o);
  if (e instanceof Kosa8NotFoundError) return new NotFoundError(e.message, o);
  if (e instanceof Kosa8AuthError) return new AuthenticationError(e.message, o);
  if (e instanceof Kosa8RateLimitError) return new RateLimitError(e.message, o);
  if (e instanceof Kosa8BadRequestError) return new InvalidArgumentError(e.message, o);
  return new SandboxError(e.message, o);
}

async function e2b<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw convert(e);
  }
}

// --- helpers -------------------------------------------------------------------------------

let defaultCloud: Kosa8Cloud | undefined;

/** Make every shim call use `cloud` (a custom address, timeout or fetch); `undefined` goes back to the default. */
export function setDefaultCloud(cloud: Kosa8Cloud | undefined): void {
  defaultCloud = cloud;
}

function cloudFor(opts: { apiKey?: string; domain?: string; apiUrl?: string } = {}): Kosa8Cloud {
  for (const k of ['domain', 'apiUrl'] as const) {
    const url = opts[k];
    if (url && !isKosa8Url(url)) {
      throw new Unsupported(`e2b Sandbox (${k})`, 'leave it out; kosa8 reads KOSA8_CLOUD_URL (default https://api.kosa8.com)',
        `${url} is not a kosa8 address and the kosa8 API key is never sent to it`);
    }
  }
  if (defaultCloud && opts.apiKey === undefined) return defaultCloud;
  const o: Kosa8CloudOptions = {};
  if (opts.apiKey !== undefined) o.apiKey = opts.apiKey;
  if (defaultCloud) o.baseUrl = defaultCloud.baseUrl;
  return new Kosa8Cloud(o);
}

function isKosa8Url(url: string): boolean {
  let host = '';
  try {
    host = new URL(url.includes('//') ? url : `https://${url}`).hostname;
  } catch {
    return false;
  }
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === 'kosa8.com' || host.endsWith('.kosa8.com');
}

/** A relative path is under /workspace, the folder kosa8 keeps between commands. */
function absPath(path: string): string {
  if (!path) throw new InvalidArgumentError('a path is required');
  if (path.startsWith('/')) return path;
  const p = path.startsWith('./') ? path.slice(2) : path;
  return `${WORKSPACE}/${p}`.replace(/\/+/g, '/');
}

/** `cmd` through bash when the image has it, else sh (the base template is Alpine). */
function bashOrSh(cmd: string): string[] {
  return ['sh', '-c', 'if command -v bash >/dev/null 2>&1; then exec bash -l -c "$1"; fi; exec sh -c "$1"', 'sh', cmd];
}

function inDir(argv: string[], cwd?: string): string[] {
  if (!cwd) return argv;
  return ['sh', '-c', 'cd "$1" || exit 1; shift; exec "$@"', 'sh', absPath(cwd), ...argv];
}

function ttlS(timeoutMs?: number): number {
  const s = Math.round((timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000);
  return Math.min(Math.max(s, MIN_TTL_S), MAX_TTL_S);
}

function refuseUser(method: string, user: unknown): void {
  if (user !== undefined) throw new Unsupported(`e2b ${method}({ user })`, 'commands run as the image\'s user; switch user inside the command (su, sudo)');
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// --- types ---------------------------------------------------------------------------------

export interface SandboxOpts {
  /** A kosa8 Cloud key (default KOSA8_API_KEY). */
  apiKey?: string;
  /** The sandbox's lifetime in ms (default 300 000; kosa8 keeps a sandbox 60 s at least). */
  timeoutMs?: number;
  /** Labels. */
  metadata?: Record<string, string>;
  /** Env every command gets. */
  envs?: Record<string, string>;
  /** false: no internet. */
  allowInternetAccess?: boolean;
  /** Ignored, as E2B ignores it now. */
  secure?: boolean;
  /** Must be a kosa8 address when given. */
  domain?: string;
  apiUrl?: string;
  requestTimeoutMs?: number;
  [k: string]: unknown;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  error?: string;
}

export interface CommandStartOpts {
  /** Start it and return a CommandHandle at once. */
  background?: boolean;
  envs?: Record<string, string>;
  /** Working folder (relative to /workspace). */
  cwd?: string;
  user?: string;
  /** Called with output as the command prints it. */
  onStdout?: (data: string) => unknown;
  onStderr?: (data: string) => unknown;
  /** Stop the command after this long (default 60 000 ms; 0 means no limit). */
  timeoutMs?: number;
  requestTimeoutMs?: number;
  stdin?: boolean;
}

export interface EntryInfo {
  name: string;
  type?: 'file' | 'dir';
  path: string;
  size: number;
  mode: number;
  permissions: string;
  modifiedTime?: Date;
}

export interface WriteInfo {
  name: string;
  type?: 'file' | 'dir';
  path: string;
}

export interface SandboxInfo {
  sandboxId: string;
  templateId: string;
  name?: string;
  metadata: Record<string, string>;
  startedAt?: Date;
  endAt?: Date;
  state: string;
  cpuCount?: number;
  memoryMB?: number;
}

function toDate(v: unknown): Date | undefined {
  if (typeof v === 'number') return new Date(v);
  if (typeof v === 'string' && v) {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  return undefined;
}

function entry(e: CloudFileInfo): EntryInfo {
  const out: EntryInfo = {
    name: e.name ?? e.path.split('/').pop() ?? '',
    path: e.path,
    size: e.size ?? 0,
    mode: modeBits(e.mode),
    permissions: symbolicMode(modeBits(e.mode), e.type),
  };
  if (e.type === 'dir' || e.type === 'file') out.type = e.type as 'file' | 'dir';
  const t = toDate(e.mod_time);
  if (t) out.modifiedTime = t;
  return out;
}

function info(s: CloudSandboxInfo): SandboxInfo {
  const x = s as CloudSandboxInfo & { name?: string; labels?: Record<string, string>; delete_after?: number | null };
  const out: SandboxInfo = {
    sandboxId: s.id,
    templateId: s.template ?? 'base',
    metadata: { ...(x.labels ?? {}) },
    state: s.state === 'sleeping' ? 'paused' : String(s.state),
  };
  if (x.name) out.name = x.name;
  const st = toDate(s.started_at ?? s.created_at);
  if (st) out.startedAt = st;
  const end = toDate(x.delete_after);
  if (end) out.endAt = end;
  if (typeof s.cpus === 'number') out.cpuCount = s.cpus;
  if (typeof s.mem_mb === 'number') out.memoryMB = s.mem_mb;
  return out;
}

// --- commands --------------------------------------------------------------------------------

/**
 * A background command (`commands.run(cmd, { background: true })`). `pid` is
 * kosa8's background command id (`bg_…`), not a process id. Its output is
 * polled about once a second (`CommandHandle.pollIntervalMs`); stdout and
 * stderr are recorded together, and come back as stdout.
 */
export class CommandHandle {
  /** Milliseconds between polls of a background command's output. */
  static pollIntervalMs = 1000;

  private seen = 0;
  private out: string[] = [];
  private listeners: Array<(d: string) => unknown> = [];
  private following?: Promise<void>;
  private finalExit: number | null | undefined;
  private failure: unknown;

  /** @internal */
  constructor(private readonly job: CloudBackgroundExec, onStdout?: (d: string) => unknown) {
    if (onStdout) {
      this.listeners.push(onStdout);
      // E2B calls run()'s callbacks as output arrives, without wait().
      this.following = this.follow().catch((e) => {
        this.failure = e;
      });
    }
  }

  get pid(): string {
    return this.job.id;
  }

  get stdout(): string {
    return this.out.join('');
  }

  get stderr(): string {
    return '';
  }

  get exitCode(): number | undefined {
    return this.finalExit ?? undefined;
  }

  private async follow(): Promise<void> {
    for (;;) {
      const s = await this.job.status();
      const all = s.output ?? '';
      if (all.length > this.seen) {
        const piece = all.slice(this.seen);
        this.seen = all.length;
        this.out.push(piece);
        for (const cb of [...this.listeners]) await cb(piece);
      }
      if (s.state === 'exited') {
        this.finalExit = s.exit;
        return;
      }
      await sleep(CommandHandle.pollIntervalMs);
    }
  }

  /** Until it exits; `onStdout` gets its output as it appears (what it printed before this call first). */
  async wait(opts: { onStdout?: (d: string) => unknown; onStderr?: (d: string) => unknown } = {}): Promise<CommandResult> {
    return e2b(async () => {
      if (opts.onStdout) {
        const before = this.stdout;
        this.listeners.push(opts.onStdout);
        if (before) await opts.onStdout(before);
      }
      if (this.finalExit === undefined) {
        if (!this.following) this.following = this.follow();
        await this.following;
      }
      if (this.failure !== undefined) throw this.failure;
      const code = this.finalExit ?? 0;
      if (code !== 0) throw new CommandExitError({ exitCode: code, stdout: this.stdout, stderr: '' });
      return { exitCode: code, stdout: this.stdout, stderr: '' };
    });
  }

  /** Stop the command; false when there is no such command. */
  async kill(): Promise<boolean> {
    return e2b(async () => {
      try {
        await this.job.stop();
        return true;
      } catch (e) {
        if (e instanceof Kosa8NotFoundError) return false;
        throw e;
      }
    });
  }

  /** Stop following it here; the command keeps running. */
  async disconnect(): Promise<void> {}

  async sendStdin(): Promise<void> {
    throw new Unsupported('e2b CommandHandle.sendStdin', 'kosa8 commands take no stdin; write the input to a file in /workspace and read it');
  }
}

export class Commands {
  /** @internal */
  constructor(private readonly box: CloudSandbox) {}

  /**
   * Run `cmd` and wait (or start it with `background: true`). A non-zero exit
   * throws `CommandExitError`, as in E2B.
   *
   * With `onStdout` / `onStderr`, or `timeoutMs` over 90 s (or 0, no limit),
   * it is a streamed exec: the callbacks get output as it prints and
   * `timeoutMs` is applied in the sandbox (`TimeoutError` past it). Without
   * them it is a buffered exec, held to 90 s whatever `timeoutMs` says.
   */
  run(cmd: string, opts: CommandStartOpts & { background: true }): Promise<CommandHandle>;
  run(cmd: string, opts?: CommandStartOpts & { background?: false }): Promise<CommandResult>;
  run(cmd: string, opts?: CommandStartOpts): Promise<CommandResult | CommandHandle>;
  async run(cmd: string, opts: CommandStartOpts = {}): Promise<CommandResult | CommandHandle> {
    return e2b(async () => {
      refuseUser('commands.run', opts.user);
      if (opts.stdin) throw new Unsupported('e2b commands.run({ stdin: true })', 'kosa8 commands take no stdin; write the input to a file in /workspace');
      const argv = inDir(bashOrSh(cmd), opts.cwd);
      const env = opts.envs && Object.keys(opts.envs).length ? opts.envs : undefined;
      if (opts.background) {
        const job = await this.box.execBackground(argv, env ? { env } : {});
        return new CommandHandle(job, opts.onStdout);
      }
      const timeoutMs = opts.timeoutMs ?? 60_000;
      const noLimit = timeoutMs <= 0;
      let r: CloudExecResult;
      if (opts.onStdout || opts.onStderr || noLimit || timeoutMs > EXEC_LIMIT_S * 1000) {
        const s = await this.box.execStream(argv, {
          ...(env ? { env } : {}),
          ...(noLimit ? {} : { timeoutS: Math.max(1, Math.ceil(timeoutMs / 1000)) }),
        });
        // Callbacks are awaited in order, so one piece is handled before the next.
        try {
          for await (const c of s) await (c.stream === 'stdout' ? opts.onStdout : opts.onStderr)?.(c.text);
        } finally {
          await s.close();
        }
        r = { exitCode: s.exitCode, stdout: s.stdout, stderr: s.stderr, failureClass: 'ok', retryable: false };
      } else {
        r = await this.box.exec(argv, env ? { env } : {});
      }
      const code = r.exitCode ?? 0;
      if (code !== 0) throw new CommandExitError({ exitCode: code, stdout: r.stdout, stderr: r.stderr });
      return { exitCode: code, stdout: r.stdout, stderr: r.stderr };
    });
  }

  /** A background command by its id (`bg_…`). */
  async connect(pid: string, opts: { onStdout?: (d: string) => unknown } = {}): Promise<CommandHandle> {
    return e2b(async () => new CommandHandle(await this.box.getExec(String(pid)), opts.onStdout));
  }

  /** Stop a background command; false when there is no such command. */
  async kill(pid: string): Promise<boolean> {
    return e2b(async () => {
      try {
        await (await this.box.getExec(String(pid))).stop();
        return true;
      } catch (e) {
        if (e instanceof Kosa8NotFoundError) return false;
        throw e;
      }
    });
  }

  async list(): Promise<never> {
    throw new Unsupported('e2b commands.list', 'keep the CommandHandle (or its pid) that run({ background: true }) returned');
  }

  async sendStdin(): Promise<never> {
    throw new Unsupported('e2b commands.sendStdin', 'kosa8 commands take no stdin; write the input to a file in /workspace');
  }
}

// --- files -----------------------------------------------------------------------------------

export class Filesystem {
  /** @internal */
  constructor(private readonly box: CloudSandbox) {}

  /** `format`: `text` (default, a string), `bytes` (Uint8Array) or `blob`. */
  read(path: string, opts?: { format?: 'text'; user?: string }): Promise<string>;
  read(path: string, opts: { format: 'bytes'; user?: string }): Promise<Uint8Array>;
  read(path: string, opts: { format: 'blob'; user?: string }): Promise<Blob>;
  read(path: string, opts: { format: 'stream'; user?: string }): Promise<ReadableStream<Uint8Array>>;
  async read(path: string, opts: { format?: 'text' | 'bytes' | 'blob' | 'stream'; user?: string } = {}): Promise<unknown> {
    return e2b(async () => {
      refuseUser('files.read', opts.user);
      const data = await this.box.files.read(absPath(path));
      switch (opts.format ?? 'text') {
        case 'text':
          return new TextDecoder().decode(data);
        case 'bytes':
          return data;
        case 'blob':
          return new Blob([data as BlobPart]);
        case 'stream':
          return new Blob([data as BlobPart]).stream();
        default:
          throw new InvalidArgumentError(`unknown format ${String(opts.format)}`);
      }
    });
  }

  /** Write one file, or several (`[{ path, data }]`); missing parent folders are made. */
  write(path: string, data: string | ArrayBuffer | Uint8Array | Blob, opts?: { user?: string }): Promise<WriteInfo>;
  write(files: Array<{ path: string; data: string | ArrayBuffer | Uint8Array | Blob }>, opts?: { user?: string }): Promise<WriteInfo[]>;
  async write(a: unknown, b?: unknown, c?: unknown): Promise<WriteInfo | WriteInfo[]> {
    return e2b(async () => {
      if (Array.isArray(a)) {
        refuseUser('files.write', (b as { user?: string } | undefined)?.user);
        const out: WriteInfo[] = [];
        for (const f of a as Array<{ path: string; data: string | ArrayBuffer | Uint8Array | Blob }>) out.push(await this.writeOne(f.path, f.data));
        return out;
      }
      refuseUser('files.write', (c as { user?: string } | undefined)?.user);
      return this.writeOne(a as string, b as string | ArrayBuffer | Uint8Array | Blob);
    });
  }

  private async writeOne(path: string, data: string | ArrayBuffer | Uint8Array | Blob): Promise<WriteInfo> {
    const p = absPath(path);
    let bytes: string | Uint8Array;
    if (typeof data === 'string' || data instanceof Uint8Array) bytes = data;
    else if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
    else if (typeof Blob !== 'undefined' && data instanceof Blob) bytes = new Uint8Array(await data.arrayBuffer());
    else throw new InvalidArgumentError('cannot write this data: give a string, Uint8Array, ArrayBuffer or Blob');
    const parent = p.slice(0, p.lastIndexOf('/')) || '/';
    if (parent !== '/' && parent !== WORKSPACE) await this.box.files.mkdir(parent);
    await this.box.files.write(p, bytes);
    return { name: p.split('/').pop() ?? '', type: 'file', path: p };
  }

  /** A folder's entries. `depth` over 1 is not supported. */
  async list(path: string, opts: { depth?: number; user?: string } = {}): Promise<EntryInfo[]> {
    return e2b(async () => {
      refuseUser('files.list', opts.user);
      if (opts.depth !== undefined && opts.depth > 1) {
        throw new Unsupported('e2b files.list({ depth })', 'list each folder, or commands.run("find PATH -maxdepth N")');
      }
      try {
        return (await this.box.files.list(absPath(path))).map(entry);
      } catch (e) {
        if (e instanceof Kosa8NotFoundError) throw new NotFoundError(e.message, { cause: e });
        throw e;
      }
    });
  }

  async exists(path: string): Promise<boolean> {
    return e2b(async () => {
      const p = absPath(path).replace(/\/+$/, '') || '/';
      if (p === '/') return true;
      const parent = p.slice(0, p.lastIndexOf('/')) || '/';
      const name = p.slice(p.lastIndexOf('/') + 1);
      try {
        return (await this.box.files.list(parent)).some((e) => e.name === name || e.path === p);
      } catch (e) {
        if (e instanceof Kosa8NotFoundError) return false;
        throw e;
      }
    });
  }

  async remove(path: string): Promise<void> {
    await e2b(() => this.box.files.delete(absPath(path), { recursive: true }));
  }

  /** Make a folder and its parents; false when it was already there. */
  async makeDir(path: string): Promise<boolean> {
    return e2b(async () => {
      const there = await this.exists(path);
      await this.box.files.mkdir(absPath(path));
      return !there;
    });
  }

  async rename(oldPath: string, newPath: string): Promise<EntryInfo> {
    return e2b(async () => {
      const r = await this.box.exec(['mv', absPath(oldPath), absPath(newPath)]);
      if (r.exitCode !== 0) throw new SandboxError(`rename failed: ${r.stderr.trim()}`);
      const p = absPath(newPath);
      return { name: p.split('/').pop() ?? '', path: p, size: 0, mode: 0, permissions: '' };
    });
  }

  async watchDir(): Promise<never> {
    throw new Unsupported('e2b files.watchDir', 'poll files.list(path) for changes');
  }
}

// --- the sandbox -----------------------------------------------------------------------------

function createBody(template: string | undefined, opts: SandboxOpts): CloudCreateOptions {
  for (const [name, alt] of [
    ['mcp', 'run the MCP server yourself with commands.run(cmd, { background: true })'],
    ['network', 'allowInternetAccess: false, or sandbox.kosa8.setEgress({ allow, deny })'],
    ['volumeMounts', 'keep data in /workspace, or snapshot the sandbox'],
    ['lifecycle', 'kosa8 deletes the sandbox at timeoutMs; sandbox.kosa8.update({ sleepAfterS }) sleeps it when idle'],
  ] as const) {
    if (opts[name] !== undefined) throw new Unsupported(`e2b Sandbox.create({ ${name} })`, alt);
  }
  const body: CloudCreateOptions = { ttlS: ttlS(opts.timeoutMs) };
  const t = template ?? 'python';
  // E2B's default image has Python in it; kosa8's base is Alpine without it,
  // so no template, and E2B's "base", start kosa8's "python" template.
  if (t.startsWith('snap_')) body.snapshot = t;
  else body.template = t === 'base' ? 'python' : t;
  if (opts.envs && Object.keys(opts.envs).length) body.env = { ...opts.envs };
  if (opts.metadata && Object.keys(opts.metadata).length) body.labels = { ...opts.metadata };
  if (opts.allowInternetAccess === false) body.egress = { internet: false } as CloudCreateOptions['egress'];
  return body;
}

/**
 * E2B's `Sandbox`. Make one with `Sandbox.create()` or `Sandbox.connect(id)`.
 * `sandbox.kosa8` is the `CloudSandbox` underneath, for anything E2B has no
 * word for.
 */
export class Sandbox {
  readonly commands: Commands;
  readonly files: Filesystem;

  /** @internal Use `Sandbox.create` or `Sandbox.connect`. */
  constructor(readonly kosa8: CloudSandbox) {
    this.commands = new Commands(kosa8);
    this.files = new Filesystem(kosa8);
  }

  get sandboxId(): string {
    return this.kosa8.id;
  }

  get pty(): never {
    throw new Unsupported('e2b sandbox.pty', 'sandbox.kosa8.terminal() gives a wss:// URL for an interactive terminal');
  }

  /** Start a sandbox: `Sandbox.create()`, `Sandbox.create('python')` or `Sandbox.create('node', { timeoutMs })`. */
  static async create<S extends typeof Sandbox>(this: S, templateOrOpts?: string | SandboxOpts, maybeOpts?: SandboxOpts): Promise<InstanceType<S>> {
    const template = typeof templateOrOpts === 'string' ? templateOrOpts : undefined;
    const opts = (typeof templateOrOpts === 'string' ? maybeOpts : templateOrOpts) ?? {};
    return e2b(async () => {
      const box = await cloudFor(opts).sandboxes.create(createBody(template, opts));
      return new this(box) as InstanceType<S>;
    });
  }

  /** A running (or paused) sandbox by id; a paused one wakes. */
  static async connect<S extends typeof Sandbox>(this: S, sandboxId: string, opts: SandboxOpts = {}): Promise<InstanceType<S>> {
    return e2b(async () => {
      const box = await cloudFor(opts).sandboxes.get(sandboxId);
      if (box.state === 'sleeping') await box.wake();
      if (opts.timeoutMs !== undefined) await box.update({ ttlS: ttlS(opts.timeoutMs) });
      return new this(box) as InstanceType<S>;
    });
  }

  /** Delete a sandbox by id; false when there was no such sandbox. */
  static async kill(sandboxId: string, opts: SandboxOpts = {}): Promise<boolean> {
    return e2b(async () => {
      try {
        await (await cloudFor(opts).sandboxes.get(sandboxId)).delete();
        return true;
      } catch (e) {
        if (e instanceof Kosa8NotFoundError) return false;
        throw e;
      }
    });
  }

  /** Delete it; false when it was already gone. */
  async kill(): Promise<boolean> {
    return e2b(async () => {
      try {
        await this.kosa8.delete();
        return true;
      } catch (e) {
        if (e instanceof Kosa8NotFoundError) return false;
        throw e;
      }
    });
  }

  /** A new lifetime, counted from now (kosa8 keeps a sandbox 60 s at least). */
  async setTimeout(timeoutMs: number): Promise<void> {
    await e2b(() => this.kosa8.update({ ttlS: ttlS(timeoutMs) }));
  }

  async getInfo(): Promise<SandboxInfo> {
    return e2b(async () => info((await this.kosa8.refresh()).info));
  }

  async isRunning(): Promise<boolean> {
    return e2b(async () => {
      try {
        return (await this.kosa8.refresh()).state === 'running';
      } catch (e) {
        if (e instanceof Kosa8NotFoundError) return false;
        throw e;
      }
    });
  }

  /** Sleep it (memory, processes and disk kept); `connect` wakes it. */
  async pause(): Promise<boolean> {
    return e2b(async () => {
      if (this.kosa8.state === 'sleeping') return false;
      await this.kosa8.sleep();
      return true;
    });
  }

  /** The https URL of a port: `sandbox.getHost(3000)` (without the scheme, as E2B returns it). */
  async getHost(port: number): Promise<string> {
    return e2b(async () => {
      const p = await this.kosa8.previews.create(port);
      return String(p.url).replace(/^https?:\/\//, '');
    });
  }

  async runCode(): Promise<never> {
    throw new Unsupported('e2b Sandbox.runCode (code interpreter)', 'sandbox.kosa8.runCode(code) on a persistent python sandbox, or commands.run("python3 -c ...")');
  }

  async downloadUrl(): Promise<never> {
    throw new Unsupported('e2b Sandbox.downloadUrl', 'sandbox.kosa8.files.link(path) gives a presigned download URL');
  }

  async uploadUrl(): Promise<never> {
    throw new Unsupported('e2b Sandbox.uploadUrl', "sandbox.kosa8.files.link(path, { method: 'PUT' }) gives a presigned upload URL");
  }
}

export default Sandbox;

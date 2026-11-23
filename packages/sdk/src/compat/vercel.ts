// Copyright (c) 2026 kosa8. Licensed under the MIT License; see LICENSE.

/**
 * Vercel Sandbox on kosa8 Cloud: change
 * `import { Sandbox } from '@vercel/sandbox'` to
 * `import { Sandbox } from '@kosa8/sdk/vercel'`.
 *
 * Mirrors the common surface of `@vercel/sandbox` 4.1: `Sandbox.create`
 * (`source` git or tarball, `ports`, `timeout`, `resources.vcpus`, `runtime`
 * / `image`, `env`, `tags`, `networkPolicy`), `Sandbox.get`, `Sandbox.list`,
 * and on a sandbox `runCommand` (both forms; `detached` gives a `Command`
 * with `wait()` and `logs()`), `getCommand`, `writeFiles`, `readFile`,
 * `readFileToBuffer`, `downloadFile`, `mkDir`, `domain(port)`,
 * `extendTimeout`, `updateNetworkPolicy`, `snapshot`, `stop` and `delete`.
 * Anything else throws `Unsupported`, which names the method and the kosa8
 * way to do it; nothing pretends to have worked.
 *
 * The key is a kosa8 Cloud key: `token` / `KOSA8_API_KEY`, or `VERCEL_TOKEN`
 * / `VERCEL_OIDC_TOKEN` when it holds a kosa8 key (`k8c_…`).
 *
 * Sandboxes are created persistent (one long-lived container, as Vercel's
 * microVM), in `/workspace` (Vercel's is /vercel/sandbox). `stop()` sleeps
 * it, memory and disk kept, as a persistent Vercel sandbox resumes.
 */

import { Readable } from 'node:stream';
import { Kosa8Error, Kosa8NotFoundError, Kosa8ExecTimeoutError, Kosa8TimeoutError } from '../errors.js';
import type { CloudCreateOptions, CloudSandbox, Kosa8Cloud } from '../cloud.js';
import type { CloudBackgroundExec, CloudEgressPolicy } from '../cloud-features.js';
import {
  Unsupported, WORKSPACE, absPath, checkUrl, cloudFor, createBox, inDir, localFs, mustRun, setDefaultCloud, shq, sizeFor, sleep, toBytes,
} from './common.js';

export { Unsupported, setDefaultCloud };

/** The @vercel/sandbox version this module follows. */
export const MIRRORS = { '@vercel/sandbox': '4.1.0' } as const;

const ENV_KEYS = ['VERCEL_TOKEN', 'VERCEL_OIDC_TOKEN'];
const DEFAULT_TIMEOUT_MS = 300_000;

export class APIError extends Error {
  constructor(message: string, readonly status?: number, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

function convert(e: unknown): unknown {
  if (e instanceof Unsupported || !(e instanceof Kosa8Error)) return e;
  return new APIError(e.message, e.status, { cause: e });
}

async function vc<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw convert(e);
  }
}

// --- network policy ---------------------------------------------------------------------------

export type NetworkPolicy = 'allow-all' | 'deny-all' | {
  allow?: string[] | Record<string, unknown[]>;
  subnets?: { allow?: string[]; deny?: string[] };
};

function egressOf(p: NetworkPolicy): CloudEgressPolicy {
  if (p === 'allow-all') return { internet: true, allow: [], deny: [] };
  if (p === 'deny-all') return { internet: false, allow: [], deny: [] };
  if (p.allow !== undefined && !Array.isArray(p.allow)) {
    throw new Unsupported('vercel networkPolicy { allow: { domain: rules } } (request transforms)', 'a list of hosts: { allow: ["api.example.com"] }; the AI gateway (aiGateway) holds model keys outside the sandbox');
  }
  const allow = [...(p.allow ?? []), ...(p.subnets?.allow ?? [])];
  const deny = p.subnets?.deny ?? [];
  return { internet: allow.length === 0, allow, deny };
}

// --- commands --------------------------------------------------------------------------------

export interface LogOutputLine {
  stream: 'stdout' | 'stderr';
  data: string;
}

interface Writable {
  write(chunk: string): unknown;
}

/**
 * A command. A detached one (`runCommand({ detached: true })`) is a kosa8
 * background command: its output is polled about once a second, stdout and
 * stderr together (as stdout).
 */
export class Command {
  exitCode: number | null = null;
  /** @internal */
  out = '';
  /** @internal */
  err = '';

  /** @internal */
  constructor(protected readonly box: CloudSandbox, readonly cmdId: string, protected readonly job?: CloudBackgroundExec, readonly cwd = WORKSPACE) {}

  readonly startedAt = Date.now();

  /** Its output as it appears. */
  async *logs(): AsyncGenerator<LogOutputLine, void, void> {
    if (!this.job) {
      if (this.out) yield { stream: 'stdout', data: this.out };
      if (this.err) yield { stream: 'stderr', data: this.err };
      return;
    }
    let seen = 0;
    for (;;) {
      const s = await vc(() => this.job!.status());
      const all = s.output ?? '';
      if (all.length > seen) {
        yield { stream: 'stdout', data: all.slice(seen) };
        seen = all.length;
      }
      if (s.state === 'exited') {
        this.out = all;
        this.exitCode = s.exit ?? 0;
        return;
      }
      await sleep(1000);
    }
  }

  /** Until it exits. */
  async wait(): Promise<CommandFinished> {
    return vc(async () => {
      if (this.job && this.exitCode === null) {
        const s = await this.job.wait({ timeoutMs: 86_400_000 });
        this.out = s.output ?? '';
        this.exitCode = s.exit ?? 0;
      }
      return new CommandFinished(this.box, this.cmdId, this.exitCode ?? 0, this.out, this.err, this.cwd);
    });
  }

  async output(stream: 'stdout' | 'stderr' | 'both' = 'both'): Promise<string> {
    const f = this.exitCode === null ? await this.wait() : this;
    return stream === 'stdout' ? f.out : stream === 'stderr' ? f.err : f.out + f.err;
  }

  async stdout(): Promise<string> {
    return this.output('stdout');
  }

  async stderr(): Promise<string> {
    return this.output('stderr');
  }

  /** Stop it (a detached command). */
  async kill(_signal?: string): Promise<void> {
    if (!this.job) return;
    await vc(async () => {
      try {
        await this.job!.stop();
      } catch (e) {
        if (!(e instanceof Kosa8NotFoundError)) throw e;
      }
    });
  }

  async writeStdin(): Promise<never> {
    throw new Unsupported('vercel Command.writeStdin', 'kosa8 commands take no stdin; write the input with writeFiles and read it');
  }

  async closeStdin(): Promise<never> {
    return this.writeStdin();
  }
}

export class CommandFinished extends Command {
  declare exitCode: number;

  /** @internal */
  constructor(box: CloudSandbox, cmdId: string, exitCode: number, stdout: string, stderr: string, cwd?: string) {
    super(box, cmdId, undefined, cwd);
    this.exitCode = exitCode;
    this.out = stdout;
    this.err = stderr;
  }
}

export interface RunCommandParams {
  cmd: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  sudo?: boolean;
  detached?: boolean;
  stdin?: unknown;
  stdout?: Writable;
  stderr?: Writable;
  signal?: AbortSignal;
  timeoutMs?: number;
}

// --- the sandbox -----------------------------------------------------------------------------

interface Credentials {
  /** A kosa8 Cloud key (k8c_…) here, if anywhere. */
  token?: string;
  teamId?: string;
  projectId?: string;
}

export interface CreateSandboxParams extends Credentials {
  name?: string;
  source?: { type: 'git'; url: string; depth?: number; revision?: string; username?: string; password?: string }
    | { type: 'tarball'; url: string }
    | { type: 'snapshot'; snapshotId: string };
  /** Ports to open; `domain(port)` gives each one's public https URL. */
  ports?: number[];
  /** Lifetime in ms (default 5 minutes, as Vercel's). */
  timeout?: number;
  /** vCPUs (2 GiB each, as on Vercel); sizes 1, 2, 4, 8 or 16. */
  resources?: { vcpus: number };
  networkPolicy?: NetworkPolicy;
  env?: Record<string, string>;
  tags?: Record<string, string>;
  /** node22 / node24 start kosa8's node template, python3.x its python template. */
  runtime?: string;
  /** A kosa8 template key or a registry image (vercel/sandbox/* images start the node template). */
  image?: string;
  /** Default true, as Vercel's. false: a plain sandbox (each command a fresh container, only /workspace kept). */
  persistent?: boolean;
  [k: string]: unknown;
}

function templateFor(runtime?: string, image?: string): Pick<CloudCreateOptions, 'template' | 'image'> {
  if (image && !image.startsWith('vercel/sandbox')) {
    return image.includes(':') || image.includes('/') ? { image } : { template: image };
  }
  if (runtime?.startsWith('python')) return { template: 'python' };
  return { template: 'node' };
}

function createBody(p: CreateSandboxParams): CloudCreateOptions {
  const refuse: Array<[string, string]> = [
    ['mounts', 'keep data in /workspace, or snapshot() and start from it'],
    ['networkId', 'previews connect sandboxes: sandbox.kosa8.previews.create(port)'],
    ['credentials', 'pass a token in env, or org secrets at create (Kosa8Cloud().sandboxes.create({ secrets }))'],
    ['region', 'Kosa8Cloud().sandboxes.create({ region }) with a kosa8 region id'],
    ['failoverRegions', 'kosa8 places the sandbox in any region unless told one'],
    ['keepLastSnapshots', 'snapshot() makes a durable snapshot; Kosa8Cloud().snapshots lists and deletes them'],
  ];
  for (const [k, alt] of refuse) if (p[k] !== undefined) throw new Unsupported(`vercel Sandbox.create({ ${k} })`, alt);
  const body: CloudCreateOptions = {};
  if (p.source?.type === 'snapshot') {
    if (!p.source.snapshotId.startsWith('snap_')) throw new Unsupported('vercel Sandbox.create({ source: snapshot })', 'a kosa8 snapshot id (snap_…) from sandbox.snapshot()');
    body.snapshot = p.source.snapshotId;
  } else Object.assign(body, templateFor(p.runtime, p.image));
  if (p.resources?.vcpus !== undefined) {
    const size = sizeFor(p.resources.vcpus, p.resources.vcpus * 2);
    if (!size) throw new Unsupported('vercel Sandbox.create({ resources })', 'the largest kosa8 size is 16 vCPU x 32 GiB');
    body.size = size;
  }
  body.ttlS = Math.max(60, Math.round((p.timeout ?? DEFAULT_TIMEOUT_MS) / 1000));
  if (p.name) body.name = p.name;
  if (p.env && Object.keys(p.env).length) body.env = { ...p.env };
  if (p.tags && Object.keys(p.tags).length) body.labels = { ...p.tags };
  if (p.networkPolicy !== undefined && p.networkPolicy !== 'allow-all') body.egress = egressOf(p.networkPolicy);
  if (p.persistent !== undefined) body.persistent = p.persistent;
  return body;
}

const STATUS: Record<string, string> = { running: 'running', creating: 'pending', sleeping: 'stopped', stopped: 'stopped', deleted: 'stopped', error: 'failed' };

/** Vercel's `Sandbox`. `sandbox.kosa8` is the `CloudSandbox` underneath. */
export class Sandbox {
  /** @internal port → public https URL */
  routes = new Map<number, string>();
  private cmds = new Map<string, Command>();
  private n = 0;

  /** @internal */
  constructor(readonly kosa8: CloudSandbox) {}

  get sandboxId(): string {
    return this.kosa8.id;
  }

  get name(): string {
    return this.kosa8.info.name ?? this.kosa8.id;
  }

  get status(): string {
    return STATUS[String(this.kosa8.state)] ?? String(this.kosa8.state);
  }

  get persistent(): boolean {
    return this.kosa8.info.persistent === true;
  }

  get tags(): Record<string, string> | undefined {
    return this.kosa8.info.labels ?? undefined;
  }

  get vcpus(): number | undefined {
    return this.kosa8.info.cpus ?? undefined;
  }

  get memory(): number | undefined {
    return this.kosa8.info.mem_mb ?? undefined;
  }

  get cwd(): string {
    return WORKSPACE;
  }

  get createdAt(): Date {
    return new Date(this.kosa8.info.created_at ?? 0);
  }

  get fs(): never {
    throw new Unsupported('vercel sandbox.fs', 'writeFiles / readFileToBuffer / mkDir on the sandbox, or sandbox.kosa8.files');
  }

  /** Start a sandbox (persistent unless `persistent: false`), clone or unpack `source`, and open `ports`. */
  static async create(params: CreateSandboxParams = {}): Promise<Sandbox & AsyncDisposable> {
    return vc(async () => {
      const cloud = cloudFor('vercel', params.token, ENV_KEYS);
      const box = await createBox(cloud, 'vercel', createBody(params));
      const sb = new Sandbox(box) as Sandbox & AsyncDisposable;
      try {
        await sb.openPorts(params.ports ?? []);
        if (params.source?.type === 'git') await sb.clone(params.source);
        else if (params.source?.type === 'tarball') {
          await mustRun(box, ['sh', '-c', `curl -fsSL ${shq(params.source.url)} | tar -xz -C ${WORKSPACE}`], 'unpacking the tarball');
        }
      } catch (e) {
        await box.delete().catch(() => {});
        throw e;
      }
      return sb;
    });
  }

  private async clone(src: { url: string; depth?: number; revision?: string; username?: string; password?: string }): Promise<void> {
    let url = src.url;
    if (src.username && src.password) {
      const u = new URL(url);
      u.username = encodeURIComponent(src.username);
      u.password = encodeURIComponent(src.password);
      url = u.toString();
    }
    const depth = src.depth ? `--depth ${Math.floor(src.depth)} ` : '';
    let script = `git clone -q ${depth}${shq(url)} ${WORKSPACE}/.k8src && cp -a ${WORKSPACE}/.k8src/. ${WORKSPACE}/ && rm -rf ${WORKSPACE}/.k8src`;
    if (src.revision) script += ` && cd ${WORKSPACE} && git checkout -q ${shq(src.revision)}`;
    await mustRun(this.kosa8, ['sh', '-c', script], 'git clone');
  }

  /** @internal */
  async openPorts(ports: number[]): Promise<void> {
    for (const port of ports) {
      const p = await this.kosa8.previews.create(port, { public: true });
      this.routes.set(port, p.url.replace(/\/$/, ''));
    }
  }

  /** A sandbox by `sandboxId` (sbx_…) or `name`. */
  static async get(params: { sandboxId?: string; name?: string } & Credentials): Promise<Sandbox> {
    return vc(async () => {
      const cloud = cloudFor('vercel', params.token, ENV_KEYS);
      const id = params.sandboxId ?? params.name ?? '';
      let box: CloudSandbox;
      if (id.startsWith('sbx_')) box = await cloud.sandboxes.get(id);
      else {
        const hit = await cloud.sandboxes.list({ name: id });
        if (!hit.length) throw new APIError(`sandbox ${id} not found`, 404);
        box = hit[0]!;
      }
      const sb = new Sandbox(box);
      for (const p of await box.previews.list()) if (p.public && p.url) sb.routes.set(p.port, p.url.replace(/\/$/, ''));
      return sb;
    });
  }

  /** Its sandboxes, as `{ sandboxes }`; `tags` filters. */
  static async list(params: { tags?: Record<string, string> } & Credentials = {}): Promise<{ sandboxes: Array<{ name: string; sandboxId: string; status: string; createdAt: number }> }> {
    return vc(async () => {
      const cloud = cloudFor('vercel', params.token, ENV_KEYS);
      const boxes = await cloud.sandboxes.list(params.tags ? { labels: params.tags } : {});
      return {
        sandboxes: boxes.map((b) => ({ name: b.info.name ?? b.id, sandboxId: b.id, status: STATUS[String(b.state)] ?? String(b.state), createdAt: b.info.created_at ?? 0 })),
      };
    });
  }

  /**
   * Run `cmd` with `args` (no shell) and wait, or with `detached: true`
   * start it and return a `Command`. `stdout` / `stderr` writables get the
   * output as it prints; `timeoutMs` stops it in the sandbox.
   */
  runCommand(command: string, args?: string[], opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<CommandFinished>;
  runCommand(params: RunCommandParams & { detached: true }): Promise<Command>;
  runCommand(params: RunCommandParams): Promise<CommandFinished>;
  async runCommand(a: string | RunCommandParams, args?: string[], opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<Command> {
    const p: RunCommandParams = typeof a === 'string' ? { cmd: a, args: args ?? [], ...opts } : a;
    return vc(async () => {
      if (p.stdin !== undefined && p.stdin !== false) throw new Unsupported('vercel runCommand({ stdin })', 'kosa8 commands take no stdin; write the input with writeFiles and read it');
      let argv = inDir([p.cmd, ...(p.args ?? [])], p.cwd);
      if (p.sudo) argv = ['sh', '-c', 'if [ "$(id -u)" = 0 ]; then exec "$@"; fi; exec sudo -E "$@"', 'sh', ...argv];
      const env = p.env && Object.keys(p.env).length ? { env: p.env } : {};
      if (p.detached) {
        const job = await this.kosa8.execBackground(argv, env);
        const c = new Command(this.kosa8, job.id, job, p.cwd ? absPath(p.cwd) : WORKSPACE);
        this.cmds.set(job.id, c);
        return c;
      }
      const s = await this.kosa8.execStream(argv, {
        ...env,
        ...(p.timeoutMs ? { timeoutS: Math.max(1, Math.ceil(p.timeoutMs / 1000)) } : {}),
        ...(p.signal ? { signal: p.signal } : {}),
      });
      try {
        for await (const c of s) (c.stream === 'stdout' ? p.stdout : p.stderr)?.write(c.text);
      } catch (e) {
        if (!(e instanceof Kosa8ExecTimeoutError || e instanceof Kosa8TimeoutError)) throw e;
        throw new APIError(`command timed out after ${p.timeoutMs} ms`, 504, { cause: e });
      } finally {
        await s.close();
      }
      const id = `cmd_${++this.n}`;
      const done = new CommandFinished(this.kosa8, id, s.exitCode ?? 0, s.stdout, s.stderr, p.cwd ? absPath(p.cwd) : WORKSPACE);
      this.cmds.set(id, done);
      return done;
    });
  }

  /** A command this sandbox ran, or a detached one by its id (bg_…). */
  async getCommand(cmdId: string): Promise<Command> {
    const c = this.cmds.get(cmdId);
    if (c) return c;
    return vc(async () => {
      const job = await this.kosa8.getExec(cmdId);
      return new Command(this.kosa8, job.id, job);
    });
  }

  async mkDir(path: string): Promise<void> {
    await vc(async () => { await this.kosa8.files.mkdir(absPath(path)); });
  }

  async writeFiles(files: Array<{ path: string; content: string | Uint8Array; mode?: number }>): Promise<void> {
    await vc(async () => {
      for (const f of files) {
        const p = absPath(f.path);
        const parent = p.slice(0, p.lastIndexOf('/')) || '/';
        if (parent !== '/' && parent !== WORKSPACE) await this.kosa8.files.mkdir(parent);
        await this.kosa8.files.write(p, toBytes(f.content));
        if (f.mode !== undefined) await mustRun(this.kosa8, ['chmod', f.mode.toString(8), p], 'chmod');
      }
    });
  }

  /** The file's bytes, or null when it is not there. */
  async readFileToBuffer(file: { path: string; cwd?: string }): Promise<Buffer | null> {
    return vc(async () => {
      try {
        return Buffer.from(await this.kosa8.files.read(absPath(file.path, file.cwd ? absPath(file.cwd) : WORKSPACE)));
      } catch (e) {
        if (e instanceof Kosa8NotFoundError) return null;
        throw e;
      }
    });
  }

  /** The file as a Node stream, or null when it is not there. */
  async readFile(file: { path: string; cwd?: string }): Promise<NodeJS.ReadableStream | null> {
    const b = await this.readFileToBuffer(file);
    return b === null ? null : Readable.from([b]);
  }

  /** Save a sandbox file locally; the local path, or null when the file is not there. */
  async downloadFile(src: { path: string; cwd?: string }, dst: { path: string; cwd?: string }, opts: { mkdirRecursive?: boolean } = {}): Promise<string | null> {
    const b = await this.readFileToBuffer(src);
    if (b === null) return null;
    const fs = await localFs();
    const path = await import('node:path');
    const local = path.resolve(dst.cwd ?? '.', dst.path);
    if (opts.mkdirRecursive) await fs.mkdir(path.dirname(local), { recursive: true });
    await fs.writeFile(local, b);
    return local;
  }

  /** The public https URL of a port given in `ports` at create (or `update({ ports })`). */
  domain(p: number): string {
    const url = this.routes.get(p);
    if (!url) throw new APIError(`No route for port ${p}: list it in Sandbox.create({ ports: [${p}] })`);
    return url;
  }

  /** Sleep it: memory, processes and disk are kept, and the next call wakes it. */
  async stop(): Promise<{ status: string }> {
    return vc(async () => {
      if ((await this.kosa8.refresh()).state !== 'sleeping') await this.kosa8.sleep();
      return { status: 'stopped' };
    });
  }

  async delete(): Promise<void> {
    await vc(async () => {
      try {
        await this.kosa8.delete();
      } catch (e) {
        if (!(e instanceof Kosa8NotFoundError)) throw e;
      }
    });
  }

  /** `await using sandbox = await Sandbox.create()` stops it on the way out, as Vercel's. */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.stop();
  }

  /** Add `duration` ms to its lifetime. */
  async extendTimeout(duration: number): Promise<void> {
    await vc(async () => {
      const end = (await this.kosa8.refresh()).info.delete_after;
      const left = typeof end === 'number' ? Math.max(0, end - Date.now()) : 0;
      await this.kosa8.update({ ttlS: Math.max(60, Math.round((left + duration) / 1000)) });
    });
  }

  async updateNetworkPolicy(networkPolicy: NetworkPolicy): Promise<NetworkPolicy> {
    await vc(() => this.kosa8.setEgress(egressOf(networkPolicy)));
    return networkPolicy;
  }

  /** Change its lifetime (`timeout` ms from now), tags, network policy or ports. */
  async update(params: { timeout?: number; tags?: Record<string, string>; networkPolicy?: NetworkPolicy; ports?: number[]; [k: string]: unknown }): Promise<void> {
    const known = new Set(['timeout', 'tags', 'networkPolicy', 'ports']);
    const other = Object.keys(params).filter((k) => !known.has(k) && params[k] !== undefined);
    if (other.length) throw new Unsupported(`vercel sandbox.update({ ${other.join(', ')} })`, 'create a new sandbox with those settings');
    await vc(async () => {
      if (params.timeout !== undefined) await this.kosa8.update({ ttlS: Math.max(60, Math.round(params.timeout / 1000)) });
      if (params.tags) await this.kosa8.setLabels(params.tags);
      if (params.networkPolicy !== undefined) await this.kosa8.setEgress(egressOf(params.networkPolicy));
      if (params.ports) await this.openPorts(params.ports.filter((p) => !this.routes.has(p)));
    });
  }

  /** A durable snapshot (memory and disk); `Sandbox.create({ source: { type: 'snapshot', snapshotId } })` starts from it. */
  async snapshot(_opts: { expiration?: number } = {}): Promise<{ snapshotId: string }> {
    return vc(async () => ({ snapshotId: (await this.kosa8.snapshot()).id }));
  }

  /** An interactive terminal: a wss:// URL. */
  async openInteractive(): Promise<{ url: string; token: string }> {
    return vc(async () => ({ url: (await this.kosa8.terminal()).url, token: '' }));
  }

  asUser(): never {
    throw new Unsupported('vercel sandbox.asUser', 'commands run as the image\'s user; switch user inside the command (su, sudo)');
  }

  async createUser(): Promise<never> {
    throw new Unsupported('vercel sandbox.createUser', 'runCommand({ cmd: "useradd", args: [name], sudo: true })');
  }

  static async fork(): Promise<never> {
    throw new Unsupported('vercel Sandbox.fork', '(await Sandbox.get({ sandboxId })).kosa8.fork(n) makes live copies, memory included');
  }
}

export default Sandbox;

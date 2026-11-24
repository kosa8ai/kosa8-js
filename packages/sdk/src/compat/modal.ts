// Copyright (c) 2026 kosa8. Licensed under the MIT License; see LICENSE.

/**
 * Modal's JavaScript SDK (sandboxes) on kosa8 Cloud: change
 * `import { ModalClient } from 'modal'` to
 * `import { ModalClient } from '@kosa8/sdk/modal'`.
 *
 * Mirrors the sandbox surface of the `modal` npm package 0.11:
 * `new ModalClient()`, `client.apps.fromName`, `client.images.fromRegistry`,
 * `client.sandboxes.create(app, image, params)` / `fromId` / `fromName` /
 * `list`, and on a sandbox `exec` (a `ContainerProcess` whose `stdout` /
 * `stderr` stream as the command prints, with `readText()`, and `wait()`),
 * `terminate`, `wait` / `poll` (for a `command` entrypoint), `tunnels`,
 * `filesystem` (read, write, list, mkdir, remove, stat), tags, network
 * policy and `snapshotFilesystem`. The older `App.lookup(name)` +
 * `app.createSandbox(image)` style works too. Anything else throws
 * `Unsupported`, which names the method and the kosa8 way to do it.
 *
 * The key is a kosa8 Cloud key: `tokenSecret` / `KOSA8_API_KEY`, or
 * `MODAL_TOKEN_SECRET` when it holds a kosa8 key (`k8c_…`).
 *
 * Sandboxes are created persistent (one long-lived container, as Modal's).
 * kosa8 has no apps: an app is a label (`modal.app`) on its sandboxes.
 */

import { Kosa8Error, Kosa8NotFoundError, Kosa8ExecTimeoutError, Kosa8TimeoutError, Kosa8BadRequestError, Kosa8ConflictError, Kosa8RateLimitError } from '../errors.js';
import type { CloudCreateOptions, CloudExecStream, CloudFileInfo, CloudSandbox, Kosa8Cloud } from '../cloud.js';
import type { CloudBackgroundExec } from '../cloud-features.js';
import {
  Unsupported, absPath, bashOrSh, checkUrl, cloudFor, createBox, inDir, localFs, modeBits, setDefaultCloud, sizeFor, statEntry, symbolicMode, toBytes,
} from './common.js';

export { Unsupported, setDefaultCloud };

/** The Modal JS SDK version this module follows. */
export const MIRRORS = { modal: '0.11.2' } as const;

const ENV_KEYS = ['MODAL_TOKEN_SECRET'];
const APP_LABEL = 'modal.app';

// --- errors, as Modal names them ----------------------------------------------------------

export class ModalError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}
export class NotFoundError extends ModalError {}
export class InvalidError extends ModalError {}
export class TimeoutError extends ModalError {}
export class SandboxTimeoutError extends TimeoutError {}
export class AlreadyExistsError extends ModalError {}
export class ResourceExhaustedError extends ModalError {}
export class SandboxFilesystemError extends ModalError {}
export class SandboxFilesystemNotFoundError extends SandboxFilesystemError {}

function convert(e: unknown): unknown {
  if (e instanceof Unsupported || !(e instanceof Kosa8Error)) return e;
  const o = { cause: e };
  if (e instanceof Kosa8ExecTimeoutError || e instanceof Kosa8TimeoutError) return new TimeoutError(e.message, o);
  if (e instanceof Kosa8NotFoundError) return new NotFoundError(e.message, o);
  if (e instanceof Kosa8BadRequestError) return new InvalidError(e.message, o);
  if (e instanceof Kosa8ConflictError) return new AlreadyExistsError(e.message, o);
  if (e instanceof Kosa8RateLimitError) return new ResourceExhaustedError(e.message, o);
  return new ModalError(e.message, o);
}

async function md<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw convert(e);
  }
}

// --- streams ---------------------------------------------------------------------------------

/** Modal's read stream: a ReadableStream with `readText()` and `readBytes()`. */
export interface ModalReadStream<R = string> extends ReadableStream<R> {
  readText(): Promise<string>;
  readBytes(): Promise<Uint8Array>;
}

function readStream<R extends string | Uint8Array>(binary: boolean): { stream: ModalReadStream<R>; push(t: string): void; end(): void } {
  let ctl!: ReadableStreamDefaultController<R>;
  const enc = new TextEncoder();
  const s = new ReadableStream<R>({ start: (c) => { ctl = c; } }) as ModalReadStream<R>;
  const all = async (): Promise<Uint8Array[]> => {
    const parts: Uint8Array[] = [];
    const r = s.getReader();
    for (;;) {
      const { value, done } = await r.read();
      if (done) break;
      parts.push(typeof value === 'string' ? enc.encode(value) : (value as Uint8Array));
    }
    return parts;
  };
  s.readBytes = async () => {
    const parts = await all();
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let i = 0;
    for (const p of parts) { out.set(p, i); i += p.length; }
    return out;
  };
  s.readText = async () => new TextDecoder().decode(await s.readBytes());
  return {
    stream: s,
    push: (t) => ctl.enqueue((binary ? enc.encode(t) : t) as R),
    end: () => { try { ctl.close(); } catch { /* already closed */ } },
  };
}

export interface SandboxExecParams {
  mode?: 'text' | 'binary';
  stdout?: 'pipe' | 'ignore';
  stderr?: 'pipe' | 'ignore';
  /** Working folder (relative to /workspace). */
  workdir?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  secrets?: unknown[];
  pty?: boolean;
}

/**
 * A command running in a sandbox. `stdout` / `stderr` get its output as it
 * prints (a streamed exec, not held to 90 s); `wait()` gives the exit code.
 */
export class ContainerProcess<R extends string | Uint8Array = string> {
  readonly stdout: ModalReadStream<R>;
  readonly stderr: ModalReadStream<R>;
  private readonly done: Promise<number>;
  private code: number | null = null;

  /** @internal */
  constructor(private readonly s: CloudExecStream, params: SandboxExecParams) {
    const bin = params.mode === 'binary';
    const out = readStream<R>(bin), err = readStream<R>(bin);
    this.stdout = out.stream;
    this.stderr = err.stream;
    const keepOut = params.stdout !== 'ignore', keepErr = params.stderr !== 'ignore';
    this.done = (async () => {
      try {
        for await (const c of s) {
          if (c.stream === 'stdout' && keepOut) out.push(c.text);
          else if (c.stream === 'stderr' && keepErr) err.push(c.text);
        }
        this.code = s.exitCode ?? 0;
        return this.code;
      } catch (e) {
        if (e instanceof Kosa8ExecTimeoutError) {
          this.code = -1;
          return this.code;
        }
        throw convert(e);
      } finally {
        out.end();
        err.end();
        await s.close();
      }
    })();
    this.done.catch(() => {});
  }

  get stdin(): never {
    throw new Unsupported('modal ContainerProcess.stdin', 'kosa8 commands take no stdin; write the input to a file with sandbox.filesystem.writeText and read it');
  }

  /** The exit code once it has ended (-1 when stopped at `timeoutMs`). */
  async wait(): Promise<number> {
    return this.done;
  }

  /** The exit code, or null while it runs. */
  async poll(): Promise<number | null> {
    return this.code;
  }

  async closeStdin(): Promise<void> {
    throw new Unsupported('modal ContainerProcess.closeStdin', 'kosa8 commands take no stdin');
  }
}

// --- images, apps, secrets ---------------------------------------------------------------------

/** An image: a registry image, a kosa8 template key, or a snapshot (snapshotFilesystem). */
export class Image {
  /** @internal */
  constructor(readonly tag: string, readonly snapshotId?: string) {}

  get imageId(): string {
    return this.snapshotId ?? this.tag;
  }

  dockerfileCommands(_commands: string[], _params?: unknown): Image {
    throw new Unsupported('modal Image.dockerfileCommands', 'build and push the image yourself, then images.fromRegistry("registry/name:tag"); or install in a persistent sandbox and snapshotFilesystem()');
  }

  /** Nothing to build: kosa8 pulls the image when a sandbox starts. */
  async build(_app?: App): Promise<Image> {
    return this;
  }

  async publish(): Promise<never> {
    throw new Unsupported('modal Image.publish', 'push the image to a registry; or sandbox.snapshotFilesystem() and start from its imageId');
  }
}

export class ImageService {
  /**
   * A registry image (`python:3.12-slim`), or a kosa8 template key
   * (`python`, `node`, `universal-2x4`; no `:` or `/`). A registry secret is
   * not supported.
   */
  fromRegistry(tag: string, secret?: unknown): Image {
    if (secret !== undefined) throw new Unsupported('modal images.fromRegistry(tag, secret)', 'a public image, or a kosa8 org template from your private registry (cloud.orgTemplates)');
    return new Image(tag);
  }

  async fromId(imageId: string): Promise<Image> {
    return imageId.startsWith('snap_') ? new Image('', imageId) : new Image(imageId);
  }

  async fromName(): Promise<never> {
    throw new Unsupported('modal images.fromName', 'images.fromRegistry("registry/name:tag"), or a snapshot id from snapshotFilesystem() with images.fromId');
  }

  fromAwsEcr(): never {
    throw new Unsupported('modal images.fromAwsEcr', 'a kosa8 org template from your private registry (cloud.orgTemplates)');
  }

  fromGcpArtifactRegistry(): never {
    throw new Unsupported('modal images.fromGcpArtifactRegistry', 'a kosa8 org template from your private registry (cloud.orgTemplates)');
  }

  async delete(imageId: string): Promise<void> {
    if (!imageId.startsWith('snap_')) throw new Unsupported('modal images.delete', 'registry images are not stored by kosa8; snapshots are deleted with Kosa8Cloud().snapshots.delete(id)');
  }
}

/** An app. kosa8 has no apps: its sandboxes carry the label modal.app=<name>. */
export class App {
  /** @internal */
  constructor(readonly appId: string, readonly name: string | undefined, private readonly client?: ModalClient) {}

  /** The older Modal JS style: `await App.lookup('my-app', { createIfMissing: true })`. */
  static async lookup(name: string, _params: { createIfMissing?: boolean; environment?: string } = {}): Promise<App> {
    return new App(`ap-${name}`, name, new ModalClient());
  }

  /** The older style: `app.createSandbox(image, params)`. */
  async createSandbox(image: Image, params: SandboxCreateParams = {}): Promise<Sandbox> {
    return (this.client ?? new ModalClient()).sandboxes.create(this, image, params);
  }

  /** The older style: `app.imageFromRegistry(tag)`. */
  async imageFromRegistry(tag: string, secret?: unknown): Promise<Image> {
    return new ImageService().fromRegistry(tag, secret);
  }

  async stop(): Promise<never> {
    throw new Unsupported('modal App.stop', 'terminate its sandboxes: for await (const sb of client.sandboxes.list({ appId })) await sb.terminate()');
  }
}

export class AppService {
  /** @internal */
  constructor(private readonly client: ModalClient) {}

  async fromName(name: string, _params: { createIfMissing?: boolean; environment?: string } = {}): Promise<App> {
    return new App(`ap-${name}`, name, this.client);
  }
}

export class SecretService {
  async fromName(): Promise<never> {
    throw new Unsupported('modal secrets.fromName', 'kosa8 org secrets: Kosa8Cloud().secrets, given to a sandbox at create (sandbox.kosa8 / Kosa8Cloud().sandboxes.create({ secrets }))');
  }

  async fromObject(): Promise<never> {
    return this.fromName();
  }
}

// --- sandboxes -------------------------------------------------------------------------------

export interface SandboxCreateParams {
  cpu?: number;
  cpuLimit?: number;
  memoryMiB?: number;
  memoryLimitMiB?: number;
  runtime?: 'gvisor' | 'vm';
  gpu?: string;
  /** Lifetime (default 5 minutes, as Modal's). */
  timeoutMs?: number;
  /** Idle time before it sleeps. */
  idleTimeoutMs?: number;
  /** Default working folder for exec (relative to /workspace). */
  workdir?: string;
  /** An entrypoint, run in the background; `wait()` / `poll()` follow it. */
  command?: string[];
  env?: Record<string, string>;
  secrets?: unknown[];
  volumes?: Record<string, unknown>;
  cloudBucketMounts?: Record<string, unknown>;
  pty?: boolean;
  encryptedPorts?: number[];
  h2Ports?: number[];
  unencryptedPorts?: number[];
  blockNetwork?: boolean;
  outboundCidrAllowlist?: string[];
  outboundDomainAllowlist?: string[];
  inboundCidrAllowlist?: string[];
  regions?: string[];
  name?: string;
  tags?: Record<string, string>;
  readinessProbe?: unknown;
  customDomain?: string;
  /** false: a plain sandbox (each exec a fresh container, only /workspace kept). Default true. */
  persistent?: boolean;
  [k: string]: unknown;
}

const DEFAULT_TIMEOUT_MS = 300_000;

function createBody(app: App, image: Image, p: SandboxCreateParams): CloudCreateOptions {
  const refuse: Array<[keyof SandboxCreateParams, string]> = [
    ['gpu', 'kosa8 Cloud GPU sandboxes are not open yet'],
    ['secrets', 'kosa8 org secrets: Kosa8Cloud().sandboxes.create({ secrets: [names] }), or env'],
    ['volumes', 'keep data in /workspace, or snapshotFilesystem() and start from it'],
    ['cloudBucketMounts', 'copy data in with filesystem.writeBytes, or fetch it inside the sandbox'],
    ['pty', 'sandbox.kosa8.terminal() gives a wss:// URL for an interactive terminal'],
    ['h2Ports', 'encryptedPorts (an https preview per port)'],
    ['inboundCidrAllowlist', 'private previews: sandbox.kosa8.previews.create(port) gives a signed link'],
    ['readinessProbe', 'poll the port with exec(["sh", "-c", "until nc -z localhost PORT; do sleep 1; done"])'],
    ['customDomain', 'sandbox.kosa8.previews.domains(port) serves a preview at your own hostname'],
    ['proxy', 'sandbox.kosa8.setEgress({ allow: [...] }) for what it may reach'],
  ];
  for (const [k, alt] of refuse) if (p[k] !== undefined && p[k] !== false) throw new Unsupported(`modal sandboxes.create({ ${String(k)} })`, alt);
  if (p.regions && p.regions.length > 1) throw new Unsupported('modal sandboxes.create({ regions: [several] })', 'one region: Kosa8Cloud().sandboxes.create({ region })');
  const body: CloudCreateOptions = {};
  if (image.snapshotId) body.snapshot = image.snapshotId;
  else if (!image.tag.includes(':') && !image.tag.includes('/')) body.template = image.tag;
  else body.image = image.tag;
  const size = sizeFor(p.cpu, p.memoryMiB !== undefined ? p.memoryMiB / 1024 : undefined);
  if (!image.snapshotId && (p.cpu !== undefined || p.memoryMiB !== undefined)) {
    if (!size) throw new Unsupported('modal sandboxes.create({ cpu, memoryMiB })', 'the largest kosa8 size is 16 vCPU x 32 GiB');
    body.size = size;
  }
  body.ttlS = Math.max(60, Math.round((p.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000));
  if (p.idleTimeoutMs !== undefined) body.sleepAfterS = Math.max(0, Math.round(p.idleTimeoutMs / 1000));
  if (p.env && Object.keys(p.env).length) body.env = { ...p.env };
  if (p.name) body.name = p.name;
  body.labels = { ...(p.tags ?? {}), ...(app.name ? { [APP_LABEL]: app.name } : {}) };
  if (!Object.keys(body.labels).length) delete body.labels;
  const allow = [...(p.outboundDomainAllowlist ?? []), ...(p.outboundCidrAllowlist ?? [])];
  if (allow.length) body.egress = { internet: false, allow };
  else if (p.blockNetwork) body.egress = { internet: false };
  if (p.persistent !== undefined) body.persistent = p.persistent;
  if (p.regions?.length === 1 && !image.snapshotId) body.region = p.regions[0]!;
  return body;
}

/** A forwarded port: `url` is its https address. */
export class Tunnel {
  constructor(readonly host: string, readonly port: number, readonly unencryptedHost?: string, readonly unencryptedPort?: number) {}

  get url(): string {
    return this.port === 443 ? `https://${this.host}` : `https://${this.host}:${this.port}`;
  }

  get tlsSocket(): [string, number] {
    return [this.host, this.port];
  }

  get tcpSocket(): [string, number] {
    throw new Unsupported('modal Tunnel.tcpSocket', 'https previews only: tunnel.url');
  }
}

export interface FileInfo {
  readonly name: string;
  readonly path: string;
  readonly type: 'file' | 'directory' | 'symlink';
  readonly size: number;
  readonly mode: number;
  readonly permissions: string;
  readonly owner: string;
  readonly group: string;
  /** Unix epoch seconds. */
  readonly modifiedTime: number;
}

function fileInfo(e: CloudFileInfo): FileInfo {
  const t = e.mod_time ? Date.parse(e.mod_time) : NaN;
  const bits = modeBits(e.mode);
  return {
    name: e.name ?? e.path.split('/').pop() ?? '',
    path: e.path,
    type: e.type === 'dir' ? 'directory' : e.type === 'symlink' ? 'symlink' : 'file',
    size: e.size ?? 0,
    mode: bits,
    permissions: symbolicMode(bits, e.type),
    owner: '',
    group: '',
    modifiedTime: Number.isNaN(t) ? 0 : Math.floor(t / 1000),
  };
}

/** `sandbox.filesystem`. Relative paths are under /workspace. */
export class SandboxFilesystem {
  /** @internal */
  constructor(private readonly box: CloudSandbox) {}

  private async nf<T>(path: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof Kosa8NotFoundError) throw new SandboxFilesystemNotFoundError(`${absPath(path)}: no such file or directory`, { cause: e });
      throw convert(e);
    }
  }

  async readBytes(remotePath: string): Promise<Uint8Array> {
    return this.nf(remotePath, () => this.box.files.read(absPath(remotePath)));
  }

  async readText(remotePath: string): Promise<string> {
    return new TextDecoder().decode(await this.readBytes(remotePath));
  }

  async writeBytes(data: Uint8Array | ArrayBuffer, remotePath: string): Promise<void> {
    await md(async () => { await this.box.files.write(absPath(remotePath), toBytes(data)); });
  }

  async writeText(data: string, remotePath: string): Promise<void> {
    await md(async () => { await this.box.files.write(absPath(remotePath), data); });
  }

  async listFiles(remotePath: string): Promise<FileInfo[]> {
    const p = absPath(remotePath);
    return this.nf(remotePath, async () => (await this.box.files.list(p)).map((e) => fileInfo({ ...e, path: e.path || `${p}/${e.name}` })));
  }

  async makeDirectory(remotePath: string, _options: { createParents?: boolean } = {}): Promise<void> {
    await md(async () => { await this.box.files.mkdir(absPath(remotePath)); });
  }

  async remove(remotePath: string, options: { recursive?: boolean } = {}): Promise<void> {
    await this.nf(remotePath, () => this.box.files.delete(absPath(remotePath), options.recursive ? { recursive: true } : {}));
  }

  async stat(remotePath: string): Promise<FileInfo> {
    return md(async () => {
      const e = await statEntry(this.box, remotePath);
      if (!e) throw new SandboxFilesystemNotFoundError(`${absPath(remotePath)}: no such file or directory`);
      return fileInfo({ ...e, path: e.path || absPath(remotePath) });
    });
  }

  async copyFromLocal(localPath: string, remotePath: string): Promise<void> {
    await this.writeBytes(await (await localFs()).readFile(localPath), remotePath);
  }

  async copyToLocal(remotePath: string, localPath: string): Promise<void> {
    await (await localFs()).writeFile(localPath, await this.readBytes(remotePath));
  }

  async watch(): Promise<never> {
    throw new Unsupported('modal filesystem.watch', 'poll filesystem.listFiles(path) for changes');
  }
}

/** Modal's `Sandbox`. `sb.kosa8` is the `CloudSandbox` underneath. */
export class Sandbox {
  readonly filesystem: SandboxFilesystem;
  /** @internal */
  entry?: CloudBackgroundExec;
  /** @internal */
  ports: number[] = [];

  /** @internal */
  constructor(readonly kosa8: CloudSandbox, private readonly workdir?: string) {
    this.filesystem = new SandboxFilesystem(kosa8);
  }

  get sandboxId(): string {
    return this.kosa8.id;
  }

  /** Run a command; its output streams to `stdout` / `stderr` as it prints. */
  async exec(command: string[], params: SandboxExecParams = {}): Promise<ContainerProcess<any>> {
    return md(async () => {
      if (params.pty) throw new Unsupported('modal sandbox.exec({ pty: true })', 'sandbox.kosa8.terminal() gives a wss:// URL for an interactive terminal');
      if (params.secrets?.length) throw new Unsupported('modal sandbox.exec({ secrets })', 'pass env, or org secrets at create');
      if (!command.length) throw new InvalidError('command must not be empty');
      const argv = inDir(command, params.workdir ?? this.workdir);
      const s = await this.kosa8.execStream(argv, {
        ...(params.env && Object.keys(params.env).length ? { env: params.env } : {}),
        ...(params.timeoutMs ? { timeoutS: Math.max(1, Math.ceil(params.timeoutMs / 1000)) } : {}),
      });
      return new ContainerProcess(s, params);
    });
  }

  /** Delete it. With `{ wait: true }` resolves with the exit code (137, as Modal's terminate). */
  terminate(): Promise<void>;
  terminate(params: { wait: true }): Promise<number>;
  async terminate(params?: { wait?: boolean }): Promise<void | number> {
    await md(async () => {
      try {
        await this.kosa8.delete();
      } catch (e) {
        if (!(e instanceof Kosa8NotFoundError)) throw e;
      }
    });
    return params?.wait ? 137 : undefined;
  }

  /** The entrypoint's exit code once it ends (a sandbox made with `command`). */
  async wait(): Promise<number> {
    return md(async () => {
      if (!this.entry) throw new Unsupported('modal sandbox.wait (no command)', 'kosa8 sandboxes run until terminate() or their timeout; give create a command to wait for');
      const s = await this.entry.wait({ timeoutMs: 86_400_000 });
      return s.exit ?? 0;
    });
  }

  async poll(): Promise<number | null> {
    return md(async () => {
      if (!this.entry) return (await this.kosa8.refresh()).state === 'running' ? null : 0;
      const s = await this.entry.status();
      return s.state === 'exited' ? s.exit ?? 0 : null;
    });
  }

  /** The sandbox's (entrypoint's) output; stdout and stderr come together, in stdout. */
  get stdout(): ModalReadStream<string> {
    if (!this.entry) throw new Unsupported('modal sandbox.stdout (no command)', 'sandbox.exec([...]) and read its stdout');
    const job = this.entry;
    const r = readStream<string>(false);
    void (async () => {
      let seen = 0;
      try {
        for (;;) {
          const s = await job.status();
          const all = s.output ?? '';
          if (all.length > seen) { r.push(all.slice(seen)); seen = all.length; }
          if (s.state === 'exited') break;
          await new Promise((res) => setTimeout(res, 1000));
        }
      } finally {
        r.end();
      }
    })();
    return r.stream;
  }

  get stderr(): never {
    throw new Unsupported('modal sandbox.stderr', 'the entrypoint\'s stdout and stderr come together in sandbox.stdout');
  }

  get stdin(): never {
    throw new Unsupported('modal sandbox.stdin', 'kosa8 commands take no stdin; write the input to a file');
  }

  get logs(): never {
    throw new Unsupported('modal sandbox.logs', 'sandbox.kosa8.logs() (its last commands and output tails)');
  }

  async waitUntilReady(timeoutMs?: number): Promise<void> {
    await md(() => this.kosa8.waitUntilRunning(timeoutMs !== undefined ? { timeoutMs } : {}));
  }

  /** Stop following it here; it keeps running. */
  detach(): void {}

  /** Each port given in `encryptedPorts` / `unencryptedPorts`, at a public https address. */
  async tunnels(_timeoutMs?: number): Promise<Record<number, Tunnel>> {
    return md(async () => {
      const out: Record<number, Tunnel> = {};
      for (const port of this.ports) {
        const p = await this.kosa8.previews.create(port, { public: true });
        out[port] = new Tunnel(p.host || new URL(p.url).host, 443);
      }
      return out;
    });
  }

  async setTags(tags: Record<string, string>): Promise<void> {
    await md(async () => {
      const app = this.kosa8.info.labels?.[APP_LABEL];
      await this.kosa8.setLabels({ ...tags, ...(app ? { [APP_LABEL]: app } : {}) });
    });
  }

  async getTags(): Promise<Record<string, string>> {
    return md(async () => {
      const { [APP_LABEL]: _app, ...rest } = (await this.kosa8.refresh()).info.labels ?? {};
      return rest;
    });
  }

  /** What it may reach: only these CIDRs and domains. */
  async updateNetworkPolicy(params: { outboundCidrAllowlist?: string[]; outboundDomainAllowlist?: string[] }): Promise<void> {
    await md(async () => {
      const allow = [...(params.outboundDomainAllowlist ?? []), ...(params.outboundCidrAllowlist ?? [])];
      await this.kosa8.setEgress(allow.length ? { internet: false, allow } : { internet: false });
    });
  }

  /** A durable snapshot (memory and disk); `sandboxes.create(app, image)` with this image starts from it. */
  async snapshotFilesystem(_params: { timeoutMs?: number } = {}): Promise<Image> {
    return md(async () => new Image('', (await this.kosa8.snapshot()).id));
  }

  /** Sleep it (memory, processes and disk kept). */
  async experimentalPause(): Promise<void> {
    await md(async () => { await this.kosa8.sleep(); });
  }

  async experimentalResume(): Promise<void> {
    await md(async () => { await this.kosa8.wake(); });
  }

  async snapshotDirectory(): Promise<never> {
    throw new Unsupported('modal sandbox.snapshotDirectory', 'snapshotFilesystem() (the whole sandbox)');
  }

  async mountImage(): Promise<never> {
    throw new Unsupported('modal sandbox.mountImage', 'start a sandbox from that image instead');
  }

  async reloadVolumes(): Promise<never> {
    throw new Unsupported('modal sandbox.reloadVolumes', 'kosa8 has no volumes here; /workspace is kept for the sandbox\'s life');
  }

  async createConnectToken(): Promise<never> {
    throw new Unsupported('modal sandbox.createConnectToken', 'sandbox.kosa8.previews.create(port) gives a signed link');
  }
}

export class SandboxService {
  /** @internal */
  constructor(private readonly cloud: Kosa8Cloud) {}

  /** Start a sandbox from `image` (persistent unless `persistent: false`). */
  async create(app: App, image: Image, params: SandboxCreateParams = {}): Promise<Sandbox> {
    return md(async () => {
      const box = await createBox(this.cloud, 'modal', createBody(app, image, params));
      const sb = new Sandbox(box, params.workdir);
      sb.ports = [...(params.encryptedPorts ?? []), ...(params.unencryptedPorts ?? [])];
      try {
        if (params.command?.length) sb.entry = await box.execBackground(inDir(params.command, params.workdir));
      } catch (e) {
        await box.delete().catch(() => {});
        throw e;
      }
      return sb;
    });
  }

  async fromId(sandboxId: string): Promise<Sandbox> {
    return md(async () => new Sandbox(await this.cloud.sandboxes.get(sandboxId)));
  }

  async fromName(appName: string, name: string): Promise<Sandbox> {
    return md(async () => {
      const hit = await this.cloud.sandboxes.list({ name, labels: { [APP_LABEL]: appName } });
      if (!hit.length) throw new NotFoundError(`no sandbox ${name} in app ${appName}`);
      return new Sandbox(hit[0]!);
    });
  }

  /** Running sandboxes; `appId` (ap-<name>) and `tags` filter. */
  async *list(params: { appId?: string; tags?: Record<string, string> } = {}): AsyncGenerator<Sandbox, void, unknown> {
    const labels: Record<string, string> = { ...(params.tags ?? {}) };
    if (params.appId) labels[APP_LABEL] = params.appId.replace(/^ap-/, '');
    const boxes = await md(() => this.cloud.sandboxes.list(Object.keys(labels).length ? { labels } : {}));
    for (const b of boxes) if (b.state === 'running' || b.state === 'creating' || b.state === 'sleeping') yield new Sandbox(b);
  }
}

export interface ModalClientParams {
  tokenId?: string;
  /** A kosa8 Cloud key (k8c_…) here, if anywhere. */
  tokenSecret?: string;
  environment?: string;
  /** Must be a kosa8 address when given. */
  endpoint?: string;
  [k: string]: unknown;
}

/** Modal's client: `const modal = new ModalClient()`. */
export class ModalClient {
  readonly apps: AppService;
  readonly images: ImageService;
  readonly sandboxes: SandboxService;
  readonly secrets: SecretService;
  /** The kosa8 Cloud client underneath. */
  readonly kosa8: Kosa8Cloud;

  constructor(params: ModalClientParams = {}) {
    checkUrl('modal ModalClient({ endpoint })', params.endpoint);
    const secret = params.tokenSecret?.startsWith('k8c_') ? params.tokenSecret : undefined;
    this.kosa8 = cloudFor('modal', secret, ENV_KEYS);
    this.apps = new AppService(this);
    this.images = new ImageService();
    this.sandboxes = new SandboxService(this.kosa8);
    this.secrets = new SecretService();
  }

  get volumes(): never {
    throw new Unsupported('modal client.volumes', 'keep data in /workspace, or snapshotFilesystem()');
  }

  get functions(): never {
    throw new Unsupported('modal client.functions', 'kosa8 functions: Kosa8Cloud().functions.deploy(name, spec)');
  }

  close(): void {}

  version(): string {
    return MIRRORS.modal;
  }
}

/** Run a shell string through bash (or sh): `sb.exec(sh('cd app && make'))`. */
export function sh(cmd: string): string[] {
  return bashOrSh(cmd);
}

export default ModalClient;

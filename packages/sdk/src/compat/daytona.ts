// Copyright (c) 2026 kosa8. Licensed under the MIT License; see LICENSE.

/**
 * Daytona's TypeScript SDK on kosa8 Cloud: change
 * `import { Daytona } from '@daytonaio/sdk'` to
 * `import { Daytona } from '@kosa8/sdk/daytona'`.
 *
 * Mirrors the common surface of `@daytonaio/sdk` 0.233: `new Daytona()`,
 * `create` / `get` / `list` / `start` / `stop` / `delete` / `fork`, and on a
 * sandbox `process.executeCommand`, `process.codeRun`, sessions
 * (`createSession`, `executeSessionCommand`, `getSessionCommandLogs`), `fs`
 * (upload, download, list, folders, delete, move, details, permissions),
 * `getPreviewLink`, `getSignedPreviewUrl`, labels, auto-stop, TTL and network
 * settings. Anything else throws `Unsupported`, which names the method and
 * the kosa8 way to do it; nothing pretends to have worked.
 *
 * The key is a kosa8 Cloud key: `apiKey`, `KOSA8_API_KEY`, or
 * `DAYTONA_API_KEY` when it holds a kosa8 key (`k8c_…`).
 *
 * Sandboxes are created persistent (one long-lived container: packages,
 * $HOME and background processes last, as on Daytona). A session keeps its
 * working folder and exported variables between commands, as Daytona's do.
 * Relative paths are under /workspace.
 */

import { Kosa8Error, Kosa8NotFoundError, Kosa8AuthError, Kosa8RateLimitError, Kosa8ExecTimeoutError, Kosa8TimeoutError, Kosa8BadRequestError, Kosa8ConflictError } from '../errors.js';
import { EXEC_LIMIT_S } from '../cloud.js';
import type { CloudCreateOptions, CloudFileInfo, CloudSandbox, Kosa8Cloud } from '../cloud.js';
import type { CloudEgressPolicy } from '../cloud-features.js';
import {
  Unsupported, WORKSPACE, absPath, bashOrSh, checkUrl, cloudFor, createBox, inDir, localFs, modeBits, mustRun, octalMode, setDefaultCloud, shq, sizeFor, sleep, statEntry, symbolicMode, toBytes,
} from './common.js';

export { Unsupported, setDefaultCloud };

/** The Daytona SDK version this module follows. */
export const MIRRORS = { '@daytonaio/sdk': '0.233.0' } as const;

const ENV_KEYS = ['DAYTONA_API_KEY'];

// --- errors, as Daytona names them --------------------------------------------------------

export class DaytonaError extends Error {
  statusCode?: number;
  code?: string;
  constructor(message: string, statusCode?: number, code?: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
    if (statusCode !== undefined) this.statusCode = statusCode;
    if (code !== undefined) this.code = code;
  }
}
export class DaytonaNotFoundError extends DaytonaError {}
export class DaytonaAuthenticationError extends DaytonaError {}
export class DaytonaRateLimitError extends DaytonaError {}
export class DaytonaTimeoutError extends DaytonaError {}
export class DaytonaBadRequestError extends DaytonaError {}
export class DaytonaConflictError extends DaytonaError {}

function convert(e: unknown): unknown {
  if (e instanceof Unsupported || !(e instanceof Kosa8Error)) return e;
  const o = { cause: e };
  if (e instanceof Kosa8ExecTimeoutError || e instanceof Kosa8TimeoutError) return new DaytonaTimeoutError(e.message, e.status, e.code, o);
  if (e instanceof Kosa8NotFoundError) return new DaytonaNotFoundError(e.message, e.status, e.code, o);
  if (e instanceof Kosa8AuthError) return new DaytonaAuthenticationError(e.message, e.status, e.code, o);
  if (e instanceof Kosa8RateLimitError) return new DaytonaRateLimitError(e.message, e.status, e.code, o);
  if (e instanceof Kosa8BadRequestError) return new DaytonaBadRequestError(e.message, e.status, e.code, o);
  if (e instanceof Kosa8ConflictError) return new DaytonaConflictError(e.message, e.status, e.code, o);
  return new DaytonaError(e.message, e.status, e.code, o);
}

async function dt<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw convert(e);
  }
}

// --- types ---------------------------------------------------------------------------------

export interface DaytonaConfig {
  /** A kosa8 Cloud key (default KOSA8_API_KEY, or DAYTONA_API_KEY when it holds a k8c_ key). */
  apiKey?: string;
  jwtToken?: string;
  organizationId?: string;
  /** Must be a kosa8 address when given. */
  apiUrl?: string;
  serverUrl?: string;
  /** Daytona's region; kosa8 places the sandbox itself, so it is not used. */
  target?: string;
  [k: string]: unknown;
}

export enum CodeLanguage {
  PYTHON = 'python',
  TYPESCRIPT = 'typescript',
  JAVASCRIPT = 'javascript',
}

export interface Resources {
  cpu?: number;
  gpu?: number;
  /** GiB. */
  memory?: number;
  /** GiB. */
  disk?: number;
}

export interface CreateSandboxParams {
  name?: string;
  user?: string;
  language?: CodeLanguage | string;
  envVars?: Record<string, string>;
  labels?: Record<string, string>;
  /** Preview links open without a token. */
  public?: boolean;
  /** Minutes idle before it stops (kosa8: sleeps); 0 never. */
  autoStopInterval?: number;
  autoPauseInterval?: number;
  autoArchiveInterval?: number;
  /** Minutes after it stops before it is deleted. */
  autoDeleteInterval?: number;
  /** Minutes until it is deleted. */
  ttlMinutes?: number;
  volumes?: unknown[];
  networkBlockAll?: boolean;
  /** Comma-separated CIDRs it may reach. */
  networkAllowList?: string;
  /** Comma-separated domains it may reach. */
  domainAllowList?: string;
  /** A kosa8 template key, or a kosa8 snapshot id (snap_…). */
  snapshot?: string;
  /** A registry image (a string); Daytona's declarative `Image` is not supported. */
  image?: string | object;
  resources?: Resources;
  ephemeral?: boolean;
  /** false: a plain sandbox (each command a fresh container, only /workspace kept). Default true. */
  persistent?: boolean;
  [k: string]: unknown;
}

export interface ExecuteResponse {
  exitCode: number;
  /** Everything it printed (stdout, then stderr). */
  result: string;
  artifacts?: { stdout: string; charts?: unknown[] };
}

export interface FileInfo {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  modTime: string;
  mode: string;
  permissions: string;
  owner: string;
  group: string;
}

export interface PortPreviewUrl {
  sandboxId: string;
  url: string;
  token: string;
}

export interface SignedPortPreviewUrl extends PortPreviewUrl {
  port: number;
}

export interface SessionExecuteRequest {
  command: string;
  runAsync?: boolean;
  async?: boolean;
  suppressInputEcho?: boolean;
}

export interface SessionExecuteResponse {
  cmdId: string;
  output?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}

export interface Command {
  id: string;
  command: string;
  exitCode?: number;
}

export interface Session {
  sessionId: string;
  commands: Command[];
}

export class CodeRunParams {
  argv?: string[];
  env?: Record<string, string>;
}

// --- create body ---------------------------------------------------------------------------

function list(csv?: string): string[] {
  return (csv ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

function egressOf(p: { networkBlockAll?: boolean; networkAllowList?: string; domainAllowList?: string }): CloudEgressPolicy | undefined {
  const allow = [...list(p.networkAllowList), ...list(p.domainAllowList)];
  if (allow.length) return { internet: false, allow };
  if (p.networkBlockAll) return { internet: false };
  if (p.networkBlockAll === false) return { internet: true };
  return undefined;
}

function createBody(p: CreateSandboxParams): CloudCreateOptions {
  const refuse: Array<[keyof CreateSandboxParams, string]> = [
    ['user', 'commands run as the image\'s user; switch user inside the command (su, sudo)'],
    ['volumes', 'keep data in /workspace (kept for the sandbox\'s life), or snapshot the sandbox'],
    ['autoPauseInterval', 'autoStopInterval (kosa8 sleeps the sandbox, memory and disk kept)'],
    ['autoArchiveInterval', 'a sleeping kosa8 sandbox is already kept on disk; delete it when done'],
    ['outboundProxyUrl', 'sandbox.kosa8.setEgress({ allow: [...] }) for what it may reach'],
    ['linkedSandbox', 'create the sandboxes separately; previews connect them'],
    ['kvm', 'Kosa8Cloud().sandboxes.create({ size, persistent: true }) on a kvm-capable size'],
  ];
  for (const [k, alt] of refuse) if (p[k] !== undefined) throw new Unsupported(`daytona create({ ${String(k)} })`, alt);
  if (p.image !== undefined && typeof p.image !== 'string') {
    throw new Unsupported('daytona create({ image: Image... })', 'build and push the image yourself, then create({ image: "registry/name:tag" })');
  }
  if (p.resources?.gpu) throw new Unsupported('daytona create({ resources: { gpu } })', 'kosa8 Cloud GPU sandboxes are not open yet');
  const body: CloudCreateOptions = {};
  const lang = String(p.language ?? 'python');
  if (typeof p.image === 'string' && p.image) body.image = p.image;
  else if (p.snapshot?.startsWith('snap_')) body.snapshot = p.snapshot;
  else if (p.snapshot) body.template = p.snapshot;
  // Daytona's default snapshot has Python and Node; kosa8's base has neither.
  else body.template = lang === 'python' ? 'python' : 'node';
  const size = sizeFor(p.resources?.cpu, p.resources?.memory);
  if (p.resources && (p.resources.cpu !== undefined || p.resources.memory !== undefined)) {
    if (!size) throw new Unsupported('daytona create({ resources })', 'the largest kosa8 size is 16 vCPU x 32 GiB');
    body.size = size;
  }
  if (p.resources?.disk !== undefined) body.diskGb = p.resources.disk;
  if (p.name) body.name = p.name;
  if (p.envVars && Object.keys(p.envVars).length) body.env = { ...p.envVars };
  if (p.labels && Object.keys(p.labels).length) body.labels = { ...p.labels };
  if (p.autoStopInterval !== undefined) body.sleepAfterS = Math.max(0, Math.round(p.autoStopInterval * 60));
  if (p.ttlMinutes !== undefined) body.ttlS = Math.max(60, Math.round(p.ttlMinutes * 60));
  else if (p.ephemeral || p.autoDeleteInterval === 0) {
    // Deleted as soon as it stops: delete it when it would have stopped.
    body.ttlS = Math.max(60, Math.round((p.autoStopInterval ?? 15) * 60));
  }
  const eg = egressOf(p);
  if (eg) body.egress = eg;
  if (p.persistent !== undefined) body.persistent = p.persistent;
  return body;
}

// --- process -------------------------------------------------------------------------------

/** Where a session keeps its working folder and exported variables between commands. */
const SESSION_DIR = `${WORKSPACE}/.kosa8-sessions`;

function sessionWrap(sessionId: string, command: string): string {
  const base = `${SESSION_DIR}/${sessionId.replace(/[^A-Za-z0-9_.-]/g, '_')}`;
  const cwd = shq(`${base}.cwd`), envf = shq(`${base}.env`);
  return `mkdir -p ${shq(SESSION_DIR)}; [ -f ${envf} ] && . ${envf}; cd "$(cat ${cwd} 2>/dev/null || echo ${WORKSPACE})" 2>/dev/null || cd ${WORKSPACE}\n` +
    `${command}\n__k8rc=$?; pwd > ${cwd}; export -p > ${envf} 2>/dev/null; exit $__k8rc`;
}

interface SessionCmd {
  id: string;
  command: string;
  exitCode?: number;
  stdout: string;
  stderr: string;
  job?: Awaited<ReturnType<CloudSandbox['execBackground']>>;
}

export class Process {
  private sessions = new Map<string, SessionCmd[]>();

  /** @internal */
  constructor(private readonly box: CloudSandbox, private readonly language: string) {}

  /**
   * Run a shell command and wait. `timeout` (seconds) stops it in the
   * sandbox; over 90 s (or 0, none) it runs as a streamed exec.
   */
  async executeCommand(command: string, cwd?: string, env?: Record<string, string>, timeout?: number): Promise<ExecuteResponse> {
    return dt(async () => this.run(inDir(bashOrSh(command), cwd), env, timeout));
  }

  private async run(argv: string[], env?: Record<string, string>, timeout?: number): Promise<ExecuteResponse> {
    const opts: { env?: Record<string, string>; timeoutS?: number; stream?: boolean } = {};
    if (env && Object.keys(env).length) opts.env = env;
    if (timeout !== undefined && timeout > 0) opts.timeoutS = Math.ceil(timeout);
    if (timeout === 0 || (timeout !== undefined && timeout > EXEC_LIMIT_S)) opts.stream = true;
    const r = await this.box.exec(argv, opts);
    const result = r.stdout + r.stderr;
    return { exitCode: r.exitCode ?? 0, result, artifacts: { stdout: result } };
  }

  /** Run code in the sandbox's language (python, javascript); `typescript` is not supported. */
  async codeRun(code: string, params: CodeRunParams = {}, timeout?: number): Promise<ExecuteResponse> {
    return dt(async () => {
      let argv: string[];
      if (this.language === 'python') argv = ['python3', '-c', code];
      else if (this.language === 'javascript') argv = ['node', '-e', code];
      else throw new Unsupported(`daytona process.codeRun (${this.language})`, 'write the file and run it: executeCommand("npx -y tsx main.ts")');
      return this.run([...argv, ...(params.argv ?? [])], params.env, timeout);
    });
  }

  /** A session: its commands share a working folder and exported variables, as on Daytona. */
  async createSession(sessionId: string): Promise<void> {
    if (this.sessions.has(sessionId)) throw new DaytonaConflictError(`session ${sessionId} already exists`, 409);
    this.sessions.set(sessionId, []);
  }

  async getSession(sessionId: string): Promise<Session> {
    return { sessionId, commands: this.cmds(sessionId).map((c) => this.cmdOut(c)) };
  }

  async listSessions(): Promise<Session[]> {
    return [...this.sessions.keys()].map((sessionId) => ({ sessionId, commands: this.cmds(sessionId).map((c) => this.cmdOut(c)) }));
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.cmds(sessionId);
    this.sessions.delete(sessionId);
  }

  private cmds(sessionId: string): SessionCmd[] {
    const s = this.sessions.get(sessionId);
    if (!s) throw new DaytonaNotFoundError(`session ${sessionId} not found`, 404);
    return s;
  }

  private cmdOut(c: SessionCmd): Command {
    const out: Command = { id: c.id, command: c.command };
    if (c.exitCode !== undefined) out.exitCode = c.exitCode;
    return out;
  }

  /**
   * Run a command in a session. With `runAsync` it starts in the background
   * and `getSessionCommandLogs` follows it (its stdout and stderr together).
   */
  async executeSessionCommand(sessionId: string, req: SessionExecuteRequest, timeout?: number): Promise<SessionExecuteResponse> {
    return dt(async () => {
      const list = this.cmds(sessionId);
      const argv = bashOrSh(sessionWrap(sessionId, req.command));
      if (req.runAsync || req.async) {
        const job = await this.box.execBackground(argv);
        list.push({ id: job.id, command: req.command, stdout: '', stderr: '', job });
        return { cmdId: job.id };
      }
      const r = await this.run(argv, undefined, timeout);
      const id = `cmd_${list.length + 1}`;
      const c: SessionCmd = { id, command: req.command, exitCode: r.exitCode, stdout: r.result, stderr: '' };
      list.push(c);
      return { cmdId: id, output: r.result, stdout: r.result, stderr: '', exitCode: r.exitCode };
    });
  }

  async getSessionCommand(sessionId: string, commandId: string): Promise<Command> {
    return dt(async () => {
      const c = this.find(sessionId, commandId);
      if (c.job && c.exitCode === undefined) {
        const s = await c.job.status();
        if (s.state === 'exited') c.exitCode = s.exit ?? 0;
      }
      return this.cmdOut(c);
    });
  }

  private find(sessionId: string, commandId: string): SessionCmd {
    const c = this.cmds(sessionId).find((x) => x.id === commandId);
    if (!c) throw new DaytonaNotFoundError(`command ${commandId} not found in session ${sessionId}`, 404);
    return c;
  }

  /**
   * A session command's output. With `onStdout` / `onStderr` it follows a
   * running command (polled about once a second) until it ends.
   */
  getSessionCommandLogs(sessionId: string, commandId: string): Promise<{ output?: string; stdout?: string; stderr?: string }>;
  getSessionCommandLogs(sessionId: string, commandId: string, onStdout: (chunk: string) => void, onStderr: (chunk: string) => void): Promise<void>;
  async getSessionCommandLogs(sessionId: string, commandId: string, onStdout?: (chunk: string) => void, _onStderr?: (chunk: string) => void): Promise<unknown> {
    return dt(async () => {
      const c = this.find(sessionId, commandId);
      if (!c.job) {
        if (onStdout) {
          if (c.stdout) onStdout(c.stdout);
          return undefined;
        }
        return { output: c.stdout, stdout: c.stdout, stderr: '' };
      }
      if (!onStdout) {
        const s = await c.job.status();
        if (s.state === 'exited') c.exitCode = s.exit ?? 0;
        const out = s.output ?? '';
        return { output: out, stdout: out, stderr: '' };
      }
      let seen = 0;
      for (;;) {
        const s = await c.job.status();
        const all = s.output ?? '';
        if (all.length > seen) {
          onStdout(all.slice(seen));
          seen = all.length;
        }
        if (s.state === 'exited') {
          c.exitCode = s.exit ?? 0;
          return undefined;
        }
        await sleep(1000);
      }
    });
  }

  async sendSessionCommandInput(): Promise<never> {
    throw new Unsupported('daytona process.sendSessionCommandInput', 'kosa8 commands take no stdin; write the input to a file in /workspace');
  }

  async getEntrypointLogs(): Promise<never> {
    throw new Unsupported('daytona process.getEntrypointLogs', 'start the service with executeSessionCommand(id, { command, runAsync: true }) and read its logs');
  }

  async getEntrypointSession(): Promise<never> {
    return this.getEntrypointLogs();
  }

  async createPty(): Promise<never> {
    throw new Unsupported('daytona process.createPty', 'sandbox.kosa8.terminal() gives a wss:// URL for an interactive terminal');
  }

  async connectPty(): Promise<never> {
    return this.createPty();
  }
}

// --- files ---------------------------------------------------------------------------------

function fileInfo(e: CloudFileInfo): FileInfo {
  const bits = modeBits(e.mode);
  return {
    name: e.name ?? e.path.split('/').pop() ?? '',
    path: e.path,
    isDir: e.type === 'dir',
    size: e.size ?? 0,
    modTime: e.mod_time ?? '',
    // As Daytona's toolbox: mode is ls -l style, permissions octal.
    mode: symbolicMode(bits, e.type),
    permissions: octalMode(bits),
    owner: '',
    group: '',
  };
}

export class FileSystem {
  /** @internal */
  constructor(private readonly box: CloudSandbox) {}

  /** `uploadFile(buffer, remotePath)` or `uploadFile(localPath, remotePath)`. */
  async uploadFile(file: Uint8Array | string, remotePath: string, _timeout?: number): Promise<void> {
    await dt(async () => {
      const data = typeof file === 'string' ? await (await localFs()).readFile(file) : file;
      await this.box.files.write(absPath(remotePath), toBytes(data));
    });
  }

  async uploadFiles(files: Array<{ source: string | Uint8Array; destination: string }>, timeout?: number): Promise<void> {
    for (const f of files) await this.uploadFile(f.source, f.destination, timeout);
  }

  /** `downloadFile(remote)` gives a Buffer; `downloadFile(remote, localPath)` saves it. */
  downloadFile(remotePath: string, timeout?: number): Promise<Buffer>;
  downloadFile(remotePath: string, localPath: string, timeout?: number): Promise<void>;
  async downloadFile(remotePath: string, b?: string | number): Promise<Buffer | void> {
    return dt(async () => {
      const data = await this.box.files.read(absPath(remotePath));
      if (typeof b === 'string') {
        await (await localFs()).writeFile(b, data);
        return undefined;
      }
      return Buffer.from(data);
    });
  }

  async downloadFiles(files: Array<{ source: string; destination?: string }>): Promise<Array<{ source: string; result?: Buffer | string; error?: string }>> {
    const out: Array<{ source: string; result?: Buffer | string; error?: string }> = [];
    for (const f of files) {
      try {
        if (f.destination) {
          await this.downloadFile(f.source, f.destination);
          out.push({ source: f.source, result: f.destination });
        } else out.push({ source: f.source, result: await this.downloadFile(f.source) });
      } catch (e) {
        out.push({ source: f.source, error: (e as Error).message });
      }
    }
    return out;
  }

  async listFiles(path: string, options: { depth?: number } = {}): Promise<FileInfo[]> {
    return dt(async () => {
      if (options.depth !== undefined && options.depth > 1) {
        throw new Unsupported('daytona fs.listFiles({ depth })', 'list each folder, or executeCommand("find PATH -maxdepth N")');
      }
      const p = absPath(path);
      return (await this.box.files.list(p)).map((e) => fileInfo({ ...e, path: e.path || `${p}/${e.name}` }));
    });
  }

  async getFileDetails(path: string): Promise<FileInfo> {
    return dt(async () => {
      const e = await statEntry(this.box, path);
      if (!e) throw new DaytonaNotFoundError(`${absPath(path)} not found`, 404);
      return fileInfo({ ...e, path: e.path || absPath(path) });
    });
  }

  /** Make a folder (and its parents); `mode` such as "755". */
  async createFolder(path: string, mode?: string): Promise<void> {
    await dt(async () => {
      const p = absPath(path);
      await this.box.files.mkdir(p);
      if (mode) await mustRun(this.box, ['chmod', mode, p], 'chmod');
    });
  }

  async deleteFile(path: string, recursive?: boolean): Promise<void> {
    await dt(() => this.box.files.delete(absPath(path), recursive ? { recursive: true } : {}));
  }

  async moveFiles(source: string, destination: string): Promise<void> {
    await dt(() => mustRun(this.box, ['mv', absPath(source), absPath(destination)], 'move'));
  }

  async setFilePermissions(path: string, permissions: { mode?: string; owner?: string; group?: string }): Promise<void> {
    await dt(async () => {
      const p = absPath(path);
      if (permissions.mode) await mustRun(this.box, ['chmod', permissions.mode, p], 'chmod');
      if (permissions.owner || permissions.group) {
        await mustRun(this.box, ['chown', `${permissions.owner ?? ''}${permissions.group ? `:${permissions.group}` : ''}`, p], 'chown');
      }
    });
  }

  async findFiles(): Promise<never> {
    throw new Unsupported('daytona fs.findFiles', 'executeCommand("grep -rn PATTERN PATH")');
  }

  async searchFiles(): Promise<never> {
    throw new Unsupported('daytona fs.searchFiles', 'executeCommand("find PATH -name PATTERN")');
  }

  async replaceInFiles(): Promise<never> {
    throw new Unsupported('daytona fs.replaceInFiles', 'executeCommand("sed -i ...")');
  }

  async downloadFileStream(): Promise<never> {
    throw new Unsupported('daytona fs.downloadFileStream', 'downloadFile(path) (the whole file), or sandbox.kosa8.files.link(path) for a URL');
  }

  async uploadFileStream(): Promise<never> {
    throw new Unsupported('daytona fs.uploadFileStream', "uploadFile(buffer, path), or sandbox.kosa8.files.link(path, { method: 'PUT' })");
  }
}

// --- the sandbox ---------------------------------------------------------------------------

const STATE: Record<string, string> = { running: 'started', creating: 'creating', sleeping: 'stopped', stopped: 'stopped', deleted: 'destroyed', error: 'error' };

/** Daytona's `Sandbox`. `sandbox.kosa8` is the `CloudSandbox` underneath. */
export class Sandbox {
  readonly fs: FileSystem;
  readonly process: Process;
  public: boolean;

  /** @internal */
  constructor(readonly kosa8: CloudSandbox, opts: { language?: string; public?: boolean } = {}) {
    this.fs = new FileSystem(kosa8);
    this.process = new Process(kosa8, opts.language ?? (kosa8.info.template === 'node' ? 'javascript' : 'python'));
    this.public = opts.public ?? false;
  }

  get id(): string {
    return this.kosa8.id;
  }

  get name(): string {
    return this.kosa8.info.name ?? this.kosa8.id;
  }

  get labels(): Record<string, string> {
    return { ...(this.kosa8.info.labels ?? {}) };
  }

  get state(): string {
    return STATE[String(this.kosa8.state)] ?? String(this.kosa8.state);
  }

  get cpu(): number {
    return this.kosa8.info.cpus ?? 0;
  }

  /** GiB. */
  get memory(): number {
    return (this.kosa8.info.mem_mb ?? 0) / 1024;
  }

  get snapshot(): string | undefined {
    return this.kosa8.info.template ?? undefined;
  }

  get git(): never {
    throw new Unsupported('daytona sandbox.git', 'process.executeCommand("git clone ...") in an image with git');
  }

  get computerUse(): never {
    throw new Unsupported('daytona sandbox.computerUse', 'a kosa8-desktop sandbox: Kosa8Cloud().sandboxes.create({ template: "kosa8-desktop" })');
  }

  get codeInterpreter(): never {
    throw new Unsupported('daytona sandbox.codeInterpreter', 'sandbox.kosa8.runCode(code) (a persistent python sandbox)');
  }

  async getUserHomeDir(): Promise<string> {
    return dt(async () => (await mustRun(this.kosa8, ['sh', '-c', 'echo "$HOME"'], 'getUserHomeDir')).trim());
  }

  async getUserRootDir(): Promise<string> {
    return this.getUserHomeDir();
  }

  /** Relative paths and commands start in /workspace. */
  async getWorkDir(): Promise<string> {
    return WORKSPACE;
  }

  async setLabels(labels: Record<string, string>): Promise<Record<string, string>> {
    return dt(() => this.kosa8.setLabels(labels));
  }

  /** Wake it (kosa8 sleep keeps memory and disk). */
  async start(_timeout?: number): Promise<void> {
    await dt(async () => {
      if ((await this.kosa8.refresh()).state === 'sleeping') await this.kosa8.wake();
      await this.kosa8.waitUntilRunning();
    });
  }

  /** Sleep it: kosa8 keeps memory, processes and disk, and charges only for storage. */
  async stop(_timeout?: number, _force?: boolean): Promise<void> {
    await dt(async () => {
      if ((await this.kosa8.refresh()).state !== 'sleeping') await this.kosa8.sleep();
    });
  }

  async pause(): Promise<void> {
    await this.stop();
  }

  async delete(_timeout?: number): Promise<void> {
    await dt(() => this.kosa8.delete());
  }

  async refreshData(): Promise<void> {
    await dt(() => this.kosa8.refresh());
  }

  async refreshActivity(): Promise<void> {
    await this.refreshData();
  }

  async waitUntilStarted(timeout?: number): Promise<void> {
    await dt(() => this.kosa8.waitUntilRunning(timeout !== undefined ? { timeoutMs: timeout * 1000 } : {}));
  }

  /** A live copy, memory included. */
  async fork(_params: { name?: string } = {}, _timeout?: number): Promise<Sandbox> {
    return dt(async () => new Sandbox((await this.kosa8.fork(1))[0]!, { public: this.public }));
  }

  /** A durable snapshot (memory and disk); `daytona.create({ snapshot: id })` starts from it, by its kosa8 id (snap_…). */
  async createSnapshot(name: string): Promise<void> {
    await dt(() => this.kosa8.snapshot(name));
  }

  /** Minutes idle before it sleeps; 0 never. */
  async setAutostopInterval(interval: number): Promise<void> {
    await dt(() => this.kosa8.update({ sleepAfterS: Math.max(0, Math.round(interval * 60)) }));
  }

  /** Minutes from now until it is deleted. */
  async setTtl(ttlMinutes: number): Promise<void> {
    await dt(() => this.kosa8.update({ ttlS: Math.max(60, Math.round(ttlMinutes * 60)) }));
  }

  async setPublic(isPublic: boolean): Promise<void> {
    this.public = isPublic;
  }

  async updateNetworkSettings(settings: { networkBlockAll?: boolean; networkAllowList?: string; domainAllowList?: string }): Promise<void> {
    await dt(async () => {
      const eg = egressOf(settings);
      if (eg) await this.kosa8.setEgress(eg);
    });
  }

  /** The URL of a port (public when the sandbox is public, else a signed link). */
  async getPreviewLink(port: number): Promise<PortPreviewUrl> {
    return dt(async () => {
      const p = await this.kosa8.previews.create(port, { public: this.public });
      return { sandboxId: this.id, url: p.url, token: p.token ?? '' };
    });
  }

  async getSignedPreviewUrl(port: number, expiresInSeconds?: number): Promise<SignedPortPreviewUrl> {
    return dt(async () => {
      const p = await this.kosa8.previews.create(port, expiresInSeconds !== undefined ? { expiresInS: expiresInSeconds } : {});
      return { sandboxId: this.id, port, url: p.url, token: p.token ?? '' };
    });
  }

  async downloadUrl(path: string, ttlSeconds?: number): Promise<string> {
    return dt(async () => (await this.kosa8.files.link(absPath(path), ttlSeconds !== undefined ? { ttlS: ttlSeconds } : {})).url);
  }

  async uploadUrl(path: string, ttlSeconds?: number): Promise<string> {
    return dt(async () => (await this.kosa8.files.link(absPath(path), { method: 'PUT', ...(ttlSeconds !== undefined ? { ttlS: ttlSeconds } : {}) })).url);
  }

  async updateEnv(): Promise<never> {
    throw new Unsupported('daytona sandbox.updateEnv', 'pass env with each command: process.executeCommand(cmd, cwd, env)');
  }

  async updateSecrets(): Promise<never> {
    throw new Unsupported('daytona sandbox.updateSecrets', 'org secrets: Kosa8Cloud().sandboxes.create({ secrets: [...] })');
  }

  async getMetricsLatest(): Promise<never> {
    throw new Unsupported('daytona sandbox.getMetricsLatest', 'sandbox.kosa8.metrics() (kosa8\'s own fields)');
  }

  async archive(): Promise<never> {
    throw new Unsupported('daytona sandbox.archive', 'stop() sleeps it (kept on disk); delete() when done');
  }

  async resize(): Promise<never> {
    throw new Unsupported('daytona sandbox.resize', 'create a new sandbox of the size you need (resources: { cpu, memory })');
  }

  async createLspServer(): Promise<never> {
    throw new Unsupported('daytona sandbox.createLspServer', 'run the language server with process.executeSessionCommand(id, { command, runAsync: true })');
  }

  async createSshAccess(): Promise<never> {
    throw new Unsupported('daytona sandbox.createSshAccess', 'sandbox.kosa8.terminal() gives a wss:// URL for an interactive terminal');
  }
}

/** Daytona's client. */
export class Daytona {
  private readonly cloud: Kosa8Cloud;

  constructor(config: DaytonaConfig = {}) {
    if (config.jwtToken) throw new Unsupported('daytona Daytona({ jwtToken })', 'a kosa8 Cloud key: apiKey or KOSA8_API_KEY');
    checkUrl('daytona Daytona({ apiUrl })', config.apiUrl);
    checkUrl('daytona Daytona({ serverUrl })', config.serverUrl);
    this.cloud = cloudFor('daytona', config.apiKey, ENV_KEYS);
  }

  get volume(): never {
    throw new Unsupported('daytona.volume', 'keep data in /workspace, or snapshot the sandbox');
  }

  get snapshot(): never {
    throw new Unsupported('daytona.snapshot (image builds)', 'build and push an image, then create({ image: "registry/name:tag" }); sandbox.createSnapshot(name) saves a running one');
  }

  /** Start a sandbox (Python by default, persistent unless `persistent: false`). */
  async create(params: CreateSandboxParams = {}, _options: { timeout?: number } = {}): Promise<Sandbox> {
    return dt(async () => {
      const box = await createBox(this.cloud, 'daytona', createBody(params));
      const lang = String(params.language ?? 'python');
      return new Sandbox(box, { language: lang, public: params.public ?? false });
    });
  }

  /** A sandbox by id (sbx_…) or name. */
  async get(sandboxIdOrName: string): Promise<Sandbox> {
    return dt(async () => {
      if (sandboxIdOrName.startsWith('sbx_')) return new Sandbox(await this.cloud.sandboxes.get(sandboxIdOrName));
      const hit = await this.cloud.sandboxes.list({ name: sandboxIdOrName });
      if (!hit.length) throw new DaytonaNotFoundError(`sandbox ${sandboxIdOrName} not found`, 404);
      return new Sandbox(hit[0]!);
    });
  }

  /** Its sandboxes; `labels` filters. */
  async *list(query: { labels?: Record<string, string>; name?: string; limit?: number } = {}): AsyncIterableIterator<Sandbox> {
    const boxes = await dt(() => this.cloud.sandboxes.list({
      ...(query.labels ? { labels: query.labels } : {}),
      ...(query.name ? { name: query.name } : {}),
    }));
    let n = 0;
    for (const b of boxes) {
      if (query.limit !== undefined && n++ >= query.limit) return;
      yield new Sandbox(b);
    }
  }

  async start(sandbox: Sandbox, timeout?: number): Promise<void> {
    await sandbox.start(timeout);
  }

  async stop(sandbox: Sandbox): Promise<void> {
    await sandbox.stop();
  }

  async delete(sandbox: Sandbox, timeout?: number): Promise<void> {
    await sandbox.delete(timeout);
  }

  async fork(sandbox: Sandbox, params?: { name?: string }, timeout?: number): Promise<Sandbox> {
    return sandbox.fork(params, timeout);
  }

  async [Symbol.asyncDispose](): Promise<void> {}
}

export default Daytona;

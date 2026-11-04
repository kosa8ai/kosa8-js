import { CheckpointBook, FileCheckpointStore, type CheckpointStore } from './checkpoints.js';
import { Kosa8Error, Kosa8NotFoundError, Kosa8StreamError, errorFromResponse } from './errors.js';
import { tarContext } from './tar.js';
import { Transport, readAll, type TransportOptions } from './transport.js';
import type {
  CodeResult,
  FileInfo,
  GitOp,
  GitResult,
  Lifecycle,
  Preview,
  SessionInfo,
  ShellResult,
  Template,
  BrokerSpec,
  CaptureSpec,
  Checkpoint,
  Container,
  CreateSandboxResult,
  DeleteSandboxResult,
  DeleteSnapshotResult,
  EgressPolicy,
  EgressStatus,
  ExecResult,
  ExploreBranch,
  ExploreResult,
  ForkResult,
  Frame,
  Health,
  Mount,
  RestoreResult,
  Sandbox,
  Snapshot,
  SnapshotSandboxResult,
  StartSandboxResult,
  StopSandboxResult,
} from './types.js';

/** Options every call accepts. */
export interface CallOptions {
  /**
   * Id of a recorded signed approval for this exact action, sent as
   * X-Kosa8-Approval. Needed only when the org policy requires one; a
   * refusal (Kosa8ApprovalRequiredError) says how a human gets it.
   */
  approval?: string;
  signal?: AbortSignal;
}

export interface Kosa8ClientOptions extends TransportOptions {
  /**
   * Where checkpoint stacks are kept. Default: the kosa8 CLI's own store,
   * `~/.kosa8/checkpoints.json`, so `kosa8 rewind` sees SDK checkpoints.
   */
  checkpointStore?: CheckpointStore;
}

export interface CreateSandboxOptions extends CallOptions {
  /** Sandbox name; the daemon generates one when omitted. */
  name?: string;
  cpus?: number;
  memMb?: number;
  /** Data disk in GB (holds images and everything written inside). 0 = daemon default. */
  diskGb?: number;
  mounts?: Mount[];
  /**
   * Network policy: `'deny'`, `'any'`, `'fakenet'`, `'allow:a.com,b.com'` or
   * `{ allow: ['a.com', '*.b.com', '10.0.0.0/8'] }`. When omitted the daemon
   * applies the org policy's default egress, else `any`.
   */
  egress?: EgressPolicy;
  /** Shorthand for `egress: { allow: [...] }`. */
  egressAllow?: readonly string[];
  /** Start a packet capture from the first frame. */
  capture?: CaptureSpec;
  labels?: Record<string, string>;
  /** Put the sandbox behind an egress broker that adds credentials it never holds. */
  broker?: BrokerSpec;
  /** Stop it after this many idle minutes. */
  autoStopMin?: number;
  /** Stop it this many minutes after creation, in use or not. */
  ttlMin?: number;
  /** Delete it once it has been stopped this many minutes. */
  autoDeleteMin?: number;
  /** Delete it (disk and all) whenever it stops. */
  ephemeral?: boolean;
  /** Start it with a template's image (see `buildTemplate`). */
  template?: string;
}

export interface RunCodeOptions extends CallOptions {
  /** `python` (default), `javascript` or `typescript`. */
  language?: string;
  /** Image to run in; the daemon picks one per language (or the sandbox template's). */
  image?: string;
  env?: Record<string, string>;
  /** Time limit in seconds; past it the run is killed and `timedOut` set. */
  timeoutS?: number;
}

export interface WriteFileOptions extends CallOptions {
  /** Permission bits as octal text, e.g. `0755`. */
  mode?: string;
}

/** The fields of a git op; which ones matter depends on the op. */
export interface GitOptions extends CallOptions {
  /** The repository, in the workspace. */
  path?: string;
  /** clone */
  url?: string;
  branch?: string;
  /** clone --depth */
  depth?: number;
  /** push | pull; default origin */
  remote?: string;
  /** checkout -b */
  create?: boolean;
  /** add: these paths (default everything) */
  files?: string[];
  /** commit */
  message?: string;
  authorName?: string;
  authorEmail?: string;
  /** log: how many (default 20) */
  n?: number;
  /** diff --cached */
  staged?: boolean;
  /** For an https remote that needs credentials. */
  username?: string;
  token?: string;
  /** Image git runs in. */
  image?: string;
}

export interface GitCommitOptions extends Omit<GitOptions, 'path' | 'message'> {
  /** Stage everything first (default true). */
  addAll?: boolean;
}

export interface CreateSessionOptions extends CallOptions {
  image?: string;
  env?: Record<string, string>;
}

export interface SessionExecOptions extends CallOptions {
  /** Time limit in seconds for this command. */
  timeoutS?: number;
}

export interface ShellOptions extends SessionExecOptions {
  /** Session to run in; made on first use. Default `main`. */
  session?: string;
}

export interface StartPtyOptions extends CallOptions {
  image?: string;
  command?: string[];
  cols?: number;
  rows?: number;
  env?: Record<string, string>;
}

export interface CreatePreviewOptions extends CallOptions {
  /** Which session's container serves the port. */
  session?: string;
  /** Or which container. */
  container?: string;
  /** How long the link lives, in seconds. */
  expiresInS?: number;
}

export interface SetLifecycleOptions extends CallOptions {
  autoStopMin?: number;
  autoDeleteMin?: number;
  ttlMin?: number;
  ephemeral?: boolean;
}

export interface BuildTemplateOptions extends CallOptions {
  /** Dockerfile name inside the context (default `Dockerfile`). */
  dockerfile?: string;
  buildArgs?: Record<string, string>;
  /** Network the build sandbox gets (daemon default `any`). */
  egress?: EgressPolicy;
  /** Build again over an existing template of the same name. */
  replace?: boolean;
  /** Build output as it arrives. */
  onOutput?: (chunk: Buffer, stream: string) => void;
}

export interface RunOptions extends CallOptions {
  env?: Record<string, string> | string[];
  onStdout?: (chunk: Buffer) => void;
  onStderr?: (chunk: Buffer) => void;
  /** Progress lines the daemon emits (e.g. "pulling alpine"). */
  onStatus?: (chunk: Buffer) => void;
}

export interface ExecOptions extends CallOptions {
  onStdout?: (chunk: Buffer) => void;
  onStderr?: (chunk: Buffer) => void;
}

export interface ForkOptions extends CallOptions {
  /** Number of copies (default 1). */
  n?: number;
  /** Name prefix; copies are named `<prefix>1`, `<prefix>2`, ... (default `<sandbox>-fork`). */
  prefix?: string;
  /** Raise the copies' classification label above the parent's. */
  label?: string;
}

export interface ExploreOptions extends CallOptions {
  /** Shell commands, one per branch (at least two). */
  variants: string[];
  /** Image the variants run in (default `alpine:latest`). */
  image?: string;
  /** Keep every branch instead of only the winner. */
  keepAll?: boolean;
  /** Keep this branch (by id) instead of the winner. */
  keep?: string;
  /** Per-branch time limit in ms (default 120000). */
  timeoutMs?: number;
  /** Branch name prefix (default `<sandbox>-explore-<n>`). */
  prefix?: string;
  /**
   * Pull `image` into the parent sandbox before forking so every branch has
   * it (a sandbox's engine does not pull on run). Default true.
   */
  pull?: boolean;
}

export interface CheckpointOptions extends CallOptions {
  /** Why it is being taken, e.g. "before the migration". */
  label?: string;
}

export interface CheckpointResult {
  checkpoint: Checkpoint;
  /** Older checkpoints dropped to stay under the cap of 10. */
  evicted: string[];
  snapshot: SnapshotSandboxResult;
}

export interface RewindOptions extends CallOptions {
  /** Checkpoint id or label (default: the most recent). */
  to?: string;
}

export interface RewindResult {
  sandbox: Sandbox;
  checkpoint: Checkpoint;
  /** Checkpoints taken after the one returned to, now deleted. */
  dropped: string[];
  restore_ms: number;
}

export interface RestoreOptions extends CallOptions {
  /** Name for the restored sandbox. */
  name?: string;
  /** Raise the restored sandbox's classification label. */
  label?: string;
  /** Restore a sealed snapshot whose seal does not verify (recorded in the audit log). */
  allowTampered?: boolean;
}

function egressString(egress?: EgressPolicy, allow?: readonly string[]): string | undefined {
  if (allow && allow.length > 0) {
    if (egress !== undefined && egress !== 'deny') {
      throw new Kosa8Error('egressAllow already limits the network to the hosts it lists; do not also set egress');
    }
    return 'allow:' + allow.map((h) => h.trim()).join(',');
  }
  if (egress === undefined) return undefined;
  if (typeof egress === 'string') return egress;
  if (egress.allow.length === 0) {
    throw new Kosa8Error('an egress allow-list needs at least one host; use egress: "deny" for no network');
  }
  return 'allow:' + egress.allow.map((h) => h.trim()).join(',');
}

function envList(env?: Record<string, string> | string[]): string[] | undefined {
  if (!env) return undefined;
  if (Array.isArray(env)) return env;
  return Object.entries(env).map(([k, v]) => `${k}=${v}`);
}

const enc = encodeURIComponent;

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * Typed client for the kosa8 native API over the daemon's unix socket.
 *
 * ```ts
 * const kosa8 = new Kosa8Client();
 * const { sandbox } = await kosa8.createSandbox({ name: 'demo', egress: 'deny' });
 * ```
 */
export class Kosa8Client {
  readonly transport: Transport;
  readonly checkpoints: CheckpointBook;

  constructor(options: Kosa8ClientOptions = {}) {
    this.transport = new Transport(options);
    this.checkpoints = new CheckpointBook(options.checkpointStore ?? new FileCheckpointStore());
  }

  // --- status ---------------------------------------------------------------

  /** GET /kosa8/v1/health: daemon status and version. */
  health(opts: CallOptions = {}): Promise<Health> {
    return this.transport.json<Health>('GET', '/kosa8/v1/health', opts);
  }

  /** The daemon's version string. */
  async version(opts: CallOptions = {}): Promise<string> {
    return (await this.health(opts)).version;
  }

  // --- host engine ------------------------------------------------------------

  /** POST /kosa8/v1/pull: pull an image into the host engine (checked against the registry allow-list). */
  pull(ref: string, opts: CallOptions = {}): Promise<{ ok: boolean; image: string }> {
    return this.transport.json('POST', '/kosa8/v1/pull', { ...opts, body: { ref } });
  }

  // --- sandboxes ---------------------------------------------------------------

  /** GET /kosa8/v1/sandboxes */
  listSandboxes(opts: CallOptions = {}): Promise<Sandbox[]> {
    return this.transport.json<Sandbox[]>('GET', '/kosa8/v1/sandboxes', opts);
  }

  /** Find one sandbox by id or name (from the list; there is no single-sandbox GET). */
  async getSandbox(idOrName: string, opts: CallOptions = {}): Promise<Sandbox | undefined> {
    const list = await this.listSandboxes(opts);
    return list.find((s) => s.id === idOrName) ?? list.find((s) => s.name === idOrName);
  }

  /** POST /kosa8/v1/sandboxes: boot a microVM sandbox. */
  async createSandbox(options: CreateSandboxOptions = {}): Promise<CreateSandboxResult> {
    const body: Record<string, unknown> = {};
    if (options.name) body.name = options.name;
    if (options.cpus) body.cpus = options.cpus;
    if (options.memMb) body.mem_mb = options.memMb;
    if (options.diskGb) body.disk_gb = options.diskGb;
    if (options.mounts) body.mounts = options.mounts;
    const egress = egressString(options.egress, options.egressAllow);
    if (egress !== undefined) body.egress = egress;
    if (options.capture) body.capture = options.capture;
    if (options.labels) body.labels = options.labels;
    if (options.broker) body.broker = options.broker;
    if (options.autoStopMin) body.auto_stop_min = options.autoStopMin;
    if (options.autoDeleteMin) body.auto_delete_min = options.autoDeleteMin;
    if (options.ttlMin) body.ttl_min = options.ttlMin;
    if (options.ephemeral) body.ephemeral = true;
    if (options.template) body.template = options.template;
    return this.transport.json('POST', '/kosa8/v1/sandboxes', {
      body,
      approval: options.approval,
      signal: options.signal,
    });
  }

  /** POST /kosa8/v1/sandboxes/{id}/up: boot a stopped sandbox from its own disk. */
  startSandbox(id: string, opts: CallOptions = {}): Promise<StartSandboxResult> {
    return this.transport.json('POST', `/kosa8/v1/sandboxes/${enc(id)}/up`, opts);
  }

  /** POST /kosa8/v1/sandboxes/{id}/down: stop without deleting (disk kept). */
  stopSandbox(id: string, opts: CallOptions = {}): Promise<StopSandboxResult> {
    return this.transport.json('POST', `/kosa8/v1/sandboxes/${enc(id)}/down`, opts);
  }

  /**
   * DELETE /kosa8/v1/sandboxes/{id}. Like `kosa8 sandbox rm`, the sandbox's
   * checkpoints and their snapshots are dropped too unless
   * `keepCheckpoints` is set.
   */
  async deleteSandbox(
    id: string,
    opts: CallOptions & { wipe?: boolean; keepCheckpoints?: boolean } = {},
  ): Promise<DeleteSandboxResult & { checkpoints_dropped: number }> {
    const out = await this.transport.json<DeleteSandboxResult>('DELETE', `/kosa8/v1/sandboxes/${enc(id)}`, {
      query: { wipe: opts.wipe },
      approval: opts.approval,
      signal: opts.signal,
    });
    let dropped = 0;
    if (!opts.keepCheckpoints) {
      try {
        const ids = await this.checkpoints.forget(id);
        for (const sid of ids) {
          await this.deleteSnapshot(sid, { wipe: opts.wipe, approval: opts.approval }).catch(() => undefined);
        }
        dropped = ids.length;
      } catch {
        /* bookkeeping debris, not a failed delete */
      }
    }
    return { ...out, checkpoints_dropped: dropped };
  }

  /** POST /kosa8/v1/sandboxes/{id}/pull: pull an image into the sandbox's private engine (fetched on the host). */
  pullIntoSandbox(id: string, ref: string, opts: CallOptions = {}): Promise<{ ok: boolean; image: string }> {
    return this.transport.json('POST', `/kosa8/v1/sandboxes/${enc(id)}/pull`, { ...opts, body: { ref } });
  }

  /** GET /kosa8/v1/sandboxes/{id}/images */
  sandboxImages(id: string, opts: CallOptions = {}): Promise<string[]> {
    return this.transport.json('GET', `/kosa8/v1/sandboxes/${enc(id)}/images`, opts);
  }

  /** GET /kosa8/v1/sandboxes/{id}/containers */
  sandboxContainers(id: string, opts: CallOptions = {}): Promise<Container[]> {
    return this.transport.json('GET', `/kosa8/v1/sandboxes/${enc(id)}/containers`, opts);
  }

  /** GET /kosa8/v1/sandboxes/{id}/egress: the policy the host enforces and what it decided. */
  sandboxEgress(id: string, opts: CallOptions = {}): Promise<EgressStatus> {
    return this.transport.json('GET', `/kosa8/v1/sandboxes/${enc(id)}/egress`, opts);
  }

  /**
   * POST /kosa8/v1/sandboxes/{id}/run: run a container to completion inside
   * the sandbox's engine. The image must already be in the sandbox
   * (`pullIntoSandbox`). Resolves with the exit code; a non-zero exit is not
   * an error.
   */
  run(id: string, image: string, args: string[] = [], opts: RunOptions = {}): Promise<ExecResult> {
    return this.collect(
      this.transport.frames('POST', `/kosa8/v1/sandboxes/${enc(id)}/run`, {
        body: { image, args, env: envList(opts.env) },
        approval: opts.approval,
        signal: opts.signal,
      }),
      opts,
    );
  }

  /** POST /kosa8/v1/sandboxes/{id}/start: start a detached container; resolves with its id. */
  async startContainer(id: string, image: string, args: string[] = [], opts: CallOptions = {}): Promise<string> {
    const out = await this.transport.json<{ ok: boolean; id: string }>('POST', `/kosa8/v1/sandboxes/${enc(id)}/start`, {
      ...opts,
      body: { image, args },
    });
    return out.id;
  }

  /** POST /kosa8/v1/sandboxes/{id}/exec: run a command in a running container of the sandbox. */
  exec(id: string, container: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
    return this.collect(this.execFrames(id, container, args, opts), opts);
  }

  /** The raw frame stream of an exec, for callers that want to process output as it arrives. */
  execFrames(id: string, container: string, args: string[], opts: CallOptions = {}): AsyncGenerator<Frame> {
    return this.transport.frames('POST', `/kosa8/v1/sandboxes/${enc(id)}/exec`, {
      body: { container, args },
      approval: opts.approval,
      signal: opts.signal,
    });
  }

  /** POST /kosa8/v1/sandboxes/{id}/start-interactive: start a container with stdin held open. */
  async startInteractive(
    id: string,
    image: string,
    args: string[] = [],
    opts: CallOptions & { env?: Record<string, string> | string[]; tty?: boolean } = {},
  ): Promise<string> {
    const out = await this.transport.json<{ ok: boolean; id: string }>(
      'POST',
      `/kosa8/v1/sandboxes/${enc(id)}/start-interactive`,
      { body: { image, args, env: envList(opts.env), tty: opts.tty ?? false }, approval: opts.approval, signal: opts.signal },
    );
    return out.id;
  }

  /** POST /kosa8/v1/sandboxes/{id}/containers/{cid}/stdin: stream bytes into an interactive container's stdin. */
  writeStdin(
    id: string,
    container: string,
    data: Uint8Array | string | AsyncIterable<Uint8Array | string>,
    opts: CallOptions = {},
  ): Promise<{ ok: boolean }> {
    return this.transport.json('POST', `/kosa8/v1/sandboxes/${enc(id)}/containers/${enc(container)}/stdin`, {
      ...opts,
      rawBody: data,
    });
  }

  /** POST /kosa8/v1/sandboxes/{id}/containers/{cid}/attach: follow a container's output until it exits. */
  attach(id: string, container: string, opts: ExecOptions = {}): Promise<ExecResult> {
    return this.collect(
      this.transport.frames('POST', `/kosa8/v1/sandboxes/${enc(id)}/containers/${enc(container)}/attach`, {
        approval: opts.approval,
        signal: opts.signal,
      }),
      opts,
    );
  }

  // --- snapshots, fork, explore -------------------------------------------------

  /** POST /kosa8/v1/sandboxes/{id}/snapshot: capture memory, processes and disks. */
  snapshot(id: string, opts: CallOptions & { id?: string; encrypt?: boolean } = {}): Promise<SnapshotSandboxResult> {
    const body: Record<string, unknown> = {};
    if (opts.id) body.id = opts.id;
    if (opts.encrypt) body.encrypt = true;
    return this.transport.json('POST', `/kosa8/v1/sandboxes/${enc(id)}/snapshot`, {
      body,
      approval: opts.approval,
      signal: opts.signal,
    });
  }

  /** GET /kosa8/v1/snapshots */
  listSnapshots(opts: CallOptions = {}): Promise<Snapshot[]> {
    return this.transport.json('GET', '/kosa8/v1/snapshots', opts);
  }

  /** POST /kosa8/v1/snapshots/{id}/restore: boot a sandbox from a snapshot, processes resumed. */
  restoreSnapshot(snapshotId: string, opts: RestoreOptions = {}): Promise<RestoreResult> {
    const body: Record<string, unknown> = {};
    if (opts.name) body.name = opts.name;
    if (opts.label) body.label = opts.label;
    if (opts.allowTampered) body.allow_tampered = true;
    return this.transport.json('POST', `/kosa8/v1/snapshots/${enc(snapshotId)}/restore`, {
      body,
      approval: opts.approval,
      signal: opts.signal,
    });
  }

  /** DELETE /kosa8/v1/snapshots/{id} */
  deleteSnapshot(
    snapshotId: string,
    opts: CallOptions & { wipe?: boolean; force?: boolean } = {},
  ): Promise<DeleteSnapshotResult> {
    return this.transport.json('DELETE', `/kosa8/v1/snapshots/${enc(snapshotId)}`, {
      query: { wipe: opts.wipe, force: opts.force },
      approval: opts.approval,
      signal: opts.signal,
    });
  }

  /** POST /kosa8/v1/sandboxes/{id}/fork: N live copies of a running sandbox. */
  fork(id: string, opts: ForkOptions = {}): Promise<ForkResult> {
    const body: Record<string, unknown> = { n: opts.n ?? 1 };
    if (opts.prefix) body.prefix = opts.prefix;
    if (opts.label) body.label = opts.label;
    return this.transport.json('POST', `/kosa8/v1/sandboxes/${enc(id)}/fork`, {
      body,
      approval: opts.approval,
      signal: opts.signal,
    });
  }

  /**
   * Best-of-N, as `kosa8 explore`: fork the sandbox once per variant, run
   * each variant (`sh -c VARIANT` in `image`) in its own branch
   * concurrently, keep the fastest successful branch and delete the rest.
   */
  async explore(id: string, opts: ExploreOptions): Promise<ExploreResult> {
    const variants = opts.variants ?? [];
    if (variants.length < 2) {
      throw new Kosa8Error('give at least two variants; with one there is nothing to compare');
    }
    const image = opts.image ?? 'alpine:latest';
    const call = { approval: opts.approval, signal: opts.signal };
    if (opts.pull !== false) await this.pullIntoSandbox(id, image, call);
    const prefix = opts.prefix ?? `${id}-explore-${Math.floor(Date.now() / 1000) % 100000}`;
    const forked = await this.fork(id, { n: variants.length, prefix, ...call });
    const names = forked.forks.map((f) => f.id).filter((x): x is string => typeof x === 'string');
    if (names.length < variants.length) {
      throw new Kosa8Error(`forked ${names.length} branches for ${variants.length} variants; see listSandboxes() for what was created`);
    }
    const timeoutMs = opts.timeoutMs ?? 120_000;
    const branches = await Promise.all(
      variants.map((v, i) => this.runBranch(names[i]!, image, v, timeoutMs, opts)),
    );
    let winner = '';
    let best = Infinity;
    for (const b of branches) {
      if (!b.error && b.exit === 0 && b.duration_ms < best) {
        winner = b.name;
        best = b.duration_ms;
      }
    }
    if (opts.keep !== undefined) {
      if (!names.includes(opts.keep)) {
        throw new Kosa8Error(`keep ${opts.keep} is not one of the branches (${names.join(', ')}); all of them were kept`);
      }
      winner = opts.keep;
    }
    let removed = 0;
    if (!opts.keepAll) {
      for (const b of branches) {
        if (b.name !== winner) {
          try {
            await this.transport.json('DELETE', `/kosa8/v1/sandboxes/${enc(b.name)}`, { approval: opts.approval });
            removed++;
          } catch {
            /* reported by the count */
          }
        }
      }
    }
    return { parent: id, branches, winner, removed };
  }

  private async runBranch(
    name: string,
    image: string,
    variant: string,
    timeoutMs: number,
    opts: CallOptions,
  ): Promise<ExploreBranch> {
    const start = Date.now();
    const r: ExploreBranch = { name, variant, exit: 0, output: '', duration_ms: 0 };
    // A freshly restored branch can refuse the first connection while its
    // engine settles; retry connection-level failures briefly, as the CLI does.
    for (let attempt = 0; attempt < 4; attempt++) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(new Error(`branch timed out after ${timeoutMs}ms`)), timeoutMs);
      const onAbort = () => ctl.abort(opts.signal?.reason);
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      try {
        let out = '';
        const res = await this.run(name, image, ['sh', '-c', variant], {
          approval: opts.approval,
          signal: ctl.signal,
          onStdout: (c) => (out += c.toString('utf8')),
          onStderr: (c) => (out += c.toString('utf8')),
        });
        r.exit = res.exitCode;
        r.output = out.replace(/\n+$/, '');
        delete r.error;
        break;
      } catch (err) {
        r.error = err instanceof Error ? err.message : String(err);
        if (err instanceof Kosa8StreamError) r.output = (err.stdout + err.stderr).replace(/\n+$/, '');
        const transient = /connection refused|EOF|connection reset|broken pipe|no such file or directory|stream ended|ECONNREFUSED|ECONNRESET|socket hang up/i.test(
          r.error,
        );
        if (!transient || ctl.signal.aborted) break;
        await new Promise((res) => setTimeout(res, (attempt + 1) * 500));
      } finally {
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
      }
    }
    r.duration_ms = Date.now() - start;
    return r;
  }

  // --- checkpoints (client-side over snapshots, as pkg/checkpoint) ---------------

  /**
   * Save a restore point: a snapshot with id `<sandbox>-ckpt-<n>`, recorded on
   * the sandbox's checkpoint stack (the same store `kosa8 checkpoint` uses).
   * The oldest is evicted past 10.
   */
  async checkpoint(sandbox: string, opts: CheckpointOptions = {}): Promise<CheckpointResult> {
    const { id, evict } = await this.checkpoints.nextId(sandbox);
    const snap = await this.snapshot(sandbox, { id, approval: opts.approval, signal: opts.signal });
    // Evict only once the replacement exists.
    for (const old of evict) {
      await this.deleteSnapshot(old, { approval: opts.approval }).catch(() => undefined);
    }
    const checkpoint = await this.checkpoints.record({ id, sandbox, label: opts.label ?? '' }, evict);
    return { checkpoint, evicted: evict, snapshot: snap };
  }

  /** A sandbox's restore points, oldest first. */
  listCheckpoints(sandbox: string): Promise<Checkpoint[]> {
    return this.checkpoints.list(sandbox);
  }

  /**
   * Undo: put the sandbox back to a checkpoint under the same name, processes
   * resumed. Deletes the sandbox, then restores the snapshot with its name;
   * checkpoints taken after the target are discarded. Current state is lost.
   */
  async rewind(sandbox: string, opts: RewindOptions = {}): Promise<RewindResult> {
    const target = opts.to ? await this.checkpoints.resolve(sandbox, opts.to) : await this.checkpoints.latest(sandbox);
    const call = { approval: opts.approval, signal: opts.signal };
    // The sandbox must go first: the restored VM takes its name. A refusal
    // here (policy, approval) leaves everything as it was, and is thrown as is.
    await this.transport.json('DELETE', `/kosa8/v1/sandboxes/${enc(sandbox)}`, call);
    let restored: RestoreResult;
    try {
      restored = await this.restoreSnapshot(target.id, { name: sandbox, ...call });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Kosa8Error(
        `restore failed and ${sandbox} is now stopped: ${msg} — recover with restoreSnapshot(${JSON.stringify(target.id)}, { name: ${JSON.stringify(sandbox)} })`,
        { cause: err },
      );
    }
    let dropped: string[] = [];
    try {
      dropped = await this.checkpoints.pop(sandbox, target.id);
      for (const sid of dropped) await this.deleteSnapshot(sid, { approval: opts.approval }).catch(() => undefined);
    } catch {
      /* bookkeeping */
    }
    return { sandbox: restored.sandbox, checkpoint: target, dropped, restore_ms: restored.restore_ms };
  }

  // --- toolbox: code -------------------------------------------------------------

  /**
   * POST /kosa8/v1/sandboxes/{id}/code: run a Python, JavaScript or
   * TypeScript snippet. It starts in `/workspace`. Charts a Python snippet
   * draws with matplotlib come back in `artifacts` as PNG bytes.
   */
  async runCode(id: string, code: string, opts: RunCodeOptions = {}): Promise<CodeResult> {
    const body: Record<string, unknown> = { language: opts.language ?? 'python', code };
    if (opts.image) body.image = opts.image;
    if (opts.env && Object.keys(opts.env).length > 0) body.env = opts.env;
    if (opts.timeoutS) body.timeout_s = opts.timeoutS;
    const d = await this.transport.json<Record<string, unknown>>('POST', `/kosa8/v1/sandboxes/${enc(id)}/code`, {
      body,
      approval: opts.approval,
      signal: opts.signal,
    });
    const exitCode = num(d.exit);
    const timedOut = d.timed_out === true;
    const arts = Array.isArray(d.artifacts) ? (d.artifacts as Record<string, unknown>[]) : [];
    return {
      ok: exitCode === 0 && !timedOut,
      exitCode,
      stdout: str(d.stdout),
      stderr: str(d.stderr),
      language: str(d.language),
      image: str(d.image),
      artifacts: arts.map((a) => ({ type: str(a.type), name: str(a.name), data: Buffer.from(str(a.data), 'base64') })),
      durationMs: num(d.duration_ms),
      timedOut,
      truncated: d.truncated === true,
    };
  }

  // --- toolbox: files ------------------------------------------------------------

  /** GET …/files: a folder in the workspace (default `/workspace`), or one entry. */
  async listFiles(id: string, path = '/workspace', opts: CallOptions = {}): Promise<FileInfo[]> {
    const d = await this.transport.json<{ files?: FileInfo[] }>('GET', `/kosa8/v1/sandboxes/${enc(id)}/files`, {
      ...opts,
      query: { path },
    });
    return d?.files ?? [];
  }

  /** GET …/files/stat: one entry, not following a symlink. */
  statFile(id: string, path: string, opts: CallOptions = {}): Promise<FileInfo> {
    return this.transport.json('GET', `/kosa8/v1/sandboxes/${enc(id)}/files/stat`, { ...opts, query: { path } });
  }

  /** GET …/files/content: a file's bytes. A body cut short is a Kosa8StreamError. */
  async readFile(id: string, path: string, opts: CallOptions = {}): Promise<Buffer> {
    const p = `/kosa8/v1/sandboxes/${enc(id)}/files/content`;
    const res = await this.transport.raw('GET', p, { query: { path }, signal: opts.signal, approval: opts.approval });
    let data: Buffer;
    try {
      data = await readAll(res.stream, opts.signal);
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      throw new Kosa8StreamError(`${path}: read cut short: ${err instanceof Error ? err.message : String(err)}`,
        { stdout: '', stderr: '' }, { method: 'GET', path: p, cause: err });
    }
    if (res.status >= 400) {
      const text = data.toString('utf8');
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {
        /* keep text */
      }
      throw errorFromResponse(res.status, body, { method: 'GET', path: p });
    }
    const want = res.headers['content-length'];
    if (want !== undefined && Number(want) !== data.length) {
      throw new Kosa8StreamError(`${path}: got ${data.length} of ${want} bytes`, { stdout: '', stderr: '' }, { method: 'GET', path: p });
    }
    return data;
  }

  /** A file's contents as text (UTF-8 by default). */
  async readText(id: string, path: string, opts: CallOptions & { encoding?: BufferEncoding } = {}): Promise<string> {
    return (await this.readFile(id, path, opts)).toString(opts.encoding ?? 'utf8');
  }

  /** PUT …/files/content: replace a file, making its folders. Answers the new entry. */
  writeFile(
    id: string,
    path: string,
    data: Uint8Array | string | AsyncIterable<Uint8Array | string>,
    opts: WriteFileOptions = {},
  ): Promise<FileInfo> {
    return this.transport.json('PUT', `/kosa8/v1/sandboxes/${enc(id)}/files/content`, {
      query: { path, mode: opts.mode },
      rawBody: data,
      approval: opts.approval,
      signal: opts.signal,
    });
  }

  /** DELETE …/files: a file, or with `recursive` a folder and everything in it. */
  deleteFile(id: string, path: string, opts: CallOptions & { recursive?: boolean } = {}): Promise<{ removed: string }> {
    return this.transport.json('DELETE', `/kosa8/v1/sandboxes/${enc(id)}/files`, {
      query: { path, recursive: opts.recursive },
      approval: opts.approval,
      signal: opts.signal,
    });
  }

  /** POST …/files/mkdir: a folder, with its parents. */
  makeDir(id: string, path: string, opts: CallOptions = {}): Promise<FileInfo> {
    return this.transport.json('POST', `/kosa8/v1/sandboxes/${enc(id)}/files/mkdir`, { ...opts, body: { path } });
  }

  /** POST …/files/move: rename or move a file or folder. Answers the entry at `to`. */
  moveFile(id: string, from: string, to: string, opts: CallOptions = {}): Promise<FileInfo> {
    return this.transport.json('POST', `/kosa8/v1/sandboxes/${enc(id)}/files/move`, { ...opts, body: { from, to } });
  }

  // --- toolbox: git ----------------------------------------------------------------

  /**
   * POST …/git: one git operation in the workspace. A git failure resolves
   * with `ok: false`; only a refusal (bad op, no sandbox, policy) throws.
   */
  async git(id: string, op: GitOp | (string & {}), opts: GitOptions = {}): Promise<GitResult> {
    const { approval, signal, authorName, authorEmail, ...fields } = opts;
    const body: Record<string, unknown> = { op };
    for (const [k, v] of Object.entries(fields)) if (v !== undefined) body[k] = v;
    if (authorName !== undefined) body.author_name = authorName;
    if (authorEmail !== undefined) body.author_email = authorEmail;
    const d = await this.transport.json<Record<string, unknown>>('POST', `/kosa8/v1/sandboxes/${enc(id)}/git`, {
      body,
      approval,
      signal,
    });
    const out: GitResult = {
      op: str(d.op) || op,
      ok: d.ok === true,
      exitCode: num(d.exit),
      stdout: str(d.stdout),
      stderr: str(d.stderr),
      path: str(d.path),
    };
    if (d.status) out.status = d.status as GitResult['status'];
    if (d.log) out.log = d.log as GitResult['log'];
    if (d.branches) out.branches = d.branches as GitResult['branches'];
    return out;
  }

  /** Clone `url` into the workspace (into `path`, else a folder named after the repo). */
  gitClone(id: string, url: string, opts: GitOptions = {}): Promise<GitResult> {
    return this.git(id, 'clone', { ...opts, url });
  }

  /** `git status` of the repository at `path`, parsed into `status`. */
  gitStatus(id: string, path: string, opts: GitOptions = {}): Promise<GitResult> {
    return this.git(id, 'status', { ...opts, path });
  }

  /** Stage everything (unless `addAll: false`) and commit. A failed add is returned as is. */
  async gitCommit(id: string, path: string, message: string, opts: GitCommitOptions = {}): Promise<GitResult> {
    const { addAll = true, ...rest } = opts;
    if (addAll) {
      const r = await this.git(id, 'add', { path, image: rest.image, approval: rest.approval, signal: rest.signal });
      if (!r.ok) return r;
    }
    return this.git(id, 'commit', { ...rest, path, message });
  }

  // --- toolbox: shell sessions -------------------------------------------------------

  /** POST …/sessions: a shell that keeps `cd` and `export` between commands. */
  createSession(id: string, name?: string, opts: CreateSessionOptions = {}): Promise<SessionInfo> {
    const body: Record<string, unknown> = {};
    if (name) body.name = name;
    if (opts.image) body.image = opts.image;
    if (opts.env && Object.keys(opts.env).length > 0) body.env = opts.env;
    return this.transport.json('POST', `/kosa8/v1/sandboxes/${enc(id)}/sessions`, {
      body,
      approval: opts.approval,
      signal: opts.signal,
    });
  }

  /** GET …/sessions */
  async listSessions(id: string, opts: CallOptions = {}): Promise<SessionInfo[]> {
    return (await this.transport.json<SessionInfo[] | null>('GET', `/kosa8/v1/sandboxes/${enc(id)}/sessions`, opts)) ?? [];
  }

  /** POST …/sessions/{name}/exec: run one command line in the session. */
  async sessionExec(id: string, session: string, command: string, opts: SessionExecOptions = {}): Promise<ShellResult> {
    const body: Record<string, unknown> = { command };
    if (opts.timeoutS) body.timeout_s = opts.timeoutS;
    const d = await this.transport.json<Record<string, unknown>>(
      'POST',
      `/kosa8/v1/sandboxes/${enc(id)}/sessions/${enc(session)}/exec`,
      { body, approval: opts.approval, signal: opts.signal },
    );
    const exitCode = num(d.exit);
    const timedOut = d.timed_out === true;
    return {
      ok: exitCode === 0 && !timedOut,
      exitCode,
      stdout: str(d.stdout),
      stderr: str(d.stderr),
      cwd: str(d.cwd),
      durationMs: num(d.duration_ms),
      timedOut,
      truncated: d.truncated === true,
    };
  }

  /** Run a command in a session (default `main`), making the session on first use. */
  async shell(id: string, command: string, opts: ShellOptions = {}): Promise<ShellResult> {
    const { session = 'main', ...rest } = opts;
    try {
      return await this.sessionExec(id, session, command, rest);
    } catch (err) {
      if (!(err instanceof Kosa8NotFoundError) || !err.message.includes('no such session')) throw err;
    }
    await this.createSession(id, session, { approval: rest.approval, signal: rest.signal });
    return this.sessionExec(id, session, command, rest);
  }

  /** DELETE …/sessions/{name} */
  deleteSession(id: string, session: string, opts: CallOptions = {}): Promise<{ deleted: string }> {
    return this.transport.json('DELETE', `/kosa8/v1/sandboxes/${enc(id)}/sessions/${enc(session)}`, opts);
  }

  // --- toolbox: terminals ----------------------------------------------------------

  /**
   * POST …/pty: a container with a terminal; resolves with its id. Connect
   * to `/kosa8/v1/sandboxes/{id}/containers/{cid}/tty` with any WebSocket
   * client: binary messages are the terminal, text messages JSON control.
   */
  async startPty(id: string, opts: StartPtyOptions = {}): Promise<string> {
    const body: Record<string, unknown> = {};
    if (opts.image) body.image = opts.image;
    if (opts.command && opts.command.length > 0) body.command = opts.command;
    if (opts.cols && opts.rows) {
      body.cols = opts.cols;
      body.rows = opts.rows;
    }
    if (opts.env && Object.keys(opts.env).length > 0) body.env = opts.env;
    const out = await this.transport.json<{ id: string }>('POST', `/kosa8/v1/sandboxes/${enc(id)}/pty`, {
      body,
      approval: opts.approval,
      signal: opts.signal,
    });
    return out.id;
  }

  /** POST …/containers/{cid}/resize: set a terminal's size. */
  resizePty(id: string, container: string, cols: number, rows: number, opts: CallOptions = {}): Promise<{ ok: boolean }> {
    return this.transport.json('POST', `/kosa8/v1/sandboxes/${enc(id)}/containers/${enc(container)}/resize`, {
      ...opts,
      body: { cols, rows },
    });
  }

  // --- toolbox: previews -----------------------------------------------------------

  /** POST …/previews: a signed link, which expires, to a web server in the sandbox. */
  createPreview(id: string, port: number, opts: CreatePreviewOptions = {}): Promise<Preview> {
    const body: Record<string, unknown> = { port };
    if (opts.session) body.session = opts.session;
    if (opts.container) body.container = opts.container;
    if (opts.expiresInS) body.expires_in_s = opts.expiresInS;
    return this.transport.json('POST', `/kosa8/v1/sandboxes/${enc(id)}/previews`, {
      body,
      approval: opts.approval,
      signal: opts.signal,
    });
  }

  /** POST /kosa8/v1/previews/rotate: end every preview link at once. */
  revokePreviews(opts: CallOptions = {}): Promise<{ ok: boolean; revoked: string }> {
    return this.transport.json('POST', '/kosa8/v1/previews/rotate', opts);
  }

  // --- toolbox: lifecycle ----------------------------------------------------------

  /**
   * POST …/lifecycle: change auto-stop, auto-delete, TTL or ephemeral.
   * Options left out keep their value; 0 (or `false`) turns one off.
   */
  setLifecycle(id: string, opts: SetLifecycleOptions = {}): Promise<Sandbox> {
    const body: Lifecycle = {};
    if (opts.autoStopMin !== undefined) body.auto_stop_min = opts.autoStopMin;
    if (opts.autoDeleteMin !== undefined) body.auto_delete_min = opts.autoDeleteMin;
    if (opts.ttlMin !== undefined) body.ttl_min = opts.ttlMin;
    if (opts.ephemeral !== undefined) body.ephemeral = opts.ephemeral;
    return this.transport.json('POST', `/kosa8/v1/sandboxes/${enc(id)}/lifecycle`, {
      body,
      approval: opts.approval,
      signal: opts.signal,
    });
  }

  // --- toolbox: templates ----------------------------------------------------------

  /** GET /kosa8/v1/templates */
  async listTemplates(opts: CallOptions = {}): Promise<Template[]> {
    return (await this.transport.json<Template[] | null>('GET', '/kosa8/v1/templates', opts)) ?? [];
  }

  /** DELETE /kosa8/v1/templates/{name}. Sandboxes made from it keep their copy. */
  deleteTemplate(name: string, opts: CallOptions = {}): Promise<{ deleted: string }> {
    return this.transport.json('DELETE', `/kosa8/v1/templates/${enc(name)}`, opts);
  }

  /**
   * POST /kosa8/v1/templates: build `contextDir`'s Dockerfile in a throwaway
   * sandbox and keep the image as a template, for `createSandbox({ template })`.
   * The context is packed honouring `.dockerignore`. Resolves with the final
   * frame (`{ done, ok, image }`); a failed build throws Kosa8StreamError.
   */
  async buildTemplate(name: string, contextDir = '.', opts: BuildTemplateOptions = {}): Promise<Frame> {
    const dockerfile = opts.dockerfile ?? 'Dockerfile';
    const q = new URLSearchParams();
    q.append('name', name);
    q.append('dockerfile', dockerfile);
    for (const [k, v] of Object.entries(opts.buildArgs ?? {})) q.append('buildarg', `${k}=${v}`);
    const egress = egressString(opts.egress);
    if (egress) q.append('egress', egress);
    if (opts.replace) q.append('replace', '1');
    const ctx = await tarContext(contextDir, dockerfile);
    let out = '';
    for await (const f of this.transport.frames('POST', `/kosa8/v1/templates?${q.toString()}`, {
      rawBody: ctx,
      approval: opts.approval,
      signal: opts.signal,
    })) {
      if (f.done) {
        if (f.error) throw new Kosa8StreamError(f.error, { stdout: out, stderr: '' }, { daemonMessage: f.error });
        return f;
      }
      if (f.data) {
        out += f.data.toString('utf8');
        opts.onOutput?.(f.data, f.stream ?? 'stdout');
      }
    }
    throw new Kosa8StreamError('template build stream ended without a final frame', { stdout: out, stderr: '' });
  }

  // --- helpers -------------------------------------------------------------------

  /** A handle bound to one sandbox. */
  sandbox(id: string): SandboxHandle {
    return new SandboxHandle(this, id);
  }

  private async collect(
    frames: AsyncGenerator<Frame>,
    opts: { onStdout?: (c: Buffer) => void; onStderr?: (c: Buffer) => void; onStatus?: (c: Buffer) => void },
  ): Promise<ExecResult> {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    for await (const f of frames) {
      if (f.done) {
        const stdoutBytes = Buffer.concat(out);
        const stderrBytes = Buffer.concat(err);
        if (f.error) {
          throw new Kosa8StreamError(f.error, {
            stdout: stdoutBytes.toString('utf8'),
            stderr: stderrBytes.toString('utf8'),
          }, { daemonMessage: f.error });
        }
        return {
          exitCode: typeof f.exit === 'number' ? f.exit : 0,
          stdout: stdoutBytes.toString('utf8'),
          stderr: stderrBytes.toString('utf8'),
          stdoutBytes,
          stderrBytes,
        };
      }
      if (!f.data) continue;
      if (f.stream === 'stderr') {
        err.push(f.data);
        opts.onStderr?.(f.data);
      } else if (f.stream === 'status') {
        opts.onStatus?.(f.data);
      } else {
        out.push(f.data);
        opts.onStdout?.(f.data);
      }
    }
    throw new Kosa8StreamError('stream ended unexpectedly (no final frame)', {
      stdout: Buffer.concat(out).toString('utf8'),
      stderr: Buffer.concat(err).toString('utf8'),
    });
  }
}

/** Convenience wrapper: the client's sandbox methods bound to one sandbox id. */
export class SandboxHandle {
  constructor(
    readonly client: Kosa8Client,
    readonly id: string,
  ) {}

  info(opts?: CallOptions) {
    return this.client.getSandbox(this.id, opts);
  }
  start(opts?: CallOptions) {
    return this.client.startSandbox(this.id, opts);
  }
  stop(opts?: CallOptions) {
    return this.client.stopSandbox(this.id, opts);
  }
  delete(opts?: CallOptions & { wipe?: boolean; keepCheckpoints?: boolean }) {
    return this.client.deleteSandbox(this.id, opts);
  }
  pull(ref: string, opts?: CallOptions) {
    return this.client.pullIntoSandbox(this.id, ref, opts);
  }
  run(image: string, args?: string[], opts?: RunOptions) {
    return this.client.run(this.id, image, args, opts);
  }
  startContainer(image: string, args?: string[], opts?: CallOptions) {
    return this.client.startContainer(this.id, image, args, opts);
  }
  exec(container: string, args: string[], opts?: ExecOptions) {
    return this.client.exec(this.id, container, args, opts);
  }
  containers(opts?: CallOptions) {
    return this.client.sandboxContainers(this.id, opts);
  }
  images(opts?: CallOptions) {
    return this.client.sandboxImages(this.id, opts);
  }
  egress(opts?: CallOptions) {
    return this.client.sandboxEgress(this.id, opts);
  }
  snapshot(opts?: CallOptions & { id?: string; encrypt?: boolean }) {
    return this.client.snapshot(this.id, opts);
  }
  fork(opts?: ForkOptions) {
    return this.client.fork(this.id, opts);
  }
  explore(opts: ExploreOptions) {
    return this.client.explore(this.id, opts);
  }
  checkpoint(opts?: CheckpointOptions) {
    return this.client.checkpoint(this.id, opts);
  }
  checkpoints() {
    return this.client.listCheckpoints(this.id);
  }
  rewind(opts?: RewindOptions) {
    return this.client.rewind(this.id, opts);
  }
  runCode(code: string, opts?: RunCodeOptions) {
    return this.client.runCode(this.id, code, opts);
  }
  listFiles(path?: string, opts?: CallOptions) {
    return this.client.listFiles(this.id, path, opts);
  }
  statFile(path: string, opts?: CallOptions) {
    return this.client.statFile(this.id, path, opts);
  }
  readFile(path: string, opts?: CallOptions) {
    return this.client.readFile(this.id, path, opts);
  }
  readText(path: string, opts?: CallOptions & { encoding?: BufferEncoding }) {
    return this.client.readText(this.id, path, opts);
  }
  writeFile(path: string, data: Uint8Array | string | AsyncIterable<Uint8Array | string>, opts?: WriteFileOptions) {
    return this.client.writeFile(this.id, path, data, opts);
  }
  deleteFile(path: string, opts?: CallOptions & { recursive?: boolean }) {
    return this.client.deleteFile(this.id, path, opts);
  }
  makeDir(path: string, opts?: CallOptions) {
    return this.client.makeDir(this.id, path, opts);
  }
  moveFile(from: string, to: string, opts?: CallOptions) {
    return this.client.moveFile(this.id, from, to, opts);
  }
  git(op: GitOp | (string & {}), opts?: GitOptions) {
    return this.client.git(this.id, op, opts);
  }
  gitClone(url: string, opts?: GitOptions) {
    return this.client.gitClone(this.id, url, opts);
  }
  gitStatus(path: string, opts?: GitOptions) {
    return this.client.gitStatus(this.id, path, opts);
  }
  gitCommit(path: string, message: string, opts?: GitCommitOptions) {
    return this.client.gitCommit(this.id, path, message, opts);
  }
  createSession(name?: string, opts?: CreateSessionOptions) {
    return this.client.createSession(this.id, name, opts);
  }
  sessions(opts?: CallOptions) {
    return this.client.listSessions(this.id, opts);
  }
  sessionExec(session: string, command: string, opts?: SessionExecOptions) {
    return this.client.sessionExec(this.id, session, command, opts);
  }
  shell(command: string, opts?: ShellOptions) {
    return this.client.shell(this.id, command, opts);
  }
  deleteSession(session: string, opts?: CallOptions) {
    return this.client.deleteSession(this.id, session, opts);
  }
  startPty(opts?: StartPtyOptions) {
    return this.client.startPty(this.id, opts);
  }
  resizePty(container: string, cols: number, rows: number, opts?: CallOptions) {
    return this.client.resizePty(this.id, container, cols, rows, opts);
  }
  createPreview(port: number, opts?: CreatePreviewOptions) {
    return this.client.createPreview(this.id, port, opts);
  }
  setLifecycle(opts: SetLifecycleOptions) {
    return this.client.setLifecycle(this.id, opts);
  }
}

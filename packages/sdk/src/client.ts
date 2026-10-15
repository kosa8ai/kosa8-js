import { CheckpointBook, FileCheckpointStore, type CheckpointStore } from './checkpoints.js';
import { Kosa8Error, Kosa8StreamError } from './errors.js';
import { Transport, type TransportOptions } from './transport.js';
import type {
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
}

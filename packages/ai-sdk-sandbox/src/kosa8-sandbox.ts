import { createHash, randomBytes } from 'node:crypto';
import type {
  HarnessV1NetworkPolicy,
  HarnessV1NetworkSandboxSession,
  HarnessV1SandboxProvider,
  HarnessV1SandboxSessionCreateOptions,
  HarnessV1SandboxSessionResumeOptions,
} from '@ai-sdk/harness';
import type { Experimental_SandboxSession as SandboxSession } from '@ai-sdk/provider-utils';
import {
  Kosa8Client,
  Kosa8ConflictError,
  Kosa8NotFoundError,
  type BrokerSpec,
  type EgressPolicy,
  type Kosa8ClientOptions,
  type Mount,
} from '@kosa8/sdk';
import {
  KOSA8_PROVIDER_ID,
  Kosa8NetworkSandboxSession,
  resumeSnapshotId,
  toKosa8Egress,
} from './kosa8-network-sandbox-session.js';
import { Kosa8SandboxSession, restrictedView } from './kosa8-sandbox-session.js';
import { MARKER, shq } from './shell.js';

export const DEFAULT_IMAGE = 'alpine:latest';
export const DEFAULT_WORKING_DIRECTORY = '/workspace';

/** Settings shared by every way of making a kosa8 sandbox session. */
export interface Kosa8SandboxSettings {
  /** A Kosa8Client, or options to build one (socket path, KOSA8_HOST, actor, ...). */
  client?: Kosa8Client | Kosa8ClientOptions;
  /** Image of the container commands run in, inside the sandbox (default `alpine:latest`). */
  image?: string;
  /** Default working directory, created if missing (default `/workspace`). */
  workingDirectory?: string;
  /** Environment for every command (per-call `env` wins). */
  env?: Record<string, string>;
  /**
   * Outbound network policy, mapped onto kosa8's egress allow-list
   * (`allow-all` → any, `deny-all` → deny, `custom` → allow:hosts,cidrs).
   * When neither this nor `egress` is set the daemon decides: the org
   * policy's default egress, else unrestricted.
   */
  networkPolicy?: HarnessV1NetworkPolicy;
  /** kosa8 egress policy directly (`deny`, `any`, `fakenet`, `allow:...` or `{ allow }`). Exclusive with networkPolicy. */
  egress?: EgressPolicy;
  cpus?: number;
  memMb?: number;
  diskGb?: number;
  /** Host directories to expose (they appear in the work container at their guest paths). */
  mounts?: Mount[];
  labels?: Record<string, string>;
  /** Egress broker: named hosts plus credentialed routes the sandbox never holds secrets for. */
  broker?: BrokerSpec;
  /** Shell commands run once on a fresh sandbox, before any template/onFirstCreate. */
  setupCommands?: ReadonlyArray<string>;
  /** Signed-approval id sent with every daemon call (only when the org policy wants one). */
  approval?: string;
}

function clientFrom(c?: Kosa8Client | Kosa8ClientOptions): Kosa8Client {
  return c instanceof Kosa8Client ? c : new Kosa8Client(c ?? {});
}

function egressFrom(s: Kosa8SandboxSettings): string | undefined {
  if (s.networkPolicy && s.egress !== undefined) {
    throw new Error('set networkPolicy or egress, not both');
  }
  if (s.networkPolicy) return toKosa8Egress(s.networkPolicy);
  if (s.egress === undefined) return undefined;
  if (typeof s.egress === 'string') return s.egress;
  return 'allow:' + s.egress.allow.join(',');
}

function slug(s: string, max = 24): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, max);
}

/** The sandbox name used for a harness sessionId (deterministic, so resume finds it). */
export function sandboxNameForSession(sessionId: string): string {
  const h = createHash('sha256').update(sessionId).digest('hex').slice(0, 10);
  const s = slug(sessionId);
  return s ? `aisdk-${s}-${h}` : `aisdk-${h}`;
}

/** Snapshot id a template (or harness identity) is captured under. */
export function templateSnapshotId(identity: string, image: string, egress: string | undefined, workdir: string): string {
  const material = JSON.stringify([1, identity, image, egress ?? '', workdir]);
  const h = createHash('sha256').update(material).digest('hex').slice(0, 24);
  return `aisdk-tpl-${h}`;
}

interface Ctx {
  client: Kosa8Client;
  settings: Kosa8SandboxSettings;
  image: string;
  workdir: string;
  egress?: string;
}

function ctxFrom(settings: Kosa8SandboxSettings): Ctx {
  return {
    client: clientFrom(settings.client),
    settings,
    image: settings.image ?? DEFAULT_IMAGE,
    workdir: settings.workingDirectory ?? DEFAULT_WORKING_DIRECTORY,
    egress: egressFrom(settings),
  };
}

function session(ctx: Ctx, sandbox: string, container: string, egress: string | undefined, ownsLifecycle: boolean) {
  return new Kosa8NetworkSandboxSession({
    client: ctx.client,
    sandbox,
    container,
    image: ctx.image,
    workingDirectory: ctx.workdir,
    env: ctx.settings.env,
    approval: ctx.settings.approval,
    egress,
    ownsLifecycle,
  });
}

/** Pull the image into the sandbox, start the long-lived work container and create the working directory. */
async function startWorkContainer(ctx: Ctx, sandbox: string, signal?: AbortSignal): Promise<string> {
  const { client, settings } = ctx;
  const call = { approval: settings.approval, signal };
  await client.pullIntoSandbox(sandbox, ctx.image, call);
  const id = await client.startContainer(
    sandbox,
    ctx.image,
    ['sh', '-c', `touch ${MARKER} 2>/dev/null; mkdir -p ${shq(ctx.workdir)} 2>/dev/null; while :; do sleep 3600; done`],
    call,
  );
  // The container is started detached; wait until it answers an exec.
  let last: unknown;
  for (let i = 0; i < 50; i++) {
    signal?.throwIfAborted();
    try {
      const r = await client.exec(sandbox, id, ['sh', '-c', `mkdir -p ${shq(ctx.workdir)}`], call);
      if (r.exitCode === 0) return id;
      last = new Error(`could not create ${ctx.workdir}: ${r.stderr.trim() || `exit ${r.exitCode}`}`);
      break;
    } catch (err) {
      last = err;
      await new Promise((res) => setTimeout(res, 200));
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

/** Find the work container of a sandbox this adapter set up (it carries a marker file). */
async function findWorkContainer(ctx: Ctx, sandbox: string, signal?: AbortSignal): Promise<string | undefined> {
  const call = { approval: ctx.settings.approval, signal };
  const list = await ctx.client.sandboxContainers(sandbox, call);
  const running = list.filter((c) => c.status === 'running');
  for (const c of running) {
    try {
      const r = await ctx.client.exec(sandbox, c.id, ['test', '-e', MARKER], call);
      if (r.exitCode === 0) return c.id;
    } catch {
      /* not ours, or not answering */
    }
  }
  return undefined;
}

async function runSetup(ctx: Ctx, s: SandboxSession, signal?: AbortSignal): Promise<void> {
  for (const command of ctx.settings.setupCommands ?? []) {
    signal?.throwIfAborted();
    const r = await s.run({ command, abortSignal: signal });
    if (r.exitCode !== 0) {
      throw new Error(`kosa8 setupCommand failed (exit ${r.exitCode}): ${command}\n${r.stderr}`);
    }
  }
}

/** Boot a fresh sandbox and its work container. Deletes the sandbox if setup fails. */
async function freshSandbox(
  ctx: Ctx,
  name: string | undefined,
  signal: AbortSignal | undefined,
  prepare?: (s: SandboxSession) => Promise<void>,
  templateSnapshot?: string,
): Promise<Kosa8NetworkSandboxSession> {
  const { client, settings } = ctx;
  signal?.throwIfAborted();
  const created = await client.createSandbox({
    name,
    cpus: settings.cpus,
    memMb: settings.memMb,
    diskGb: settings.diskGb,
    mounts: settings.mounts,
    labels: settings.labels,
    broker: settings.broker,
    egress: ctx.egress as EgressPolicy | undefined,
    approval: settings.approval,
    signal,
  });
  const sandbox = created.sandbox.id;
  try {
    const container = await startWorkContainer(ctx, sandbox, signal);
    const s = session(ctx, sandbox, container, created.sandbox.egress ?? ctx.egress, true);
    const restricted = s.restricted();
    await runSetup(ctx, restricted, signal);
    if (prepare) await prepare(restricted);
    if (templateSnapshot) {
      try {
        await client.snapshot(sandbox, { id: templateSnapshot, approval: settings.approval });
      } catch (err) {
        // Another process captured the same template first; theirs is as good.
        if (!(err instanceof Kosa8ConflictError)) throw err;
      }
    }
    return s;
  } catch (err) {
    await client.deleteSandbox(sandbox, { approval: settings.approval }).catch(() => undefined);
    throw err;
  }
}

async function fromTemplate(
  ctx: Ctx,
  name: string | undefined,
  identity: string,
  prepare: (s: SandboxSession) => Promise<void>,
  signal?: AbortSignal,
): Promise<Kosa8NetworkSandboxSession> {
  const snapId = templateSnapshotId(identity, ctx.image, ctx.egress, ctx.workdir);
  const snaps = await ctx.client.listSnapshots({ approval: ctx.settings.approval, signal });
  if (!snaps.some((s) => s.id === snapId)) {
    return freshSandbox(ctx, name, signal, prepare, snapId);
  }
  // Restore the captured template: memory, processes and the work container
  // come back exactly as they were when it was taken.
  const restored = await ctx.client.restoreSnapshot(snapId, {
    name: name ?? `aisdk-${randomBytes(5).toString('hex')}`,
    approval: ctx.settings.approval,
    signal,
  });
  const sandbox = restored.sandbox.id;
  try {
    const container = (await findWorkContainer(ctx, sandbox, signal)) ?? (await startWorkContainer(ctx, sandbox, signal));
    return session(ctx, sandbox, container, restored.sandbox.egress ?? ctx.egress, true);
  } catch (err) {
    await ctx.client.deleteSandbox(sandbox, { approval: ctx.settings.approval }).catch(() => undefined);
    throw err;
  }
}

/** Reattach to an existing sandbox by name. Never creates one. */
async function attach(ctx: Ctx, name: string, signal?: AbortSignal): Promise<Kosa8NetworkSandboxSession> {
  const { client, settings } = ctx;
  const call = { approval: settings.approval, signal };
  const existing = await client.getSandbox(name, call);
  if (existing && existing.state === 'running') {
    const container = (await findWorkContainer(ctx, existing.id, signal)) ?? (await startWorkContainer(ctx, existing.id, signal));
    return session(ctx, existing.id, container, existing.egress, true);
  }
  const snapId = resumeSnapshotId(name);
  const snaps = await client.listSnapshots(call);
  if (snaps.some((s) => s.id === snapId)) {
    // Stopped by stop(): bring back the running machine it was.
    if (existing) await client.deleteSandbox(existing.id, { ...call, keepCheckpoints: true });
    const restored = await client.restoreSnapshot(snapId, { name, ...call });
    await client.deleteSnapshot(snapId, call).catch(() => undefined);
    const sandbox = restored.sandbox.id;
    const container = (await findWorkContainer(ctx, sandbox, signal)) ?? (await startWorkContainer(ctx, sandbox, signal));
    return session(ctx, sandbox, container, restored.sandbox.egress, true);
  }
  if (existing) {
    // Stopped some other way: its disk is intact, but no process is; a new
    // work container starts from the image.
    const up = await client.startSandbox(existing.id, call);
    const container = (await findWorkContainer(ctx, existing.id, signal)) ?? (await startWorkContainer(ctx, existing.id, signal));
    return session(ctx, existing.id, container, up.sandbox.egress, true);
  }
  throw new Kosa8NotFoundError(`no kosa8 sandbox named "${name}" to resume`, { status: 404 });
}

// --- the AI SDK 7 session API --------------------------------------------------

export type Kosa8NetworkSandboxSessionCreateOptions = HarnessV1SandboxSessionCreateOptions<Kosa8SandboxSettings>;
export type Kosa8NetworkSandboxSessionResumeOptions = HarnessV1SandboxSessionResumeOptions<Kosa8SandboxSettings>;

/**
 * Create a kosa8 sandbox and return a network sandbox session for it (pass
 * it to `HarnessAgent.createSession({ sandboxSession })`, or hand
 * `session.restricted()` to AI SDK tools as `experimental_sandbox`).
 *
 * `sandboxId` names the sandbox (creation never resumes; a taken name is an
 * error from the daemon). With `template`, the prepared state is captured as
 * a kosa8 snapshot once and later sessions restore it, processes included.
 */
export async function createKosa8NetworkSandboxSession(
  options: Kosa8NetworkSandboxSessionCreateOptions = {},
): Promise<HarnessV1NetworkSandboxSession & Kosa8NetworkSandboxSession> {
  const { sandboxId, template, abortSignal, ...settings } = options;
  abortSignal?.throwIfAborted();
  const ctx = ctxFrom(settings);
  if (template) {
    return fromTemplate(
      ctx,
      sandboxId,
      template.identity,
      (session) => template.prepare({ session, abortSignal }),
      abortSignal,
    );
  }
  return freshSandbox(ctx, sandboxId, abortSignal);
}

/** Reattach to a kosa8 sandbox created earlier (by `sandboxId`, its name). Never creates one. */
export async function resumeKosa8NetworkSandboxSession(
  options: Kosa8NetworkSandboxSessionResumeOptions,
): Promise<HarnessV1NetworkSandboxSession & Kosa8NetworkSandboxSession> {
  const { sandboxId, abortSignal, ...settings } = options;
  abortSignal?.throwIfAborted();
  return attach(ctxFrom(settings), sandboxId, abortSignal);
}

/**
 * Wrap a sandbox you already run (and, optionally, a container in it) as a
 * network sandbox session. The caller keeps ownership: `stop()` and
 * `destroy()` do nothing.
 */
export async function createKosa8NetworkSandboxSessionFromSandbox(
  options: Kosa8SandboxSettings & { sandbox: string; container?: string; abortSignal?: AbortSignal },
): Promise<HarnessV1NetworkSandboxSession & Kosa8NetworkSandboxSession> {
  const { sandbox, container, abortSignal, ...settings } = options;
  const ctx = ctxFrom(settings);
  const info = await ctx.client.getSandbox(sandbox, { approval: settings.approval, signal: abortSignal });
  if (!info) throw new Kosa8NotFoundError(`no kosa8 sandbox named "${sandbox}"`, { status: 404 });
  const cid =
    container ?? (await findWorkContainer(ctx, info.id, abortSignal)) ?? (await startWorkContainer(ctx, info.id, abortSignal));
  return session(ctx, info.id, cid, info.egress, false);
}

/** Wrap an existing sandbox + container as the restricted (tool-safe) session only. */
export function createKosa8SandboxSessionFromContainer(options: {
  client?: Kosa8Client | Kosa8ClientOptions;
  sandbox: string;
  container: string;
  image?: string;
  workingDirectory?: string;
  env?: Record<string, string>;
  approval?: string;
}): SandboxSession {
  return restrictedView(
    new Kosa8SandboxSession({
      client: clientFrom(options.client),
      sandbox: options.sandbox,
      container: options.container,
      image: options.image ?? 'unknown image',
      workingDirectory: options.workingDirectory ?? DEFAULT_WORKING_DIRECTORY,
      env: options.env,
      approval: options.approval,
    }),
  );
}

// --- the provider API (deprecated in AI SDK 7, kept for HarnessAgent({ sandbox })) ---

/**
 * `HarnessV1SandboxProvider` backed by kosa8, matching the shape of
 * `createE2BSandbox` / `createVercelSandbox`. No I/O at construction.
 *
 * - `createSession({ sessionId })` names the sandbox deterministically so
 *   `resumeSession({ sessionId })` finds it again.
 * - `identity` + `onFirstCreate` run the setup once and capture it as a kosa8
 *   snapshot; later sessions restore it instead of repeating the setup.
 */
export class Kosa8SandboxProvider implements HarnessV1SandboxProvider {
  readonly specificationVersion = 'harness-sandbox-v1' as const;
  readonly providerId = KOSA8_PROVIDER_ID;
  private readonly ctx: Ctx;

  constructor(settings: Kosa8SandboxSettings = {}) {
    this.ctx = ctxFrom(settings);
  }

  createSession = async (options?: {
    sessionId?: string;
    abortSignal?: AbortSignal;
    identity?: string;
    onFirstCreate?: (session: SandboxSession, opts: { abortSignal?: AbortSignal }) => Promise<void>;
  }): Promise<HarnessV1NetworkSandboxSession> => {
    const signal = options?.abortSignal;
    signal?.throwIfAborted();
    const name = options?.sessionId ? sandboxNameForSession(options.sessionId) : undefined;
    const onFirstCreate = options?.onFirstCreate;
    if (options?.identity != null && onFirstCreate) {
      return fromTemplate(this.ctx, name, options.identity, (s) => onFirstCreate(s, { abortSignal: signal }), signal);
    }
    return freshSandbox(this.ctx, name, signal, onFirstCreate ? (s) => onFirstCreate(s, { abortSignal: signal }) : undefined);
  };

  resumeSession = async (options: { sessionId: string; abortSignal?: AbortSignal }): Promise<HarnessV1NetworkSandboxSession> => {
    options.abortSignal?.throwIfAborted();
    return attach(this.ctx, sandboxNameForSession(options.sessionId), options.abortSignal);
  };
}

/** Create a kosa8 sandbox provider (the AI SDK 7 provider shape). */
export function createKosa8Sandbox(settings: Kosa8SandboxSettings = {}): HarnessV1SandboxProvider {
  return new Kosa8SandboxProvider(settings);
}

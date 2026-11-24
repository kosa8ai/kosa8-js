import { createHash } from 'node:crypto';
import type {
  HarnessV1NetworkPolicy,
  HarnessV1NetworkSandboxSession,
  HarnessV1SandboxProvider,
  HarnessV1SandboxTemplate,
} from '@ai-sdk/harness';
import type { Experimental_SandboxSession as SandboxSession } from '@ai-sdk/provider-utils';
import {
  Kosa8Cloud,
  Kosa8ConflictError,
  Kosa8NotFoundError,
  type CloudCreateOptions,
  type CloudEgressPolicy,
  type CloudSandbox,
  type CloudSize,
  type Kosa8CloudOptions,
} from '@kosa8/sdk';
import {
  CLOUD_FILES_ROOT,
  KOSA8_CLOUD_PROVIDER_ID,
  Kosa8CloudNetworkSandboxSession,
  toCloudEgress,
} from './kosa8-cloud-sandbox-session.js';
import { sandboxNameForSession } from './kosa8-sandbox.js';
import { shq } from './shell.js';

/** Settings shared by every way of making a kosa8 Cloud sandbox session. */
export interface Kosa8CloudSandboxSettings {
  /** A `Kosa8Cloud` client, or options to build one. */
  cloud?: Kosa8Cloud | Kosa8CloudOptions;
  /** API key (`k8c_live_…`). Defaults to `KOSA8_API_KEY`. Ignored when `cloud` is a client. */
  apiKey?: string;
  /** API address. Defaults to `KOSA8_CLOUD_URL`, then https://api.kosa8.com. Ignored when `cloud` is a client. */
  baseUrl?: string;
  /** Default working directory, created if missing (default `/workspace`). */
  workingDirectory?: string;
  /** Environment for every command (per-call `env` wins). Sent with each command, never stored in the sandbox. */
  env?: Record<string, string>;
  /** Seconds after which kosa8 Cloud stops a command (1..86400). No limit by default. */
  commandTimeoutS?: number;
  /** Longest wait between polls of a running command, in ms (default 1000). */
  pollIntervalMs?: number;
}

/** What a new kosa8 Cloud sandbox is made from. Everything not set follows the org's settings. */
export interface Kosa8CloudCreateSettings extends Kosa8CloudSandboxSettings {
  /**
   * A kosa8 Cloud template key (`base`, `python`, `node`, ... from
   * `cloud.templates()`, or a kosa8 Store item), or an AI SDK sandbox
   * template (`{ identity, prepare }`): prepared once, kept as a kosa8 Cloud
   * snapshot, and restored by later sessions with the same identity.
   */
  template?: string | HarnessV1SandboxTemplate;
  /** With an AI SDK template: the kosa8 Cloud template key to prepare it on. */
  cloudTemplate?: string;
  /** An OCI image to run (boots cold at a size; needs a payment method). */
  image?: string;
  /** vCPU x GiB: 2x4, 4x8, 8x16 or 16x32. */
  size?: CloudSize | (string & {});
  cpus?: number;
  memMb?: number;
  /** Data disk, 8..200 GiB. */
  diskGb?: number;
  region?: string;
  /** Delete the sandbox this many seconds after it is made (60..7776000). */
  ttlS?: number;
  /** Idle seconds before it sleeps (0 never). */
  sleepAfterS?: number;
  /** One long-lived container: processes left running outlive the command that started them. */
  persistent?: boolean;
  cpu?: 'shared' | 'dedicated';
  /** Org secrets it holds, as placeholders swapped on the way out. */
  secrets?: string[];
  labels?: Record<string, string>;
  /**
   * Outbound network policy, mapped onto kosa8 Cloud egress (`allow-all` →
   * internet, `deny-all` → nothing, `custom` → allow hosts/CIDRs, deny
   * `deniedCIDRs`). Not with `egress`. Neither: the org's default policy.
   */
  networkPolicy?: HarnessV1NetworkPolicy;
  /** kosa8 Cloud egress directly (`{ internet, allow, deny, presets }`). Not with `networkPolicy`. */
  egress?: CloudEgressPolicy;
  /** Shell commands run once on a fresh sandbox, before an AI SDK template's prepare. */
  setupCommands?: ReadonlyArray<string>;
  /**
   * Start in a checkout of a repo from the org's connected GitHub:
   * `"owner/name"`, `"owner/name@ref"` or `{ name, ref, path, depth }`. It is
   * cloned into /workspace/<name> (or `path`), which becomes the working
   * directory unless `workingDirectory` is set. No GitHub token enters the
   * sandbox; `session.sandbox.pullRequest()` sends the changes back.
   */
  repo?: Kosa8CloudRepo;
}

/**
 * A GitHub repo to start from (the same shape as `CloudRepoSpec` in
 * @kosa8/sdk, kept here so older @kosa8/sdk versions still type-check;
 * cloning needs an @kosa8/sdk that sends `repo`).
 */
export type Kosa8CloudRepo = string | { name: string; ref?: string; path?: string; depth?: number };

/** Where a repo spec is cloned: its `path`, else /workspace/<name>. */
export function repoWorkingDirectory(spec: Kosa8CloudRepo): string {
  if (typeof spec === 'object' && spec.path) return spec.path;
  const full = typeof spec === 'string' ? spec.split('@')[0]! : spec.name;
  return `${CLOUD_FILES_ROOT}/${full.split('/').pop()}`;
}

export type Kosa8CloudSandboxSessionCreateOptions = Kosa8CloudCreateSettings & {
  /**
   * A name for the new sandbox (kosa8 Cloud makes its own `sbx_…` id).
   * Creation never resumes: a live sandbox with this name is a conflict.
   */
  sandboxId?: string;
  abortSignal?: AbortSignal;
};

export type Kosa8CloudSandboxSessionResumeOptions = Kosa8CloudSandboxSettings & {
  /** The sandbox's `sbx_…` id, or the name it was created with. */
  sandboxId: string;
  abortSignal?: AbortSignal;
};

function cloudFrom(s: Kosa8CloudSandboxSettings): Kosa8Cloud {
  if (s.cloud instanceof Kosa8Cloud) return s.cloud;
  const opts: Kosa8CloudOptions = { ...(s.cloud ?? {}) };
  if (s.apiKey !== undefined) opts.apiKey = s.apiKey;
  if (s.baseUrl !== undefined) opts.baseUrl = s.baseUrl;
  return new Kosa8Cloud(opts);
}

function egressFrom(s: Kosa8CloudCreateSettings): CloudEgressPolicy | undefined {
  if (s.networkPolicy && s.egress !== undefined) throw new Error('set networkPolicy or egress, not both');
  if (s.networkPolicy) return toCloudEgress(s.networkPolicy);
  return s.egress;
}

/** Snapshot name an AI SDK template is kept under on kosa8 Cloud. */
export function cloudTemplateSnapshotName(identity: string, base: Record<string, unknown>, workdir: string): string {
  const material = JSON.stringify([1, identity, base, workdir]);
  return `aisdk-tpl-${createHash('sha256').update(material).digest('hex').slice(0, 24)}`;
}

function labelOf(box: CloudSandbox): string {
  const i = box.info;
  const what = i.image ? `image ${i.image}` : `the ${i.template} template`;
  return `${what} (${i.cpus} vCPU, ${Math.round((i.mem_mb / 1024) * 10) / 10} GiB)`;
}

function sessionFor(
  s: Kosa8CloudSandboxSettings,
  box: CloudSandbox,
  ownsLifecycle: boolean,
  egress?: CloudEgressPolicy,
): Kosa8CloudNetworkSandboxSession {
  return new Kosa8CloudNetworkSandboxSession({
    box,
    workingDirectory: s.workingDirectory ?? CLOUD_FILES_ROOT,
    env: s.env,
    commandTimeoutS: s.commandTimeoutS,
    pollIntervalMs: s.pollIntervalMs,
    label: labelOf(box),
    egress,
    ownsLifecycle,
  });
}

async function makeWorkdir(session: Kosa8CloudNetworkSandboxSession, workdir: string, signal?: AbortSignal): Promise<void> {
  if (workdir === CLOUD_FILES_ROOT) return;
  const r = await session.sandbox.exec(['sh', '-c', `mkdir -p ${shq(workdir)}`], { signal });
  if (r.exitCode !== 0) throw new Error(`could not create ${workdir}: ${r.stderr.trim() || `exit ${r.exitCode}`}`);
}

async function runSetup(commands: ReadonlyArray<string>, s: SandboxSession, signal?: AbortSignal): Promise<void> {
  for (const command of commands) {
    signal?.throwIfAborted();
    const r = await s.run({ command, abortSignal: signal });
    if (r.exitCode !== 0) throw new Error(`kosa8 setupCommand failed (exit ${r.exitCode}): ${command}\n${r.stderr}`);
  }
}

/** A live (not deleted) sandbox with this name, if any. */
async function byName(cloud: Kosa8Cloud, name: string): Promise<CloudSandbox | undefined> {
  const list = await cloud.sandboxes.list({ name });
  return list.find((b) => b.info.name === name && !['deleted', 'host_removed'].includes(b.state));
}

async function create(
  settings: Kosa8CloudCreateSettings,
  name: string | undefined,
  signal: AbortSignal | undefined,
  prepare?: (s: SandboxSession) => Promise<void>,
  identity?: string,
): Promise<Kosa8CloudNetworkSandboxSession> {
  signal?.throwIfAborted();
  if (settings.repo !== undefined && settings.workingDirectory === undefined) {
    settings = { ...settings, workingDirectory: repoWorkingDirectory(settings.repo) };
  }
  const cloud = cloudFrom(settings);
  const egress = egressFrom(settings);
  const workdir = settings.workingDirectory ?? CLOUD_FILES_ROOT;
  const kosa8Template = typeof settings.template === 'string' ? settings.template : settings.cloudTemplate;
  if (typeof settings.template === 'string' && settings.cloudTemplate !== undefined) {
    throw new Error('set template (a kosa8 Cloud template key) or cloudTemplate, not both');
  }
  if (name !== undefined && (await byName(cloud, name))) {
    throw new Kosa8ConflictError(`a kosa8 Cloud sandbox named "${name}" already exists; resume it instead`, { status: 409 });
  }
  const common: CloudCreateOptions = {
    name,
    region: settings.region,
    ttlS: settings.ttlS,
    sleepAfterS: settings.sleepAfterS,
    secrets: settings.secrets,
    egress,
    ...(settings.repo !== undefined ? ({ repo: settings.repo } as Partial<CloudCreateOptions>) : {}),
  };
  const sized: CloudCreateOptions = {
    template: kosa8Template,
    image: settings.image,
    size: settings.size,
    cpus: settings.cpus,
    memMb: settings.memMb,
    diskGb: settings.diskGb,
    persistent: settings.persistent,
    cpu: settings.cpu,
  };
  const strip = (o: CloudCreateOptions) =>
    Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as CloudCreateOptions;

  // An AI SDK template prepared before: start from its snapshot.
  let snapName: string | undefined;
  if (identity !== undefined) {
    snapName = cloudTemplateSnapshotName(identity, strip(sized) as Record<string, unknown>, workdir);
    const snaps = await cloud.snapshots.list();
    const ready = snaps.find((x) => x.name === snapName && x.state === 'ready');
    if (ready) {
      const box = await cloud.sandboxes.create(strip({ ...common, snapshot: ready.id }));
      try {
        if (settings.labels) await box.setLabels(settings.labels);
        return sessionFor(settings, box, true, egress);
      } catch (err) {
        await box.delete().catch(() => undefined);
        throw err;
      }
    }
  }

  signal?.throwIfAborted();
  const box = await cloud.sandboxes.create(strip({ ...common, ...sized }));
  try {
    // Labels are a second call; set here so a failure still deletes the sandbox.
    if (settings.labels) await box.setLabels(settings.labels);
    const session = sessionFor(settings, box, true, egress);
    await makeWorkdir(session, workdir, signal);
    const restricted = session.restricted();
    await runSetup(settings.setupCommands ?? [], restricted, signal);
    if (prepare) await prepare(restricted);
    if (snapName) {
      // Best effort: a session that works is worth more than the saved setup.
      await box.snapshot(snapName).catch(() => undefined);
    }
    return session;
  } catch (err) {
    await box.delete().catch(() => undefined);
    throw err;
  }
}

async function attach(settings: Kosa8CloudSandboxSettings, sandboxId: string, signal?: AbortSignal): Promise<Kosa8CloudNetworkSandboxSession> {
  signal?.throwIfAborted();
  const cloud = cloudFrom(settings);
  let box: CloudSandbox | undefined;
  if (sandboxId.startsWith('sbx_')) {
    box = await cloud.sandboxes.get(sandboxId).catch((err) => {
      if (err instanceof Kosa8NotFoundError) return undefined;
      throw err;
    });
  } else {
    box = await byName(cloud, sandboxId);
  }
  if (!box || ['deleted', 'host_removed', 'error'].includes(box.state)) {
    throw new Kosa8NotFoundError(`no kosa8 Cloud sandbox "${sandboxId}" to resume`, { status: 404 });
  }
  if (box.state === 'creating') await box.waitUntilRunning();
  if (box.state === 'sleeping' || box.state === 'paused') await box.wake();
  const egress = await box.egress().then(
    (e) => ({ internet: e.internet, allow: e.allow, deny: e.deny, presets: e.presets }),
    () => undefined,
  );
  return sessionFor(settings, box, true, egress);
}

// --- the AI SDK 7 session API --------------------------------------------------

/**
 * Create a kosa8 Cloud sandbox and return a network sandbox session for it
 * (pass it to `HarnessAgent.createSession({ sandboxSession })`, or hand
 * `session.restricted()` to AI SDK tools as `experimental_sandbox`).
 *
 * Needs a kosa8 Cloud API key (`apiKey`, or `KOSA8_API_KEY`).
 */
export async function createKosa8CloudSandboxSession(
  options: Kosa8CloudSandboxSessionCreateOptions = {},
): Promise<HarnessV1NetworkSandboxSession & Kosa8CloudNetworkSandboxSession> {
  const { sandboxId, abortSignal, ...settings } = options;
  const t = settings.template;
  if (t !== undefined && typeof t !== 'string') {
    return create(settings, sandboxId, abortSignal, (session) => t.prepare({ session, abortSignal }), t.identity);
  }
  return create(settings, sandboxId, abortSignal);
}

/**
 * Reattach to a kosa8 Cloud sandbox (by its `sbx_…` id, or the name it was
 * created with), waking it if it sleeps. Never creates one.
 */
export async function resumeKosa8CloudSandboxSession(
  options: Kosa8CloudSandboxSessionResumeOptions,
): Promise<HarnessV1NetworkSandboxSession & Kosa8CloudNetworkSandboxSession> {
  const { sandboxId, abortSignal, ...settings } = options;
  return attach(settings, sandboxId, abortSignal);
}

/**
 * Wrap a kosa8 Cloud sandbox you manage yourself (a `CloudSandbox` from
 * `@kosa8/sdk`, or its id). The caller keeps ownership: `stop()` and
 * `destroy()` do nothing.
 */
export async function createKosa8CloudSandboxSessionFromSandbox(
  options: Kosa8CloudSandboxSettings & { sandbox: CloudSandbox | string; abortSignal?: AbortSignal },
): Promise<HarnessV1NetworkSandboxSession & Kosa8CloudNetworkSandboxSession> {
  const { sandbox, abortSignal, ...settings } = options;
  abortSignal?.throwIfAborted();
  const box = typeof sandbox === 'string' ? await cloudFrom(settings).sandboxes.get(sandbox) : sandbox;
  return sessionFor(settings, box, false);
}

// --- the provider API (deprecated in AI SDK 7, kept for HarnessAgent({ sandbox })) ---

/**
 * `HarnessV1SandboxProvider` backed by kosa8 Cloud. No I/O at construction.
 * `createSession({ sessionId })` names the sandbox deterministically
 * (`sandboxNameForSession`), so `resumeSession({ sessionId })` finds it.
 */
export class Kosa8CloudSandboxProvider implements HarnessV1SandboxProvider {
  readonly specificationVersion = 'harness-sandbox-v1' as const;
  readonly providerId = KOSA8_CLOUD_PROVIDER_ID;

  constructor(private readonly settings: Kosa8CloudCreateSettings = {}) {
    if (settings.template !== undefined && typeof settings.template !== 'string') {
      throw new Error('the provider takes identity + onFirstCreate in createSession, not an AI SDK template; use cloudTemplate/template for a kosa8 Cloud template key');
    }
  }

  createSession = async (options?: {
    sessionId?: string;
    abortSignal?: AbortSignal;
    identity?: string;
    onFirstCreate?: (session: SandboxSession, opts: { abortSignal?: AbortSignal }) => Promise<void>;
  }): Promise<HarnessV1NetworkSandboxSession> => {
    const signal = options?.abortSignal;
    const name = options?.sessionId ? sandboxNameForSession(options.sessionId) : undefined;
    const onFirstCreate = options?.onFirstCreate;
    const prepare = onFirstCreate ? (s: SandboxSession) => onFirstCreate(s, { abortSignal: signal }) : undefined;
    return create(this.settings, name, signal, prepare, prepare && options?.identity != null ? options.identity : undefined);
  };

  resumeSession = async (options: { sessionId: string; abortSignal?: AbortSignal }): Promise<HarnessV1NetworkSandboxSession> => {
    return attach(this.settings, sandboxNameForSession(options.sessionId), options.abortSignal);
  };
}

/** Create a kosa8 Cloud sandbox provider (the AI SDK 7 provider shape). */
export function createKosa8CloudSandbox(settings: Kosa8CloudCreateSettings = {}): HarnessV1SandboxProvider {
  return new Kosa8CloudSandboxProvider(settings);
}

import {
  HarnessCapabilityUnsupportedError,
  type HarnessV1NetworkPolicy,
  type HarnessV1NetworkSandboxSession,
  type HarnessV1PortEndpoint,
} from '@ai-sdk/harness';
import type { Experimental_SandboxSession as SandboxSession } from '@ai-sdk/provider-utils';
import { Kosa8NotFoundError } from '@kosa8/sdk';
import { Kosa8SandboxSession, restrictedView, type Kosa8SessionTarget } from './kosa8-sandbox-session.js';

export const KOSA8_PROVIDER_ID = 'kosa8-sandbox';

/** Snapshot id a stopped session is kept under, so resume brings back processes and files. */
export function resumeSnapshotId(sandbox: string): string {
  return `${sandbox}-aisdk-resume`;
}

/**
 * Map the AI SDK network policy onto a kosa8 egress policy.
 *
 * - `allow-all` → `any`
 * - `deny-all` → `deny`
 * - `custom` → `allow:` the union of allowedHosts and allowedCIDRs. kosa8's
 *   allow-list already refuses everything not listed; it has no separate
 *   deny-list, so `deniedCIDRs` is refused rather than silently ignored.
 */
export function toKosa8Egress(policy: HarnessV1NetworkPolicy): string {
  switch (policy.mode) {
    case 'allow-all':
      return 'any';
    case 'deny-all':
      return 'deny';
    case 'custom': {
      if (policy.deniedCIDRs && policy.deniedCIDRs.length > 0) {
        throw new HarnessCapabilityUnsupportedError({
          harnessId: KOSA8_PROVIDER_ID,
          message:
            'kosa8 egress is an allow-list with no deny-list: every host or network not in allowedHosts/allowedCIDRs is already refused on the host. ' +
            'Remove deniedCIDRs (and leave those networks out of allowedCIDRs).',
        });
      }
      const allow = [...(policy.allowedHosts ?? []), ...(policy.allowedCIDRs ?? [])].map((h) => h.trim()).filter(Boolean);
      if (allow.length === 0) {
        throw new HarnessCapabilityUnsupportedError({
          harnessId: KOSA8_PROVIDER_ID,
          message: 'a custom network policy needs at least one entry in allowedHosts or allowedCIDRs; use { mode: "deny-all" } for no network.',
        });
      }
      return 'allow:' + allow.join(',');
    }
  }
}

function sameEgress(a: string | undefined, b: string): boolean {
  const norm = (s: string | undefined) => {
    const v = (s ?? '').replace(/\s+/g, '');
    if (v === '' || v === 'any') return 'any';
    if (v.startsWith('allow:')) return 'allow:' + v.slice(6).split(',').filter(Boolean).map((x) => x.toLowerCase()).sort().join(',');
    return v;
  };
  return norm(a) === norm(b);
}

export interface Kosa8NetworkSessionInit extends Kosa8SessionTarget {
  /** Whether stop()/destroy() act on the sandbox (false when wrapping one the caller owns). */
  ownsLifecycle: boolean;
}

/**
 * `HarnessV1NetworkSandboxSession` over a kosa8 sandbox: the tool-safe
 * session plus lifecycle and network policy.
 *
 * - `stop()` snapshots the running sandbox (memory, processes, disks) and
 *   stops it; resuming restores that snapshot under the same name, so the
 *   work container and its files come back as they were.
 * - `destroy()` deletes the sandbox and that snapshot.
 * - `setNetworkPolicy()` cannot change a running sandbox: kosa8 fixes egress
 *   when a sandbox is created. Asking for the policy already in force is a
 *   no-op; anything else throws HarnessCapabilityUnsupportedError.
 * - Ports are not exposed: the native API has no port forwarding for
 *   sandboxes, so `getPortEndpoint` throws HarnessCapabilityUnsupportedError.
 * - Request transformations are not offered (kosa8's egress broker is
 *   configured at creation and works by routes, not by rewriting HTTPS
 *   requests in flight), so adapters fall back to their own behaviour.
 */
export class Kosa8NetworkSandboxSession extends Kosa8SandboxSession implements HarnessV1NetworkSandboxSession {
  readonly id: string;
  readonly defaultWorkingDirectory: string;
  private readonly ownsLifecycle: boolean;
  private stopped = false;
  private destroyed = false;

  constructor(init: Kosa8NetworkSessionInit) {
    super(init);
    this.id = init.sandbox;
    this.defaultWorkingDirectory = init.workingDirectory;
    this.ownsLifecycle = init.ownsLifecycle;
  }

  /** The kosa8 sandbox name. */
  get sandboxName(): string {
    return this.target.sandbox;
  }

  /** The container inside the sandbox that commands run in. */
  get containerId(): string {
    return this.target.container;
  }

  get ports(): ReadonlyArray<number> {
    return [];
  }

  restricted(): SandboxSession {
    return restrictedView(new Kosa8SandboxSession({ ...this.target }));
  }

  getPortEndpoint = async (_options: { port: number; protocol?: 'http' | 'https' | 'ws' }): Promise<HarnessV1PortEndpoint> => {
    throw new HarnessCapabilityUnsupportedError({
      harnessId: KOSA8_PROVIDER_ID,
      message:
        'kosa8 does not expose sandbox ports to the host through its API, so there is no endpoint to connect to. ' +
        'Use a harness adapter that does not need a bridge port, or talk to the process through run/spawn.',
    });
  };

  /** @deprecated Use `getPortEndpoint` instead. */
  getPortUrl = async (options: { port: number; protocol?: 'http' | 'https' | 'ws' }): Promise<string> => {
    return (await this.getPortEndpoint(options)).url;
  };

  setPorts = async (ports: ReadonlyArray<number>, options?: { abortSignal?: AbortSignal }): Promise<void> => {
    options?.abortSignal?.throwIfAborted();
    if (ports.length > 0) {
      throw new HarnessCapabilityUnsupportedError({
        harnessId: KOSA8_PROVIDER_ID,
        message: `kosa8 cannot expose sandbox ports (${ports.join(', ')}) to the host through its API.`,
      });
    }
  };

  setNetworkPolicy = async (policy: HarnessV1NetworkPolicy): Promise<void> => {
    const want = toKosa8Egress(policy);
    const current =
      this.target.egress ?? (await this.target.client.getSandbox(this.target.sandbox, { approval: this.target.approval }))?.egress;
    if (sameEgress(current, want)) return;
    throw new HarnessCapabilityUnsupportedError({
      harnessId: KOSA8_PROVIDER_ID,
      message:
        `kosa8 fixes a sandbox's egress policy when the sandbox is created, and cannot change it while it runs ` +
        `(sandbox "${this.target.sandbox}" has ${current ? `"${current}"` : 'the daemon default'}; asked for "${want}"). ` +
        'Create the session with this networkPolicy instead.',
    });
  };

  stop = async (): Promise<void> => {
    if (!this.ownsLifecycle || this.stopped || this.destroyed) return;
    const { client, sandbox, approval } = this.target;
    const snapId = resumeSnapshotId(sandbox);
    await client.deleteSnapshot(snapId, { approval }).catch((err) => {
      if (!(err instanceof Kosa8NotFoundError)) throw err;
    });
    await client.snapshot(sandbox, { id: snapId, approval });
    await client.stopSandbox(sandbox, { approval });
    this.stopped = true;
  };

  destroy = async (): Promise<void> => {
    if (!this.ownsLifecycle || this.destroyed) return;
    const { client, sandbox, approval } = this.target;
    await client.deleteSandbox(sandbox, { approval }).catch((err) => {
      if (!(err instanceof Kosa8NotFoundError)) throw err;
    });
    await client.deleteSnapshot(resumeSnapshotId(sandbox), { approval }).catch(() => undefined);
    this.destroyed = true;
  };
}

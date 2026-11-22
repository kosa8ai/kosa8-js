// Copyright (c) 2026 kosa8. Licensed under the MIT License; see LICENSE.

/** Leases: sandboxes that die with the trainer. */

import { ensureDisposeSymbols } from '../dispose.js';
import { Kosa8Error } from '../errors.js';
import type { CloudDrainResult, Kosa8Cloud } from '../cloud.js';
import { MIN_LEASE_S } from '../cloud.js';

ensureDisposeSymbols();

/** Default lease: a sandbox is deleted this long after the last heartbeat. */
export const DEFAULT_LEASE_S = 600;

export interface LeaseOptions {
  /** Which sandboxes: the run's (kosa8.run=<runId>), those with all these labels, or these ids. At least one. */
  runId?: string;
  labels?: Record<string, string>;
  ids?: string[];
  /** Seconds the sandboxes outlive the last heartbeat (60..86400). Default 600. */
  leaseS?: number;
  /** Between heartbeats. Default a third of the lease (at least 5 s). */
  intervalMs?: number;
  /** Delete every matching sandbox on close. Default true. */
  drain?: boolean;
  /**
   * Close (and drain) on SIGINT and SIGTERM, then exit with 128 + the signal
   * unless something else listens for it; and on `beforeExit`. Default true.
   */
  signals?: boolean;
  /** Called after each heartbeat and once on close (a Run flushes its rollouts here). */
  onTick?: () => Promise<unknown> | unknown;
  /** Called last on close, after the drain (awaited before a signal exits the process). */
  onClose?: () => Promise<unknown> | unknown;
  /** Where warnings go. Default console.warn. */
  warn?: (message: string) => void;
}

type Proc = {
  on(ev: string, fn: (...a: unknown[]) => void): unknown;
  off(ev: string, fn: (...a: unknown[]) => void): unknown;
  listenerCount(ev: string): number;
  exit(code?: number): never;
};

function proc(): Proc | undefined {
  const p = (globalThis as { process?: Proc }).process;
  return p && typeof p.on === 'function' ? p : undefined;
}

const SIGNALS: [string, number][] = [['SIGINT', 2], ['SIGTERM', 15]];

/**
 * Keeps a set of leased sandboxes alive while the trainer is, and deletes
 * them when it stops. A timer (unref'd: it never keeps the process up)
 * sends a heartbeat every `intervalMs`. On `close()` (the end of `await
 * using`, SIGINT, SIGTERM or the event loop running dry) the heartbeats stop
 * and, with `drain`, every matching sandbox is deleted. If the process is
 * killed outright the heartbeats stop and kosa8 Cloud deletes them
 * `leaseS` later. Sandboxes must be created with `leaseS` (or inside an
 * `rl.Run`) for the server to expire them.
 */
export class Lease {
  readonly selector: { runId?: string; labels?: Record<string, string>; ids?: string[] };
  readonly leaseS: number;
  readonly intervalMs: number;
  readonly drain: boolean;
  /** Heartbeats sent. */
  beats = 0;
  /** The last error a heartbeat, tick or the drain threw. */
  lastError: unknown = null;
  /** What the drain answered on close. */
  drained: CloudDrainResult | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private started = false;
  private closing: Promise<CloudDrainResult | null> | undefined;
  private readonly handlers: [string, (...a: unknown[]) => void][] = [];

  constructor(readonly cloud: Kosa8Cloud, private readonly opts: LeaseOptions = {}) {
    if (!opts.runId && !(opts.labels && Object.keys(opts.labels).length) && !opts.ids?.length) {
      throw new Kosa8Error('a lease needs runId, labels or ids: which sandboxes');
    }
    const leaseS = opts.leaseS ?? DEFAULT_LEASE_S;
    if (!Number.isInteger(leaseS) || leaseS < MIN_LEASE_S) throw new Kosa8Error('leaseS must be a whole number of seconds, at least 60');
    this.selector = {
      ...(opts.runId ? { runId: opts.runId } : {}),
      ...(opts.labels ? { labels: opts.labels } : {}),
      ...(opts.ids ? { ids: opts.ids } : {}),
    };
    this.leaseS = leaseS;
    this.intervalMs = opts.intervalMs ?? Math.max(5000, (leaseS * 1000) / 3);
    this.drain = opts.drain ?? true;
  }

  get closed(): boolean {
    return this.closing !== undefined;
  }

  private warn(msg: string): void {
    (this.opts.warn ?? ((m: string) => console.warn(m)))(msg);
  }

  /** Start the heartbeats (and the signal handlers). */
  start(): this {
    if (this.started || this.closed) return this;
    this.started = true;
    this.schedule();
    const p = proc();
    if (p && this.opts.signals !== false) {
      for (const [sig, num] of SIGNALS) {
        const h = () => {
          void this.close().finally(() => {
            if (p.listenerCount(sig) === 0) p.exit(128 + num);
          });
        };
        p.on(sig, h);
        this.handlers.push([sig, h]);
      }
      const be = () => void this.close();
      p.on('beforeExit', be);
      this.handlers.push(['beforeExit', be]);
    }
    return this;
  }

  private schedule(): void {
    this.timer = setTimeout(() => void this.tick(), this.intervalMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  private async tick(): Promise<void> {
    if (this.closed) return;
    try {
      await this.beat();
    } catch (e) {
      this.lastError = e;
      this.warn(`kosa8 lease heartbeat failed: ${String((e as Error)?.message ?? e)}`);
    }
    await this.runTick();
    if (!this.closed) this.schedule();
  }

  private async runTick(): Promise<void> {
    if (!this.opts.onTick) return;
    try {
      await this.opts.onTick();
    } catch (e) {
      this.lastError = e;
      this.warn(`kosa8 lease tick failed: ${String((e as Error)?.message ?? e)}`);
    }
  }

  /** Send one heartbeat now; resolves with how many sandboxes it extended. */
  async beat(): Promise<number> {
    const n = await this.cloud.sandboxes.heartbeat({ ...this.selector, extendS: this.leaseS });
    this.beats++;
    return n;
  }

  /** Stop the heartbeats and, with `drain`, delete every matching sandbox. Safe to call more than once. */
  close(): Promise<CloudDrainResult | null> {
    this.closing ??= this.doClose();
    return this.closing;
  }

  private async doClose(): Promise<CloudDrainResult | null> {
    clearTimeout(this.timer);
    const p = proc();
    if (p) for (const [ev, h] of this.handlers) p.off(ev, h);
    this.handlers.length = 0;
    await this.runTick();
    if (this.drain) {
      try {
        this.drained = await this.cloud.sandboxes.drain(this.selector);
        while (this.drained.more) {
          const more = await this.cloud.sandboxes.drain(this.selector);
          this.drained = {
            deleted: this.drained.deleted + more.deleted, ids: [...this.drained.ids, ...more.ids],
            failed: [...this.drained.failed, ...more.failed], more: more.more && more.deleted > 0,
          };
        }
      } catch (e) {
        this.lastError = e;
        this.warn(`kosa8 drain failed (leased sandboxes still expire in ${this.leaseS} s): ${String((e as Error)?.message ?? e)}`);
      }
    }
    if (this.opts.onClose) {
      try {
        await this.opts.onClose();
      } catch (e) {
        this.lastError = e;
      }
    }
    return this.drained;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

/**
 * A started `Lease`; use it with `await using`:
 *
 * ```ts
 * await using _ = rl.lease(cloud, { labels: { job: 'exp-7' } });
 * const boxes = await cloud.sandboxes.createMany(256, { labels: { job: 'exp-7' }, leaseS: 600 });
 * // every sandbox labelled job=exp-7 is gone when the block ends, even after a crash
 * ```
 */
export function lease(cloud: Kosa8Cloud, opts: LeaseOptions): Lease {
  return new Lease(cloud, opts).start();
}

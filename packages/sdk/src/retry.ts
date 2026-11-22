// Copyright (c) 2026 kosa8. Licensed under the MIT License; see LICENSE.

/**
 * Retries with exponential backoff and full jitter.
 *
 * Only failures that can pass are retried: `infra` (no answer, a 5xx, a host
 * or capacity problem) and rate limits (429, waiting at least the server's
 * `Retry-After`). Quota, payment, bad requests and your own exceptions are
 * thrown at once.
 */

import { Kosa8Error, classifyFailure } from './errors.js';

export interface RetryPolicyOptions {
  /** Tries in all, the first included (1 turns retries off). Default 3. */
  attempts?: number;
  /** The first retry waits a random time up to this. Default 500 ms. */
  baseMs?: number;
  /** No wait is longer than this (before Retry-After). Default 8000 ms. */
  maxMs?: number;
  /** A Retry-After is honoured up to this. Default 60000 ms. */
  maxRetryAfterMs?: number;
}

/**
 * How often and how long to retry. The n-th retry waits a random time up to
 * `min(maxMs, baseMs * 2**(n-1))` ("full jitter", so a thousand rollouts
 * that failed together do not come back together), and never less than the
 * error's `retryAfter` (capped at `maxRetryAfterMs`).
 */
export class RetryPolicy {
  readonly attempts: number;
  readonly baseMs: number;
  readonly maxMs: number;
  readonly maxRetryAfterMs: number;

  constructor(opts: RetryPolicyOptions = {}) {
    this.attempts = opts.attempts ?? 3;
    this.baseMs = opts.baseMs ?? 500;
    this.maxMs = opts.maxMs ?? 8000;
    this.maxRetryAfterMs = opts.maxRetryAfterMs ?? 60_000;
    if (!Number.isInteger(this.attempts) || this.attempts < 1) {
      throw new Kosa8Error('attempts must be a whole number of at least 1');
    }
    if (this.baseMs < 0 || this.maxMs < 0 || this.maxRetryAfterMs < 0) {
      throw new Kosa8Error('baseMs, maxMs and maxRetryAfterMs must not be negative');
    }
  }

  /** Whether to try again after `e` on attempt `attempt` (1-based). */
  shouldRetry(e: unknown, attempt: number): boolean {
    return attempt < this.attempts && classifyFailure(e).retryable;
  }

  /** Milliseconds to wait before attempt `attempt + 1`. */
  delayMs(e: unknown, attempt: number, random: () => number = Math.random): number {
    const cap = Math.min(this.maxMs, this.baseMs * 2 ** Math.max(0, attempt - 1));
    let wait = cap > 0 ? random() * cap : 0;
    const ra = e instanceof Kosa8Error ? e.retryAfter : undefined;
    if (typeof ra === 'number' && ra > 0) wait = Math.max(wait, Math.min(ra * 1000, this.maxRetryAfterMs));
    return wait;
  }
}

/** No retries. */
export const NO_RETRY = new RetryPolicy({ attempts: 1 });

/** What `callWithRetry` takes besides the call and the policy. */
export interface RetryCallOptions {
  /** Called before each wait with the error, the attempt that failed and the wait. */
  onRetry?: (e: unknown, attempt: number, waitMs: number) => void;
  /** Stops waiting (and retrying) once aborted; the last error is thrown. */
  signal?: AbortSignal;
  /** Overrides `policy.shouldRetry` (e.g. to retry only what is safe to send twice). */
  shouldRetry?: (e: unknown, attempt: number) => boolean;
}

/** @internal */
export function sleepMs(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted || ms <= 0) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** `fn()` until it resolves, retrying what `policy` allows. */
export async function callWithRetry<T>(fn: () => Promise<T>, policy: RetryPolicy, opts: RetryCallOptions = {}): Promise<T> {
  const should = opts.shouldRetry ?? ((e: unknown, a: number) => policy.shouldRetry(e, a));
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (opts.signal?.aborted || !should(e, attempt)) throw e;
      const wait = policy.delayMs(e, attempt);
      opts.onRetry?.(e, attempt, wait);
      await sleepMs(wait, opts.signal);
      if (opts.signal?.aborted) throw e;
    }
  }
}

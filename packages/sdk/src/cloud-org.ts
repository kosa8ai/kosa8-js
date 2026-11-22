// Copyright (c) 2026 kosa8. Licensed under the MIT License; see LICENSE.

/**
 * The org side of the kosa8 Cloud API: API keys, webhooks, the audit log,
 * ready-made benchmarks, and RL run comparison and alert rules. `cloud.ts`
 * wires these onto `Kosa8Cloud`; the types are the API's own (snake_case
 * fields, times in Unix ms unless the API says otherwise).
 */

import { Kosa8Error } from './errors.js';
import type { CloudRequester } from './cloud-features.js';

type Json = Record<string, unknown>;
const enc = encodeURIComponent;

function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : '';
}

function ndjson(bytes: Uint8Array): Json[] {
  return new TextDecoder()
    .decode(bytes)
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Json);
}

// ---------------------------------------------------------------------------
// API keys

/** An API key as listed: never its secret. */
export interface CloudApiKey {
  id: string;
  name: string;
  scopes: string[];
  prefix?: string;
  created_at?: number;
  last_used_at?: number | null;
  expires_at?: number | null;
  revoked_at?: number | null;
  member_email?: string | null;
  [k: string]: unknown;
}

/** A new key: `secret` (k8c_live_…) is shown this once. */
export interface CloudNewApiKey extends CloudApiKey {
  secret: string;
}

export interface CloudApiKeyOptions {
  name: string;
  /** Default `['sandboxes:write']`. A key cannot grant scopes it does not hold. */
  scopes?: string[];
  /** Seconds until it stops working; default never. */
  expiresInS?: number;
}

/** The org's API keys. */
export class CloudApiKeys {
  constructor(private readonly cloud: CloudRequester) {}

  async list(): Promise<CloudApiKey[]> {
    return (await this.cloud.request<{ api_keys?: CloudApiKey[] }>('GET', '/v1/api-keys')).api_keys ?? [];
  }

  /** Make a key; its `secret` is in the answer only. */
  async create(opts: CloudApiKeyOptions): Promise<CloudNewApiKey> {
    if (!opts?.name) throw new Kosa8Error('an API key needs a name');
    const body: Json = { name: opts.name };
    if (opts.scopes !== undefined) body.scopes = opts.scopes;
    if (opts.expiresInS !== undefined) body.expires_in_s = opts.expiresInS;
    return (await this.cloud.request<{ api_key: CloudNewApiKey }>('POST', '/v1/api-keys', body)).api_key;
  }

  /** Revoke it now. */
  async revoke(id: string): Promise<void> {
    await this.cloud.request('DELETE', `/v1/api-keys/${enc(id)}`);
  }

  /** A new key with the same name and scopes; the old one keeps working `graceS` seconds more (default the server's). */
  rotate(id: string, opts: { graceS?: number } = {}): Promise<{
    api_key: CloudNewApiKey; old_key: { id: string; expires_at: number | null }; note: string;
  }> {
    return this.cloud.request('POST', `/v1/api-keys/${enc(id)}/rotate`, opts.graceS !== undefined ? { grace_s: opts.graceS } : {});
  }
}

// ---------------------------------------------------------------------------
// Webhooks

export interface CloudWebhook {
  id: string;
  url: string;
  events: string[];
  description?: string | null;
  created_at?: number;
  [k: string]: unknown;
}

export interface CloudWebhookDelivery {
  id: string;
  event: string;
  /** pending, delivered or failed. */
  status: string;
  status_code?: number | null;
  attempts?: number;
  error?: string | null;
  created_at?: number;
  [k: string]: unknown;
}

/** The org's webhook endpoints. Payloads are signed with the endpoint's `whsec_` secret. */
export class CloudWebhooks {
  constructor(private readonly cloud: CloudRequester) {}

  /** Endpoints, and the event names an endpoint may ask for. */
  async list(): Promise<{ webhooks: CloudWebhook[]; events: string[] }> {
    const r = await this.cloud.request<{ webhooks?: CloudWebhook[]; events?: string[] }>('GET', '/v1/webhooks');
    return { webhooks: r.webhooks ?? [], events: r.events ?? [] };
  }

  /** Add an endpoint; the answer's `secret` (whsec_…) is shown this once. */
  async create(url: string, opts: { events?: string[]; description?: string } = {}): Promise<CloudWebhook & { secret: string }> {
    if (!url) throw new Kosa8Error('a webhook needs a url');
    const body: Json = { url };
    if (opts.events !== undefined) body.events = opts.events;
    if (opts.description !== undefined) body.description = opts.description;
    return (await this.cloud.request<{ webhook: CloudWebhook & { secret: string } }>('POST', '/v1/webhooks', body)).webhook;
  }

  /** Stop sending to it, retries included. */
  async delete(id: string): Promise<void> {
    await this.cloud.request('DELETE', `/v1/webhooks/${enc(id)}`);
  }

  async deliveries(id: string, opts: { limit?: number } = {}): Promise<CloudWebhookDelivery[]> {
    const r = await this.cloud.request<{ deliveries?: CloudWebhookDelivery[] }>(
      'GET', `/v1/webhooks/${enc(id)}/deliveries${qs({ limit: opts.limit })}`,
    );
    return r.deliveries ?? [];
  }

  /** Send a `webhook.test` event now; resolves with the delivery. */
  async test(id: string): Promise<CloudWebhookDelivery> {
    return (await this.cloud.request<{ delivery: CloudWebhookDelivery }>('POST', `/v1/webhooks/${enc(id)}/test`, {})).delivery;
  }
}

// ---------------------------------------------------------------------------
// Audit log

export interface CloudAuditEvent {
  seq: number;
  at?: number;
  actor?: string;
  action: string;
  target?: string | null;
  sandbox_id?: string | null;
  [k: string]: unknown;
}

export interface CloudAuditQuery {
  sandboxId?: string;
  actor?: string;
  action?: string;
  /** Unix ms. */
  since?: number;
  until?: number;
  /** Page back from this seq (a previous page's `next_before_seq`). */
  beforeSeq?: number;
  limit?: number;
}

export interface CloudAuditVerify {
  ok: boolean;
  count: number;
  head?: { seq: number; hash: string } | null;
  first_broken_seq?: number;
  reason?: string;
  verified_at?: number;
}

/** The org's hash-chained audit log. */
export class CloudAudit {
  constructor(private readonly cloud: CloudRequester) {}

  /** Events, newest first; `next_before_seq` pages back. */
  async list(q: CloudAuditQuery = {}): Promise<{ events: CloudAuditEvent[]; next_before_seq: number | null }> {
    const r = await this.cloud.request<{ events?: CloudAuditEvent[]; next_before_seq?: number | null }>('GET', '/v1/audit' + qs({
      sandbox_id: q.sandboxId, actor: q.actor, action: q.action, since: q.since, until: q.until, before_seq: q.beforeSeq, limit: q.limit,
    }));
    return { events: r.events ?? [], next_before_seq: r.next_before_seq ?? null };
  }

  /** Recompute the org's hash chain: `ok`, or where it first breaks. */
  verify(): Promise<CloudAuditVerify> {
    return this.cloud.request('GET', '/v1/audit/verify');
  }

  /** Every event, oldest first, with its hashes (the NDJSON export, parsed). */
  async export(): Promise<CloudAuditEvent[]> {
    return ndjson(await this.cloud.requestBytes('GET', '/v1/audit/export')) as CloudAuditEvent[];
  }
}

// ---------------------------------------------------------------------------
// Benchmarks

export interface CloudBenchmark {
  name: string;
  title?: string;
  version?: string;
  instances: number;
  source?: string;
  revision?: string;
  grader?: unknown;
  /** Create a sandbox of one instance with `template: '<name>/<instance id>'`. */
  template?: string;
  environments?: { ready: number; building: number; queued: number; failed: number };
  [k: string]: unknown;
}

export interface CloudBenchmarkInstance {
  id: string;
  benchmark: string;
  /** `<benchmark>/<instance id>`: the template a sandbox of it is created from. */
  template: string;
  image?: string;
  /** ready, building, queued, failed or not_built. */
  state?: string;
  eta_s?: number | null;
  /** The solver's input (problem statement or instruction); never the hidden tests. */
  input?: unknown;
  [k: string]: unknown;
}

/**
 * Ready-made benchmarks (SWE-bench Verified, Terminal-Bench...). A create of
 * an instance whose environment is still being built answers 409
 * `template_building` with a Retry-After, which the SDK waits out on its own.
 */
export class CloudBenchmarks {
  constructor(private readonly cloud: CloudRequester) {}

  async list(): Promise<CloudBenchmark[]> {
    return (await this.cloud.request<{ benchmarks?: CloudBenchmark[] }>('GET', '/v1/benchmarks')).benchmarks ?? [];
  }

  async get(name: string): Promise<CloudBenchmark> {
    return (await this.cloud.request<{ benchmark: CloudBenchmark }>('GET', `/v1/benchmarks/${enc(name)}`)).benchmark;
  }

  /** Instances in the dataset's order, with their environments' state; `next_cursor` pages on. */
  async instances(name: string, opts: { state?: string; limit?: number; cursor?: number | string } = {}): Promise<{
    instances: CloudBenchmarkInstance[]; next_cursor: number | string | null;
  }> {
    const r = await this.cloud.request<{ instances?: CloudBenchmarkInstance[]; next_cursor?: number | string | null }>(
      'GET', `/v1/benchmarks/${enc(name)}/instances${qs({ state: opts.state, limit: opts.limit, cursor: opts.cursor })}`,
    );
    return { instances: r.instances ?? [], next_cursor: r.next_cursor ?? null };
  }

  /** One instance: the solver's input and its environment's state and ETA. */
  async instance(name: string, id: string): Promise<CloudBenchmarkInstance> {
    return (await this.cloud.request<{ instance: CloudBenchmarkInstance }>(
      'GET', `/v1/benchmarks/${enc(name)}/instances/${enc(id)}`,
    )).instance;
  }

  /**
   * Build environments ahead of use (at most 100 a call): a list of ids,
   * `'all'`, or a number of instances picked with `seed`.
   */
  prepare(name: string, instances: string[] | 'all' | number, opts: { seed?: number } = {}): Promise<{
    benchmark: string; instances: CloudBenchmarkInstance[]; builds_at_once?: number;
  }> {
    const body: Json = { instances };
    if (opts.seed !== undefined) body.seed = opts.seed;
    return this.cloud.request('POST', `/v1/benchmarks/${enc(name)}/prepare`, body);
  }
}

// ---------------------------------------------------------------------------
// RL: compare runs, alert rules

export type CloudRlAlertKind = 'infra_rate' | 'oom_rate' | 'cost' | 'idle' | (string & {});

export interface CloudRlAlert {
  id: string;
  run_id: string | null;
  /** `run` (one run) or `org` (every run). */
  scope: 'run' | 'org';
  kind: CloudRlAlertKind;
  threshold: number;
  window: number | null;
  enabled: boolean;
  [k: string]: unknown;
}

export interface CloudRlAlertOptions {
  kind: CloudRlAlertKind;
  threshold: number;
  /** Rollouts the rate is over (infra_rate, oom_rate). */
  window?: number;
  /** One run; default every run of the org. */
  runId?: string;
}

/** Alert rules on RL runs: they fire the `rl.alert` webhook event. */
export class CloudRlAlerts {
  constructor(private readonly cloud: CloudRequester) {}

  /** Rules (for one run: its own and the org-wide ones), the event they send, and the kinds with their ranges. */
  async list(opts: { runId?: string } = {}): Promise<{ alerts: CloudRlAlert[]; event?: string; kinds?: Record<string, unknown> }> {
    const r = await this.cloud.request<{ alerts?: CloudRlAlert[]; event?: string; kinds?: Record<string, unknown> }>(
      'GET', `/v1/rl/alerts${qs({ run_id: opts.runId })}`,
    );
    return { ...r, alerts: r.alerts ?? [] };
  }

  async create(opts: CloudRlAlertOptions): Promise<CloudRlAlert> {
    if (!opts?.kind) throw new Kosa8Error('an alert needs a kind (infra_rate, oom_rate, cost or idle)');
    const body: Json = { kind: opts.kind, threshold: opts.threshold };
    if (opts.window !== undefined) body.window = opts.window;
    if (opts.runId !== undefined) body.run_id = opts.runId;
    return (await this.cloud.request<{ alert: CloudRlAlert }>('POST', '/v1/rl/alerts', body)).alert;
  }

  /** Change its threshold or window, or pause (`enabled: false`) and resume it. */
  async update(id: string, opts: { threshold?: number; window?: number; enabled?: boolean }): Promise<CloudRlAlert> {
    const body: Json = {};
    if (opts.threshold !== undefined) body.threshold = opts.threshold;
    if (opts.window !== undefined) body.window = opts.window;
    if (opts.enabled !== undefined) body.enabled = opts.enabled;
    if (Object.keys(body).length === 0) throw new Kosa8Error('give threshold, window or enabled');
    return (await this.cloud.request<{ alert: CloudRlAlert }>('PATCH', `/v1/rl/alerts/${enc(id)}`, body)).alert;
  }

  async delete(id: string): Promise<void> {
    await this.cloud.request('DELETE', `/v1/rl/alerts/${enc(id)}`);
  }
}

/** Org-wide RL calls; a single run is `RlRun` (`rl.RlRun.create`). */
export class CloudRl {
  readonly alerts: CloudRlAlerts;

  constructor(private readonly cloud: CloudRequester) {
    this.alerts = new CloudRlAlerts(cloud);
  }

  /** Two to four runs side by side. */
  async compare(ids: string[]): Promise<Json[]> {
    const uniq = [...new Set(ids)];
    if (uniq.length < 2 || uniq.length > 4) throw new Kosa8Error('compare takes 2 to 4 different run ids');
    return (await this.cloud.request<{ runs?: Json[] }>('GET', `/v1/rl/compare?ids=${uniq.map(enc).join(',')}`)).runs ?? [];
  }
}

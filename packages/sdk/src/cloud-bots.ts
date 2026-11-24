// Copyright (c) 2026 kosa8. Licensed under the MIT License; see LICENSE.

/**
 * Autopilot: bots that watch the org's sandboxes, spend and agents and act
 * on what they see (sleep an idle sandbox, block a host, open a draft PR,
 * post a digest). A bot is made from a template, a spec, or a sentence
 * (`compile`), starts as a `draft`, and runs only once a person enables it.
 * Risky (T3) steps wait for a person's approval.
 *
 * An agent never approves its own action, and never turns a bot on: a person
 * does that in the web app (app.kosa8.com/app#autopilot), the desktop app,
 * the CLI or Slack. The API refuses `approve`, `reject`, `enable` and
 * `resumeAll` from capability tokens, MCP and org keys bound to no member
 * with 403 `human_required`, which this SDK throws as
 * `Kosa8HumanApprovalRequiredError`. There is no client-side way around it.
 */

import { Kosa8Error } from './errors.js';

type Json = Record<string, unknown>;
const enc = encodeURIComponent;

/** @internal What the bot calls need from `Kosa8Cloud`. */
export interface BotsRequester {
  request<T = Json>(method: string, path: string, body?: unknown): Promise<T>;
}

/** The longest sentence `bots.compile()` takes. */
export const MAX_BOT_SENTENCE = 500;

/** A trigger in a bot spec, e.g. `{ event: 'sandbox.idle', for_s: 1200 }`. */
export interface CloudBotTrigger {
  event: string;
  [k: string]: unknown;
}

/** An action in a bot spec. The engine computes its tier; `approve: true` raises it to T3. */
export interface CloudBotAction {
  action: string;
  args?: Json;
  when?: Json;
  approve?: boolean;
  [k: string]: unknown;
}

/** What a bot does: the JSON templates, the sentence box, the CLI and the SDKs all produce. */
export interface CloudBotSpec {
  triggers: CloudBotTrigger[];
  actions: CloudBotAction[];
  scope?: { labels?: Record<string, string>; [k: string]: unknown };
  budget_usd?: number;
  notify?: { mode?: string; [k: string]: unknown };
  dedup_s?: number;
  rate_per_hour?: number;
  chain?: boolean;
  [k: string]: unknown;
}

/** A bot's plan in words: what it watches, what it does, what it may cost. */
export interface CloudBotPlan {
  summary: string;
  triggers: Array<{ event: string; says: string }>;
  actions: Array<{ action: string; says: string; tier: string; undo: boolean; scope: string; est_usd: number; needs_approval: boolean }>;
  permissions: string[];
  est_usd_per_run: number;
  schedule: string;
  never: string[];
  free: boolean;
  warnings: string[];
  [k: string]: unknown;
}

/** What a dry run or `plan({ replay: true })` would have done over the last 7 days. */
export interface CloudBotReplay {
  since: number;
  until: number;
  events: number;
  would: Array<{ at: number; subject: unknown; summary: string; actions: Array<{ action: string; tier: string; says: string }> }>;
  totals: { runs: number; actions: number; approvals: number; saved_usd?: number };
  [k: string]: unknown;
}

/** A ready-made bot (spend-guard, lifecycle-janitor, egress-guard, ...). */
export interface CloudBotTemplate {
  id: string;
  version: number;
  title: string;
  summary: string;
  tier: string;
  free: boolean;
  plan: CloudBotPlan | string | null;
  needs?: string[];
  spec: CloudBotSpec;
  never: string[];
  icp?: string[];
  rank?: number;
  why?: string;
  [k: string]: unknown;
}

export type CloudBotState = 'draft' | 'on' | 'paused' | 'budget_paused' | 'broken' | (string & {});

export interface CloudBot {
  id: string;
  name: string;
  /** e.g. "spend-guard@1"; null for a bot made from a spec or a sentence. */
  template: string | null;
  state: CloudBotState;
  sponsor: string;
  owner?: string;
  created_by?: string;
  source: 'template' | 'nl' | 'api' | (string & {});
  version: number;
  scope?: Json;
  budget_usd?: number | null;
  /** Spent this month. */
  spent_usd?: number;
  notify?: Json;
  consecutive_failures?: number;
  last_run: { id: string; state: string; at: number } | null;
  created_at: number;
  updated_at: number;
  free?: boolean;
  tier?: string;
  /** `get()` only. */
  spec?: CloudBotSpec;
  plan?: CloudBotPlan;
  versions?: unknown[];
  [k: string]: unknown;
}

/** `bots.list()`: the bots, whether everything is paused, and how many approvals wait. */
export interface CloudBotList {
  bots: CloudBot[];
  paused_all: boolean;
  paused_all_at?: number | null;
  pending_approvals: number;
  [k: string]: unknown;
}

export interface CloudBotStep {
  key: string;
  label: string;
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped' | 'waiting' | (string & {});
  detail?: string;
  action?: string;
  args?: Json;
  tier?: string;
  result?: unknown;
  undo?: { available: boolean; done_at?: number };
  approval_id?: string;
  started_at?: number;
  ended_at?: number;
  [k: string]: unknown;
}

export interface CloudBotRun {
  id: string;
  bot_id: string;
  version: number;
  dry_run: boolean;
  state: 'queued' | 'running' | 'waiting_approval' | 'succeeded' | 'failed' | 'cancelled' | 'budget_paused' | 'skipped' | (string & {});
  trigger: { event: string; subject: unknown; summary: string; via_bot?: string; [k: string]: unknown };
  steps: CloudBotStep[];
  rationale?: string;
  cost_usd: number;
  failure_class?: string | null;
  replay?: CloudBotReplay;
  created_at: number;
  started_at?: number | null;
  ended_at?: number | null;
  [k: string]: unknown;
}

export interface CloudApproval {
  id: string;
  run_id: string;
  bot_id: string;
  bot_name: string;
  step_key: string;
  action: string;
  tier: string;
  args: Json;
  rationale?: string;
  requested_role?: string;
  state: 'pending' | 'approved' | 'rejected' | 'expired' | (string & {});
  expires_at: number;
  decision: { by: string; via: 'web' | 'slack' | 'api' | (string & {}); at: number; reason?: string; edited_args?: Json } | null;
  created_at: number;
  [k: string]: unknown;
}

/** Make a bot from exactly one of a template id or a spec. */
export type CloudBotSource = { template: string; spec?: undefined } | { spec: CloudBotSpec; template?: undefined };

export type CloudBotPlanOptions = CloudBotSource & { name?: string; replay?: boolean };

export type CloudBotCreateOptions = CloudBotSource & {
  name?: string;
  /** A member email; defaults to the person calling. Required when the key is not a person's. */
  sponsor?: string;
  budgetUsd?: number;
  scope?: Json;
  notify?: Json;
};

export interface CloudBotUpdateOptions {
  name?: string;
  /** A new spec is a new version; an agent changing an `on` bot's spec sends it back to `draft`. */
  spec?: CloudBotSpec;
  sponsor?: string;
  budgetUsd?: number;
  scope?: Json;
  notify?: Json;
}

function checkId(id: unknown, what: string): string {
  if (typeof id !== 'string' || id === '') throw new Kosa8Error(`${what} must be a non-empty string`);
  return id;
}

function sourceBody(o: { template?: unknown; spec?: unknown } | undefined, call: string): Json {
  const hasT = o?.template !== undefined && o.template !== null;
  const hasS = o?.spec !== undefined && o.spec !== null;
  if (hasT === hasS) throw new Kosa8Error(`bots.${call}() takes exactly one of template or spec`);
  if (hasT) {
    if (typeof o!.template !== 'string' || o!.template === '') throw new Kosa8Error('template must be a template id such as "spend-guard"');
    return { template: o!.template };
  }
  if (typeof o!.spec !== 'object' || Array.isArray(o!.spec)) throw new Kosa8Error('spec must be an object { triggers, actions, ... }');
  return { spec: o!.spec };
}

function settingsBody(o: { name?: string; sponsor?: string; budgetUsd?: number; scope?: Json; notify?: Json; spec?: CloudBotSpec }): Json {
  const b: Json = {};
  if (o.name !== undefined) b.name = o.name;
  if (o.spec !== undefined) b.spec = o.spec;
  if (o.sponsor !== undefined) b.sponsor = o.sponsor;
  if (o.budgetUsd !== undefined) b.budget_usd = o.budgetUsd;
  if (o.scope !== undefined) b.scope = o.scope;
  if (o.notify !== undefined) b.notify = o.notify;
  return b;
}

function limitQs(limit: number | undefined, extra: Record<string, string> = {}): string {
  const q = new URLSearchParams(extra);
  if (limit !== undefined) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Kosa8Error(`limit must be a whole number from 1 to 100, got ${limit}`);
    q.set('limit', String(limit));
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}

/**
 * `cloud.bots`: Autopilot bots. Reading needs `sandboxes:read`; making,
 * changing, running and disabling need `sandboxes:write`. `enable()` and
 * `resumeAll()` need a person's key (403 `human_required`, thrown as
 * `Kosa8HumanApprovalRequiredError`, otherwise); `pauseAll()` works from
 * any admin credential, so an agent can always stop everything.
 */
export class CloudBots {
  constructor(private readonly cloud: BotsRequester) {}

  /** The org's bots, plus `paused_all` and `pending_approvals`. */
  async list(): Promise<CloudBotList> {
    const r = await this.cloud.request<Partial<CloudBotList>>('GET', '/v1/bots');
    return { ...r, bots: r.bots ?? [], paused_all: r.paused_all ?? false, pending_approvals: r.pending_approvals ?? 0 };
  }

  /** Ready-made bots, ranked for this org. */
  async templates(): Promise<CloudBotTemplate[]> {
    return (await this.cloud.request<{ templates?: CloudBotTemplate[] }>('GET', '/v1/bot-templates')).templates ?? [];
  }

  /** One template, by id (e.g. "spend-guard"). */
  async template(id: string): Promise<CloudBotTemplate> {
    return (await this.cloud.request<{ template: CloudBotTemplate }>('GET', `/v1/bot-templates/${enc(checkId(id, 'template id'))}`)).template;
  }

  /** What a template or spec would do, in words; `replay: true` adds what it would have done over the last 7 days. Saves nothing. */
  plan(opts: CloudBotPlanOptions): Promise<{ plan: CloudBotPlan; spec: CloudBotSpec; replay?: CloudBotReplay }> {
    const b = sourceBody(opts, 'plan');
    if (opts.name !== undefined) b.name = opts.name;
    if (opts.replay !== undefined) b.replay = opts.replay;
    return this.cloud.request('POST', '/v1/bots/plan', b);
  }

  /** Turn a sentence (at most 500 characters) into a spec and its plan. Never saves, never enables. */
  compile(text: string): Promise<{ spec: CloudBotSpec; plan: CloudBotPlan; source: 'ai' | 'rules' | (string & {}); notes: string[] }> {
    if (typeof text !== 'string' || text.trim() === '') throw new Kosa8Error('compile() needs a sentence describing the bot');
    if (text.length > MAX_BOT_SENTENCE) throw new Kosa8Error(`compile() takes at most ${MAX_BOT_SENTENCE} characters, got ${text.length}`);
    return this.cloud.request('POST', '/v1/bots/compile', { text });
  }

  /** Make a bot from exactly one of `template` or `spec`. It starts as a `draft`; a person enables it. */
  async create(opts: CloudBotCreateOptions): Promise<CloudBot> {
    const b = { ...sourceBody(opts, 'create'), ...settingsBody(opts) };
    return (await this.cloud.request<{ bot: CloudBot }>('POST', '/v1/bots', b)).bot;
  }

  /** One bot, with its spec, plan and versions. */
  async get(id: string): Promise<CloudBot> {
    return (await this.cloud.request<{ bot: CloudBot }>('GET', `/v1/bots/${enc(checkId(id, 'bot id'))}`)).bot;
  }

  /** Change a bot's name, spec, sponsor, budget, scope or notify. */
  async update(id: string, opts: CloudBotUpdateOptions): Promise<CloudBot> {
    return (await this.cloud.request<{ bot: CloudBot }>('PATCH', `/v1/bots/${enc(checkId(id, 'bot id'))}`, settingsBody(opts))).bot;
  }

  /** Delete a bot; its runs stay for history and its pending approvals are rejected. */
  async delete(id: string): Promise<void> {
    await this.cloud.request('DELETE', `/v1/bots/${enc(checkId(id, 'bot id'))}`);
  }

  /** Turn a bot on. A person's key only: otherwise `Kosa8HumanApprovalRequiredError`. */
  async enable(id: string): Promise<CloudBot> {
    return (await this.cloud.request<{ bot: CloudBot }>('POST', `/v1/bots/${enc(checkId(id, 'bot id'))}/enable`, {})).bot;
  }

  /** Pause a bot (any key with sandboxes:write). */
  async disable(id: string): Promise<CloudBot> {
    return (await this.cloud.request<{ bot: CloudBot }>('POST', `/v1/bots/${enc(checkId(id, 'bot id'))}/disable`, {})).bot;
  }

  /**
   * Run a bot now. A dry run (the default) says what it would do now and
   * replays the last 7 days; it changes nothing and is never billed. Pass
   * `{ dryRun: false }` for a real run (the bot must be `on`).
   */
  async run(id: string, opts: { dryRun?: boolean } = {}): Promise<CloudBotRun> {
    const body = { dry_run: opts.dryRun ?? true };
    return (await this.cloud.request<{ run: CloudBotRun }>('POST', `/v1/bots/${enc(checkId(id, 'bot id'))}/runs`, body)).run;
  }

  /** A bot's runs, newest first (`limit` 1..100). */
  async runs(id: string, opts: { limit?: number } = {}): Promise<CloudBotRun[]> {
    const path = `/v1/bots/${enc(checkId(id, 'bot id'))}/runs${limitQs(opts.limit)}`;
    return (await this.cloud.request<{ runs?: CloudBotRun[] }>('GET', path)).runs ?? [];
  }

  /** One run, with its steps. */
  async getRun(runId: string): Promise<CloudBotRun> {
    return (await this.cloud.request<{ run: CloudBotRun }>('GET', `/v1/bot-runs/${enc(checkId(runId, 'run id'))}`)).run;
  }

  /** Cancel a run; its pending approvals are rejected. */
  async cancelRun(runId: string): Promise<CloudBotRun> {
    return (await this.cloud.request<{ run: CloudBotRun }>('POST', `/v1/bot-runs/${enc(checkId(runId, 'run id'))}/cancel`, {})).run;
  }

  /** Undo one step of a run (wake the sandbox, remove the bot's own block, lift a label block). */
  async undoStep(runId: string, key: string): Promise<CloudBotRun> {
    const path = `/v1/bot-runs/${enc(checkId(runId, 'run id'))}/steps/${enc(checkId(key, 'step key'))}/undo`;
    return (await this.cloud.request<{ run: CloudBotRun }>('POST', path, {})).run;
  }

  /** Stop every bot in the org (any admin credential, agents included). */
  pauseAll(): Promise<{ paused_all: boolean; at: number }> {
    return this.cloud.request('POST', '/v1/bots/pause-all', {});
  }

  /** Let bots run again. A person's admin key only: otherwise `Kosa8HumanApprovalRequiredError`. */
  resumeAll(): Promise<{ paused_all: boolean; at: number }> {
    return this.cloud.request('POST', '/v1/bots/resume-all', {});
  }
}

/**
 * `cloud.approvals`: the T3 steps waiting for a person. Anyone with
 * `sandboxes:read` may list them. Deciding needs a person's key whose role
 * covers the action: an agent never approves its own action, and a person
 * approves in the web app, desktop, CLI or Slack. A capability token, MCP or
 * an org key with no member gets 403 `human_required`, thrown as
 * `Kosa8HumanApprovalRequiredError`.
 */
export class CloudApprovals {
  constructor(private readonly cloud: BotsRequester) {}

  /** Approvals by state (default `pending`), newest first. */
  async list(opts: { state?: 'pending' | 'decided' | 'all'; limit?: number } = {}): Promise<CloudApproval[]> {
    const path = `/v1/approvals${limitQs(opts.limit, { state: opts.state ?? 'pending' })}`;
    return (await this.cloud.request<{ approvals?: CloudApproval[] }>('GET', path)).approvals ?? [];
  }

  async get(id: string): Promise<CloudApproval> {
    return (await this.cloud.request<{ approval: CloudApproval }>('GET', `/v1/approvals/${enc(checkId(id, 'approval id'))}`)).approval;
  }

  /**
   * Approve, optionally with changed arguments (checked against the action's
   * schema). A person's key only. 409 `expired` / `decided` when it is too late.
   */
  approve(id: string, opts: { reason?: string; editedArgs?: Json } = {}): Promise<{ approval: CloudApproval; run: CloudBotRun }> {
    const b: Json = { decision: 'approve' };
    if (opts.reason !== undefined) b.reason = opts.reason;
    if (opts.editedArgs !== undefined) b.edited_args = opts.editedArgs;
    return this.decide(id, b);
  }

  /** Reject. A person's key only. */
  reject(id: string, opts: { reason?: string } = {}): Promise<{ approval: CloudApproval; run: CloudBotRun }> {
    const b: Json = { decision: 'reject' };
    if (opts.reason !== undefined) b.reason = opts.reason;
    return this.decide(id, b);
  }

  private decide(id: string, body: Json): Promise<{ approval: CloudApproval; run: CloudBotRun }> {
    return this.cloud.request('POST', `/v1/approvals/${enc(checkId(id, 'approval id'))}/decide`, body);
  }
}

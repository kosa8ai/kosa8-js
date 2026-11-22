// Copyright (c) 2026 kosa8. Licensed under the MIT License; see LICENSE.

/**
 * More of the kosa8 Cloud API: org templates, Burst Passes, capability
 * tokens, embeds, custom preview domains and desktop recordings. `cloud.ts`
 * wires these onto `Kosa8Cloud` and `CloudSandbox`; the types are the API's
 * own (snake_case fields, times in Unix ms unless the API says otherwise).
 */

import { Kosa8Error, Kosa8TimeoutError } from './errors.js';
import type { CloudRequester } from './cloud-features.js';

type Json = Record<string, unknown>;
const enc = encodeURIComponent;

function checkRange(name: string, v: number, min: number, max: number): void {
  if (!Number.isInteger(v) || v < min || v > max) {
    throw new Kosa8Error(`${name} must be a whole number from ${min} to ${max}, got ${v}`);
  }
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Org templates

/** An org template: an image or Dockerfile booted once and kept as a snapshot new sandboxes restore from. */
export interface CloudOrgTemplate {
  /** tpl_… */
  id: string;
  /** Create from it with `cloud.sandboxes.create({ template: name })`. */
  name: string;
  state: 'queued' | 'building' | 'ready' | 'failed' | (string & {});
  source: 'image' | 'dockerfile' | (string & {});
  image: string | null;
  /** sha256:… when the image was given by digest. */
  digest?: string | null;
  cpus?: number;
  mem_mb?: number;
  setup_cmd?: string[] | null;
  region?: string | null;
  /** While building: starting, dockerfile, boot, setup, snapshot. */
  phase?: string | null;
  snapshot_id?: string | null;
  builder_sandbox_id?: string | null;
  bytes?: number;
  import_id?: string | null;
  created_at?: number;
  started_at?: number | null;
  ready_at?: number | null;
  last_error?: string | null;
  /** `get` only: the build log's last 16 KiB. */
  log?: string;
  [k: string]: unknown;
}

interface TemplateSizeOptions {
  /** 2x4, 4x8, 8x16 or 16x32: the size it builds and boots at. */
  size?: '2x4' | '4x8' | '8x16' | '16x32' | (string & {});
  cpus?: number;
  memMb?: number;
  /** Run once in the booted template before it is saved (a string runs under sh -c). */
  setupCmd?: string | string[];
  region?: string;
}

export interface CloudOrgTemplateBuildOptions extends TemplateSizeOptions {
  /** Lowercase letters, digits, '.', '_' and '-', up to 63. */
  name: string;
  /** An OCI reference (a tag or @sha256 digest). Give image or dockerfile. */
  image?: string;
  /** The Dockerfile's text (no build context: COPY/ADD only --from= a stage or a URL). */
  dockerfile?: string;
  buildArgs?: Record<string, string>;
}

export interface CloudOrgTemplateImportOptions extends TemplateSizeOptions {
  /** Queue what can be queued and list the rest in `failed`, instead of refusing the call. */
  partialOk?: boolean;
}

export interface CloudOrgTemplateImport {
  import_id: string;
  requested: number;
  queued: number;
  builds_at_once?: number;
  templates: { id: string; name: string; image: string }[];
  failed: { index: number; name: string | null; code: string; message: string }[];
}

const TEMPLATE_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,62}$/;

function sizeBody(o: TemplateSizeOptions): Json {
  const body: Json = {};
  if ((o.cpus === undefined) !== (o.memMb === undefined)) throw new Kosa8Error('give cpus and memMb together');
  if (o.size !== undefined && o.cpus !== undefined) throw new Kosa8Error('give size or cpus+memMb, not both');
  if (o.size !== undefined) body.size = o.size;
  if (o.cpus !== undefined) body.cpus = o.cpus;
  if (o.memMb !== undefined) body.mem_mb = o.memMb;
  if (o.setupCmd !== undefined) body.setup_cmd = o.setupCmd;
  if (o.region !== undefined) body.region = o.region;
  return body;
}

function checkTemplateName(name: string): void {
  if (!TEMPLATE_NAME_RE.test(name)) {
    throw new Kosa8Error(`a template name is 1-63 lowercase letters, digits, '.', '_' or '-', starting with a letter or digit; got ${name}`);
  }
}

/**
 * The org's own templates. A build boots the image (or Dockerfile) once in
 * a sandbox of its size, runs `setupCmd` and saves a snapshot; sandboxes
 * created with `{ template: name }` then restore it instead of pulling the
 * image cold. At most 2 build at once; the rest wait queued.
 */
export class CloudOrgTemplates {
  constructor(private readonly cloud: CloudRequester) {}

  /** Queue a build (202). Poll with `get` or `wait` until it is ready. */
  async build(opts: CloudOrgTemplateBuildOptions): Promise<CloudOrgTemplate> {
    checkTemplateName(opts.name);
    if ((opts.image === undefined) === (opts.dockerfile === undefined)) throw new Kosa8Error('give image or dockerfile');
    const body: Json = { name: opts.name, ...sizeBody(opts) };
    if (opts.image !== undefined) body.image = opts.image;
    if (opts.dockerfile !== undefined) body.dockerfile = opts.dockerfile;
    if (opts.buildArgs !== undefined) body.build_args = opts.buildArgs;
    return (await this.cloud.request<{ template: CloudOrgTemplate }>('POST', '/v1/templates', body)).template;
  }

  /** Queue many image templates at once (up to 1000), such as RL task images by digest. */
  async import(images: { name: string; image: string }[], opts: CloudOrgTemplateImportOptions = {}): Promise<CloudOrgTemplateImport> {
    if (images.length < 1 || images.length > 1000) throw new Kosa8Error('import takes 1 to 1000 images');
    for (const i of images) checkTemplateName(i.name);
    const body: Json = { images, ...sizeBody(opts) };
    if (opts.partialOk !== undefined) body.partial_ok = opts.partialOk;
    const r = await this.cloud.request<Partial<CloudOrgTemplateImport>>('POST', '/v1/templates/import', body);
    return {
      import_id: r.import_id ?? '', requested: r.requested ?? images.length, queued: r.queued ?? 0,
      ...(r.builds_at_once !== undefined ? { builds_at_once: r.builds_at_once } : {}),
      templates: r.templates ?? [], failed: r.failed ?? [],
    };
  }

  /** A template by id (tpl_…) or name, with its build log. */
  async get(idOrName: string): Promise<CloudOrgTemplate> {
    return (await this.cloud.request<{ template: CloudOrgTemplate }>('GET', `/v1/templates/${enc(idOrName)}`)).template;
  }

  /** The org's own templates (the `org_templates` of GET /v1/templates). */
  async list(): Promise<CloudOrgTemplate[]> {
    return (await this.cloud.request<{ org_templates?: CloudOrgTemplate[] }>('GET', '/v1/templates')).org_templates ?? [];
  }

  /** Delete it: a build in flight stops and its snapshot is deleted. Sandboxes made from it are not touched. */
  async delete(idOrName: string): Promise<void> {
    await this.cloud.request('DELETE', `/v1/templates/${enc(idOrName)}`);
  }

  /** Poll until it is ready; throws if the build failed (with its `last_error`) or the time runs out (default 30 min). */
  async wait(idOrName: string, opts: { timeoutMs?: number; intervalMs?: number } = {}): Promise<CloudOrgTemplate> {
    const limit = opts.timeoutMs ?? 1_800_000;
    const every = opts.intervalMs ?? 3000;
    const deadline = Date.now() + limit;
    for (;;) {
      const t = await this.get(idOrName);
      if (t.state === 'ready') return t;
      if (t.state === 'failed') throw new Kosa8Error(`template ${t.name} failed to build: ${t.last_error ?? 'no reason given'}`);
      if (Date.now() + every > deadline) throw new Kosa8TimeoutError(`template ${t.name} still ${t.state} after ${limit} ms`);
      await sleepMs(every);
    }
  }
}

// ---------------------------------------------------------------------------
// Burst Passes

/** GET /v1/billing/burst. */
export interface CloudBurstStatus {
  /** false when no pass is sold here. */
  available: boolean;
  /** The pass: id, name, usd, hours, adds_running, adds_hours, max_active, url; null when not sold here. */
  pass: Json | null;
  /** Passes held, not yet activated. */
  held: number;
  /** Passes running now, each with ends_at (ISO 8601). */
  active: { id: string; burst: string; activated_at: string; ends_at: string }[];
  /** What they add now ({running, sandbox_hours}). */
  adds_now: { running: number; sandbox_hours: number };
  [k: string]: unknown;
}

/**
 * What activating answered: `{ ok, activated, ends_at, held, running_limit }`
 * when passes were held, or `{ url, quantity, activate_on_payment, usd }`, a
 * checkout for the rest, activated once paid.
 */
export interface CloudBurstActivation {
  ok?: boolean;
  activated?: number;
  ends_at?: string;
  held?: number;
  running_limit?: number | null;
  url?: string;
  quantity?: number;
  activate_on_payment?: number;
  usd?: number;
  [k: string]: unknown;
}

/** Burst Passes: each raises the running limit for its hours, stacking up to `max_active`. */
export class CloudBurst {
  constructor(private readonly cloud: CloudRequester) {}

  /** The pass, the passes held and those running. */
  get(): Promise<CloudBurstStatus> {
    return this.cloud.request('GET', '/v1/billing/burst');
  }

  /**
   * Activate `quantity` passes (default 1; an owner's admin key). Holding
   * fewer, the answer is a checkout `url` for the rest. 404 `not_available`
   * when none is sold here, 409 `burst_cap` past max_active, 402
   * `plan_required` without a plan.
   */
  activate(quantity = 1): Promise<CloudBurstActivation> {
    if (!Number.isInteger(quantity) || quantity < 1) throw new Kosa8Error('quantity must be a whole number of at least 1');
    return this.cloud.request('POST', '/v1/billing/burst', { quantity });
  }
}

// ---------------------------------------------------------------------------
// Capability tokens

export type CloudTokenScope = 'sandboxes:read' | 'sandboxes:write' | 'functions:invoke';

/** A capability token (k8c_tok_…): short-lived, limited to some scopes and, optionally, some sandboxes. */
export interface CloudCapabilityToken {
  id: string;
  name: string | null;
  /** k8c_tok_ and the first characters. */
  prefix: string;
  scopes: CloudTokenScope[];
  sandbox_ids: string[] | null;
  labels: Record<string, string> | null;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
  last_used_at: number | null;
  created_by_key?: string | null;
  member_email?: string | null;
  state: 'active' | 'expired' | 'revoked' | (string & {});
  /** k8c_tok_…: only in the answer that made it. Pass it as `apiKey` to a `Kosa8Cloud`. */
  secret?: string;
  [k: string]: unknown;
}

export interface CloudTokenOptions {
  /** At least one, and only scopes the maker holds. */
  scopes: CloudTokenScope[];
  /** Sandboxes (sbx_…) it may reach, up to 100. */
  sandboxIds?: string[];
  /** Labels every sandbox it reaches must carry; a sandbox it creates gets them. */
  labels?: Record<string, string>;
  /** Lifetime, 60..86400 s; default 3600. */
  ttlS?: number;
  name?: string;
}

/**
 * Capability tokens: hand an agent or a browser a credential that reaches
 * only some sandboxes, for at most a day. A limited token answers 403
 * `token_restricted` on every other route. A token cannot make tokens.
 */
export class CloudTokens {
  constructor(private readonly cloud: CloudRequester) {}

  /** Make one; its `secret` is shown only here. */
  async create(opts: CloudTokenOptions): Promise<CloudCapabilityToken> {
    if (!opts.scopes?.length) throw new Kosa8Error('a token needs at least one scope');
    const body: Json = { scopes: opts.scopes };
    if (opts.sandboxIds !== undefined) {
      if (opts.sandboxIds.length < 1 || opts.sandboxIds.length > 100) throw new Kosa8Error('sandboxIds takes 1 to 100 ids');
      body.sandbox_ids = opts.sandboxIds;
    }
    if (opts.labels !== undefined) body.labels = opts.labels;
    if (opts.ttlS !== undefined) {
      checkRange('ttlS', opts.ttlS, 60, 86_400);
      body.ttl_s = opts.ttlS;
    }
    if (opts.name !== undefined) body.name = opts.name;
    return (await this.cloud.request<{ token: CloudCapabilityToken }>('POST', '/v1/tokens', body)).token;
  }

  /** Tokens (never secrets); with `all`, the last day's revoked and expired ones too. */
  async list(opts: { all?: boolean } = {}): Promise<CloudCapabilityToken[]> {
    return (await this.cloud.request<{ tokens?: CloudCapabilityToken[] }>('GET', `/v1/tokens${opts.all ? '?all=1' : ''}`)).tokens ?? [];
  }

  /** Revoke one; it stops at once. */
  async revoke(id: string): Promise<CloudCapabilityToken> {
    return (await this.cloud.request<{ token: CloudCapabilityToken }>('DELETE', `/v1/tokens/${enc(id)}`)).token;
  }
}

// ---------------------------------------------------------------------------
// Embeds

/** A signed, expiring iframe URL for a sandbox's terminal or desktop. */
export interface CloudEmbed {
  /** emb_… */
  id: string;
  sandbox_id: string;
  mode: 'view' | 'interact';
  ui: 'terminal' | 'desktop';
  origins: string[];
  command: string[] | null;
  created_at: number;
  expires_at: number;
  revoked: boolean;
  /** Create only: the iframe URL. It is the credential: give it only to pages you trust. */
  url?: string;
  /** Create only: an <iframe> tag. */
  snippet?: string;
  [k: string]: unknown;
}

export interface CloudEmbedOptions {
  /** The origins that may frame it and receive its postMessage events (1..10), e.g. https://app.example.com. */
  origins: string[];
  /** view (default): watch only, enforced by the server; interact: mouse and keyboard too. */
  mode?: 'view' | 'interact';
  /** terminal (default), or desktop (the kosa8-desktop image's noVNC). */
  ui?: 'terminal' | 'desktop';
  /** How long the URL works, 60..604800 s (default 3600), never past the sandbox's delete_after. */
  ttlS?: number;
  /** Terminal only: the program to show instead of the default. */
  command?: string[];
}

/**
 * A sandbox's embeds. The framed page posts `{source: "kosa8", type}`
 * messages to the listed origins: ready, exited {code}, approval_requested
 * {approval}, expired.
 */
export class CloudEmbeds {
  constructor(private readonly cloud: CloudRequester, private readonly sandboxPath: string) {}

  async create(opts: CloudEmbedOptions): Promise<CloudEmbed> {
    if (!opts.origins?.length || opts.origins.length > 10) throw new Kosa8Error('an embed takes 1 to 10 origins');
    const body: Json = { origins: opts.origins };
    if (opts.mode !== undefined) body.mode = opts.mode;
    if (opts.ui !== undefined) body.ui = opts.ui;
    if (opts.ttlS !== undefined) {
      checkRange('ttlS', opts.ttlS, 60, 604_800);
      body.ttl_s = opts.ttlS;
    }
    if (opts.command !== undefined) body.command = opts.command;
    return (await this.cloud.request<{ embed: CloudEmbed }>('POST', `${this.sandboxPath}/embed`, body)).embed;
  }

  /** Its live embeds (no URLs). */
  async list(): Promise<CloudEmbed[]> {
    return (await this.cloud.request<{ embeds?: CloudEmbed[] }>('GET', `${this.sandboxPath}/embeds`)).embeds ?? [];
  }

  /** End an embed's URL before it expires. */
  async revoke(embedId: string): Promise<void> {
    await this.cloud.request('DELETE', `${this.sandboxPath}/embeds/${enc(embedId)}`);
  }
}

// ---------------------------------------------------------------------------
// Custom preview domains

/** A DNS record to make at your DNS provider. */
export interface CloudDnsRecord {
  type: 'CNAME' | 'TXT';
  name: string;
  value: string;
  /** routing (the CNAME) is needed; ownership and certificate TXT records let it validate before the CNAME moves. */
  purpose: 'routing' | 'ownership' | 'certificate';
}

/** A preview served at your own hostname. */
export interface CloudPreviewDomain {
  hostname: string;
  url: string;
  sandbox_id: string;
  port: number;
  preview_id: string;
  status: 'pending' | 'active' | 'failed' | (string & {});
  ssl_status: string | null;
  records: CloudDnsRecord[];
  error: string | null;
  instructions?: string;
  created_at: number;
  checked_at: number | null;
  [k: string]: unknown;
}

/**
 * A preview's custom domains (at most 5 a preview, 50 an org). The domain
 * serves the preview as it is, private or public, and follows it across a
 * rotate. 501 `not_available` where custom hostnames are not configured.
 */
export class CloudPreviewDomains {
  constructor(private readonly cloud: CloudRequester, private readonly previewPath: string) {}

  async list(): Promise<{ domains: CloudPreviewDomain[]; configured: boolean; cnameTarget: string | null }> {
    const r = await this.cloud.request<{ domains?: CloudPreviewDomain[]; configured?: boolean; cname_target?: string | null }>(
      'GET', `${this.previewPath}/domains`,
    );
    return { domains: r.domains ?? [], configured: r.configured === true, cnameTarget: r.cname_target ?? null };
  }

  /** Serve the preview at `hostname` (under your own domain); make the `records` it answers at your DNS provider. */
  async add(hostname: string, opts: { sslMethod?: 'http' | 'txt' } = {}): Promise<CloudPreviewDomain> {
    const body: Json = { hostname };
    if (opts.sslMethod !== undefined) body.ssl_method = opts.sslMethod;
    return (await this.cloud.request<{ domain: CloudPreviewDomain }>('POST', `${this.previewPath}/domains`, body)).domain;
  }

  /** Its status, asked of the certificate provider again. */
  async get(hostname: string): Promise<CloudPreviewDomain> {
    return (await this.cloud.request<{ domain: CloudPreviewDomain }>('GET', `${this.previewPath}/domains/${enc(hostname)}`)).domain;
  }

  /** Stop serving the preview at `hostname`. */
  async remove(hostname: string): Promise<void> {
    await this.cloud.request('DELETE', `${this.previewPath}/domains/${enc(hostname)}`);
  }
}

// ---------------------------------------------------------------------------
// Recordings

/** A desktop session recording (MP4), made when a sandbox created with `record: true` is deleted. */
export interface CloudRecording {
  /** rec_… */
  id: string;
  sandbox_id: string;
  state: 'saving' | 'ready' | 'failed' | (string & {});
  bytes: number | null;
  error: string | null;
  content_type?: string;
  created_at: number;
  /** Deleted then, by the plan's retention. */
  expires_at: number;
  [k: string]: unknown;
}

export interface CloudRecordingList {
  recordings: CloudRecording[];
  /** Whether recordings are set up on this kosa8 Cloud. */
  configured: boolean;
  retentionDays: number | null;
}

/** The org's desktop recordings. */
export class CloudRecordings {
  constructor(private readonly cloud: CloudRequester) {}

  /** Newest first; `sandboxId` for one sandbox's, `limit` 1..200. */
  async list(opts: { sandboxId?: string; limit?: number } = {}): Promise<CloudRecordingList> {
    const q = new URLSearchParams();
    if (opts.sandboxId !== undefined) q.set('sandbox_id', opts.sandboxId);
    if (opts.limit !== undefined) {
      checkRange('limit', opts.limit, 1, 200);
      q.set('limit', String(opts.limit));
    }
    const qs = q.toString();
    const r = await this.cloud.request<{ recordings?: CloudRecording[]; configured?: boolean; retention_days?: number }>(
      'GET', `/v1/recordings${qs ? `?${qs}` : ''}`,
    );
    return { recordings: r.recordings ?? [], configured: r.configured === true, retentionDays: r.retention_days ?? null };
  }

  /** A signed download URL for its MP4 (`ttlS` 60..86400, default 900). */
  async link(id: string, opts: { ttlS?: number } = {}): Promise<{ url: string; expires_at: number; bytes: number | null }> {
    const body: Json = {};
    if (opts.ttlS !== undefined) {
      checkRange('ttlS', opts.ttlS, 60, 86_400);
      body.ttl_s = opts.ttlS;
    }
    return (await this.cloud.request<{ link: { url: string; expires_at: number; bytes: number | null } }>(
      'POST', `/v1/recordings/${enc(id)}/link`, body,
    )).link;
  }

  /** Delete it now. */
  async delete(id: string): Promise<void> {
    await this.cloud.request('DELETE', `/v1/recordings/${enc(id)}`);
  }
}

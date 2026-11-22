// Copyright (c) 2026 kosa8. Licensed under the MIT License; see LICENSE.

/**
 * kosa8 Cloud browsers (headless Chromium driven over CDP) and the AI
 * gateway. `cloud.ts` wires these onto `Kosa8Cloud` as `cloud.browsers` and
 * `cloud.ai`. A browser costs $0.12 per browser-hour, billed per second.
 *
 * ```ts
 * await using b = await cloud.browser({ ttlS: 120 });
 * const png = await b.screenshot('https://example.com');
 * const pw = await chromium.connectOverCDP(b.cdpUrl!);
 * ```
 */

import { Kosa8Error } from './errors.js';
import { ensureDisposeSymbols } from './dispose.js';
import type { CloudRequester } from './cloud-features.js';

ensureDisposeSymbols();

type Json = Record<string, unknown>;

const enc = encodeURIComponent;

/** USD per browser-hour, billed per second (the API's `price_per_hour_usd` is the live figure). */
export const BROWSER_PRICE_PER_HOUR_USD = 0.12;

/** A browser as the API reports it. */
export interface CloudBrowserInfo {
  /** brw_… */
  id: string;
  name: string | null;
  sandbox_id: string | null;
  state: 'open' | 'closed' | string;
  ttl_s: number;
  created_at: number | string;
  expires_at: number | string;
  closed_at: number | string | null;
  close_reason: string | null;
  /** Seconds open (what is billed). */
  seconds: number;
  /** `wss://…/cdp?token=…`, valid 10 minutes; only on create and get while open. */
  cdp_url?: string | null;
  cdp_url_expires_at?: number | string | null;
}

export interface CloudBrowserOptions {
  /** 30..3600 s, default 300: it closes on its own after this. */
  ttlS?: number;
  /** Tie it to a sandbox. */
  sandboxId?: string;
  /** A label. */
  name?: string;
}

export interface CloudBrowserPageOptions {
  screenshot?: boolean;
  text?: boolean;
  fullPage?: boolean;
}

export interface CloudBrowserPage {
  url: string;
  title: string;
  text?: string;
  screenshot_png_base64?: string;
}

export interface CloudBrowserList {
  browsers: CloudBrowserInfo[];
  enabled: boolean;
  limit: number;
  price_per_hour_usd: number;
}

function checkTtl(ttlS: number | undefined): void {
  if (ttlS === undefined) return;
  if (!Number.isInteger(ttlS) || ttlS < 30 || ttlS > 3600) {
    throw new Kosa8Error(`ttlS must be a whole number from 30 to 3600, got ${String(ttlS)}`);
  }
}

function fromBase64(b64: string): Uint8Array {
  const B = (globalThis as { Buffer?: { from(s: string, e: string): Uint8Array } }).Buffer;
  if (B) return B.from(b64, 'base64');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * One cloud browser. `info` is its state as of the last call; `cdpUrl`
 * (valid 10 minutes) connects Playwright (`chromium.connectOverCDP`) or
 * Puppeteer (`connect({ browserWSEndpoint })`); `refresh()` gets a fresh one.
 * `await using b = await cloud.browser()` closes it on the way out.
 */
export class CloudBrowser {
  constructor(private readonly cloud: CloudRequester, public info: CloudBrowserInfo) {}

  get id(): string {
    return this.info.id;
  }

  get state(): string {
    return this.info.state;
  }

  /** `wss://…` for `connectOverCDP` while open; undefined when closed or from a list. */
  get cdpUrl(): string | undefined {
    return this.info.cdp_url ?? undefined;
  }

  private get path(): string {
    return `/v1/browsers/${enc(this.id)}`;
  }

  /** Never the cdp_url (it carries a token). */
  toJSON(): Json {
    const { cdp_url: _drop, ...rest } = this.info;
    return rest as Json;
  }

  /** Read it again: its state and, while open, a fresh `cdpUrl`. */
  async refresh(): Promise<this> {
    this.info = (await this.cloud.request<{ browser: CloudBrowserInfo }>('GET', this.path)).browser;
    return this;
  }

  /** Load `url` in it: `url`, `title` and, if asked, `text` and `screenshot_png_base64`. */
  async page(url: string, opts: CloudBrowserPageOptions = {}): Promise<CloudBrowserPage> {
    if (typeof url !== 'string' || !url) throw new Kosa8Error('url is required');
    const body: Json = { url };
    if (opts.screenshot !== undefined) body.screenshot = opts.screenshot;
    if (opts.text !== undefined) body.text = opts.text;
    if (opts.fullPage !== undefined) body.full_page = opts.fullPage;
    return (await this.cloud.request<{ page: CloudBrowserPage }>('POST', `${this.path}/page`, body)).page;
  }

  /** Load `url`; `url`, `title` and (unless `text: false`) the page's `text`. */
  goto(url: string, opts: { text?: boolean } = {}): Promise<CloudBrowserPage> {
    return this.page(url, { text: opts.text ?? true });
  }

  /** Load `url` and return a PNG of it (a Buffer on Node): the viewport, or the whole page with `fullPage`. */
  async screenshot(url: string, opts: { fullPage?: boolean } = {}): Promise<Uint8Array> {
    const p = await this.page(url, { screenshot: true, ...(opts.fullPage ? { fullPage: true } : {}) });
    if (!p.screenshot_png_base64) throw new Kosa8Error('the API sent no screenshot');
    return fromBase64(p.screenshot_png_base64);
  }

  /** Close it; billing stops. */
  async close(): Promise<{ ok: boolean; id: string }> {
    const r = await this.cloud.request<{ ok: boolean; id: string }>('DELETE', this.path);
    this.info = { ...this.info, state: 'closed', cdp_url: null };
    return r;
  }

  /** `await using b = await cloud.browser()` closes it, error or not. */
  async [Symbol.asyncDispose](): Promise<void> {
    try {
      await this.close();
    } catch {
      // closing on the way out must not hide the real error
    }
  }
}

/** The org's cloud browsers: headless Chromium on demand. $0.12 per browser-hour, billed per second. */
export class CloudBrowsers {
  constructor(private readonly cloud: CloudRequester) {}

  /** Open a browser. */
  async create(opts: CloudBrowserOptions = {}): Promise<CloudBrowser> {
    checkTtl(opts.ttlS);
    const body: Json = {};
    if (opts.ttlS !== undefined) body.ttl_s = opts.ttlS;
    if (opts.sandboxId !== undefined) body.sandbox_id = opts.sandboxId;
    if (opts.name !== undefined) body.name = opts.name;
    const r = await this.cloud.request<{ browser: CloudBrowserInfo }>('POST', '/v1/browsers', body);
    return new CloudBrowser(this.cloud, r.browser);
  }

  /** The list answer as sent: `browsers` (no cdp_url), `enabled`, `limit`, `price_per_hour_usd`. */
  async info(opts: { state?: 'open' | 'all' } = {}): Promise<CloudBrowserList> {
    if (opts.state !== undefined && opts.state !== 'open' && opts.state !== 'all') {
      throw new Kosa8Error('state must be "open" or "all"');
    }
    return this.cloud.request<CloudBrowserList>('GET', '/v1/browsers' + (opts.state ? `?state=${enc(opts.state)}` : ''));
  }

  /** Open browsers (`state: 'all'` for closed ones too). Items have no `cdpUrl`: `refresh()` one. */
  async list(opts: { state?: 'open' | 'all' } = {}): Promise<CloudBrowser[]> {
    return ((await this.info(opts)).browsers ?? []).map((b) => new CloudBrowser(this.cloud, b));
  }

  /** One browser, with a fresh `cdpUrl` while open. */
  async get(id: string): Promise<CloudBrowser> {
    const r = await this.cloud.request<{ browser: CloudBrowserInfo }>('GET', `/v1/browsers/${enc(id)}`);
    return new CloudBrowser(this.cloud, r.browser);
  }

  /** Close a browser by id. */
  delete(id: string): Promise<{ ok: boolean; id: string }> {
    return this.cloud.request('DELETE', `/v1/browsers/${enc(id)}`);
  }
}

// ---------------------------------------------------------------------------
// AI gateway

export interface CloudAiSettingsValues {
  enabled: boolean;
  /** Every sandbox uses the gateway, not only those created with `aiGateway: true`. */
  all_sandboxes: boolean;
  cache_ttl_s: number;
  rate_per_min: number;
}

export interface CloudAiSettings {
  settings: CloudAiSettingsValues;
  available: boolean;
  base_url: string;
  gateway_id: string;
  providers: string[];
  workers_ai: unknown;
  configured: unknown;
}

export interface CloudAiSettingsUpdate {
  enabled?: boolean;
  allSandboxes?: boolean;
  cacheTtlS?: number;
  ratePerMin?: number;
}

export interface CloudAiKey {
  provider: string;
  /** The key's last characters, never the key. */
  hint: string;
  created_at: number | string;
  updated_at: number | string;
}

export interface CloudAiUsageTotal {
  calls: number;
  cost_usd: number;
  tokens_in: number;
  tokens_out: number;
  cached: number;
  errors: number;
}

export interface CloudAiUsage {
  month: string;
  total: CloudAiUsageTotal;
  by_model: unknown[];
  by_sandbox: unknown[];
  recent: unknown[];
}

/**
 * The org's AI gateway: provider keys kept server-side, caching, a rate
 * limit and usage. A sandbox created with `aiGateway: true` calls models
 * through it (`OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL`, `KOSA8_AI_GATEWAY_URL`
 * and `KOSA8_AI_TOKEN` are set in its env).
 */
export class CloudAi {
  constructor(private readonly cloud: CloudRequester) {}

  settings(): Promise<CloudAiSettings> {
    return this.cloud.request('GET', '/v1/ai/settings');
  }

  /** Change the given settings only. */
  updateSettings(opts: CloudAiSettingsUpdate): Promise<Json> {
    const body: Json = {};
    if (opts.enabled !== undefined) body.enabled = opts.enabled;
    if (opts.allSandboxes !== undefined) body.all_sandboxes = opts.allSandboxes;
    if (opts.cacheTtlS !== undefined) body.cache_ttl_s = opts.cacheTtlS;
    if (opts.ratePerMin !== undefined) body.rate_per_min = opts.ratePerMin;
    if (Object.keys(body).length === 0) return Promise.reject(new Kosa8Error('give at least one setting to change'));
    return this.cloud.request('PATCH', '/v1/ai/settings', body);
  }

  /** Store a provider's API key (`openai`, `anthropic`…). It is never sent back. */
  setKey(provider: string, key: string): Promise<Json> {
    if (!provider || !key) return Promise.reject(new Kosa8Error('provider and key are required'));
    return this.cloud.request('PUT', `/v1/ai/keys/${enc(provider)}`, { key });
  }

  /** Stored keys (a hint, never the key). */
  async keys(): Promise<CloudAiKey[]> {
    return (await this.cloud.request<{ keys?: CloudAiKey[] }>('GET', '/v1/ai/keys')).keys ?? [];
  }

  deleteKey(provider: string): Promise<Json> {
    return this.cloud.request('DELETE', `/v1/ai/keys/${enc(provider)}`);
  }

  /** A month's (`YYYY-MM`, default this one) calls and cost. */
  usage(month?: string): Promise<CloudAiUsage> {
    if (month !== undefined && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      return Promise.reject(new Kosa8Error(`month must be YYYY-MM, got ${month}`));
    }
    return this.cloud.request('GET', '/v1/ai/usage' + (month ? `?month=${enc(month)}` : ''));
  }
}

// Copyright (c) 2026 kosa8. Licensed under the MIT License; see LICENSE.

import { describe, expect, it } from 'vitest';
import { BROWSER_PRICE_PER_HOUR_USD, CloudBrowser, Kosa8ApiError, Kosa8Error } from '../src/index.js';
import type { CloudBrowserInfo } from '../src/index.js';
import { info, mockCloud, route } from './helpers.js';
import type { Answer, Seen } from './helpers.js';

const CDP = 'wss://api.kosa8.com/v1/browsers/brw_1/cdp?token=t0k';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

const brw = (over: Partial<CloudBrowserInfo> = {}): CloudBrowserInfo => ({
  id: 'brw_1', name: null, sandbox_id: null, state: 'open', ttl_s: 300, created_at: 1, expires_at: 2,
  closed_at: null, close_reason: null, seconds: 0, cdp_url: CDP, cdp_url_expires_at: 3, ...over,
});

function browserApi(s: Seen): Answer {
  const r = route(s);
  if (r === 'POST /v1/browsers') return [201, { browser: brw(s.body as Partial<CloudBrowserInfo>), price_per_hour_usd: 0.12 }];
  if (r === 'GET /v1/browsers') {
    const { cdp_url: _c, ...item } = brw();
    return [200, { browsers: [item], enabled: true, limit: 5, price_per_hour_usd: 0.12 }];
  }
  if (r === 'GET /v1/browsers/brw_1') return [200, { browser: brw({ cdp_url: CDP + '2' }) }];
  if (r === 'DELETE /v1/browsers/brw_1') return [200, { ok: true, id: 'brw_1' }];
  if (r === 'POST /v1/browsers/brw_1/page') {
    const b = s.body as { url: string; text?: boolean; screenshot?: boolean };
    const page: Record<string, unknown> = { url: b.url, title: 'Example Domain' };
    if (b.text) page.text = 'Example Domain';
    if (b.screenshot) page.screenshot_png_base64 = Buffer.from(PNG).toString('base64');
    return [200, { browser_id: 'brw_1', page }];
  }
  if (r === 'GET /v1/browsers/brw_gone') return [410, { error: 'browser_closed', message: 'browser is closed' }];
  return [404, { error: 'not_found' }];
}

describe('browsers', () => {
  it('creates with options in API names', async () => {
    const { cloud, seen } = mockCloud(browserApi);
    const b = await cloud.browser({ ttlS: 60, sandboxId: 'sbx_1', name: 'scrape' });
    expect(b).toBeInstanceOf(CloudBrowser);
    expect(seen[0]!.body).toEqual({ ttl_s: 60, sandbox_id: 'sbx_1', name: 'scrape' });
    expect(b.id).toBe('brw_1');
    expect(b.cdpUrl).toBe(CDP);
    expect(JSON.stringify(b)).not.toContain('t0k');
  });

  it('sends an empty body by default', async () => {
    const { cloud, seen } = mockCloud(browserApi);
    await cloud.browsers.create();
    expect(seen[0]!.body).toEqual({});
  });

  it('checks ttlS before any request', async () => {
    const { cloud, seen } = mockCloud(browserApi);
    for (const bad of [10, 4000, 1.5]) await expect(cloud.browser({ ttlS: bad })).rejects.toThrow(Kosa8Error);
    expect(seen).toHaveLength(0);
  });

  it('refresh gets a fresh cdpUrl', async () => {
    const { cloud } = mockCloud(browserApi);
    const b = await cloud.browser();
    expect(await b.refresh()).toBe(b);
    expect(b.cdpUrl).toBe(CDP + '2');
  });

  it('goto returns text', async () => {
    const { cloud, seen } = mockCloud(browserApi);
    const p = await (await cloud.browser()).goto('https://example.com');
    expect(seen.at(-1)!.body).toEqual({ url: 'https://example.com', text: true });
    expect(p.title).toBe('Example Domain');
    expect(p.text).toBe('Example Domain');
  });

  it('screenshot decodes the PNG', async () => {
    const { cloud, seen } = mockCloud(browserApi);
    const b = await cloud.browser();
    expect(Array.from(await b.screenshot('https://example.com'))).toEqual(Array.from(PNG));
    expect(seen.at(-1)!.body).toEqual({ url: 'https://example.com', screenshot: true });
    await b.screenshot('https://example.com', { fullPage: true });
    expect(seen.at(-1)!.body).toEqual({ url: 'https://example.com', screenshot: true, full_page: true });
  });

  it('close and asyncDispose delete it', async () => {
    const { cloud, seen } = mockCloud(browserApi);
    const b = await cloud.browser();
    await b[Symbol.asyncDispose]();
    expect(route(seen.at(-1)!)).toBe('DELETE /v1/browsers/brw_1');
    expect(b.state).toBe('closed');
    expect(b.cdpUrl).toBeUndefined();
  });

  it('lists, gets and deletes', async () => {
    const { cloud, seen } = mockCloud(browserApi);
    const bs = await cloud.listBrowsers({ state: 'all' });
    expect(seen.at(-1)!.url.searchParams.get('state')).toBe('all');
    expect(bs.map((b) => b.id)).toEqual(['brw_1']);
    expect(bs[0]!.cdpUrl).toBeUndefined();
    expect((await cloud.browsers.info()).limit).toBe(5);
    expect((await cloud.getBrowser('brw_1')).cdpUrl).toBe(CDP + '2');
    expect(await cloud.browsers.delete('brw_1')).toEqual({ ok: true, id: 'brw_1' });
    await expect(cloud.listBrowsers({ state: 'closed' as 'all' })).rejects.toThrow(Kosa8Error);
  });

  it('a closed browser is a 410 API error', async () => {
    const { cloud } = mockCloud(browserApi);
    const e = await cloud.getBrowser('brw_gone').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(Kosa8ApiError);
    expect((e as Kosa8ApiError).status).toBe(410);
  });

  it('exports the price', () => {
    expect(BROWSER_PRICE_PER_HOUR_USD).toBe(0.12);
  });
});

function aiApi(s: Seen): Answer {
  const r = route(s);
  if (r === 'GET /v1/ai/settings') {
    return [200, {
      settings: { enabled: true, all_sandboxes: false, cache_ttl_s: 0, rate_per_min: 60 }, available: true,
      base_url: 'https://gw', gateway_id: 'g', providers: ['openai'], workers_ai: true, configured: true,
    }];
  }
  if (r === 'PATCH /v1/ai/settings') return [200, { settings: s.body }];
  if (r === 'PUT /v1/ai/keys/openai') return [200, { ok: true, provider: 'openai', hint: 'sk-...abcd' }];
  if (r === 'GET /v1/ai/keys') {
    return [200, { keys: [{ provider: 'openai', hint: 'sk-...abcd', created_at: 1, updated_at: 1 }], providers: ['openai'] }];
  }
  if (r === 'DELETE /v1/ai/keys/openai') return [200, { ok: true }];
  if (r === 'GET /v1/ai/usage') return [200, { month: s.url.searchParams.get('month') ?? '2026-11', total: { calls: 3 } }];
  if (r === 'POST /v1/sandboxes') return [201, { sandbox: info() }];
  return [404, { error: 'not_found' }];
}

describe('AI gateway', () => {
  it('reads and changes settings', async () => {
    const { cloud, seen } = mockCloud(aiApi);
    expect((await cloud.aiSettings()).settings.enabled).toBe(true);
    await cloud.updateAiSettings({ enabled: true, allSandboxes: true, cacheTtlS: 60, ratePerMin: 120 });
    expect(seen.at(-1)!.body).toEqual({ enabled: true, all_sandboxes: true, cache_ttl_s: 60, rate_per_min: 120 });
    await expect(cloud.ai.updateSettings({})).rejects.toThrow(Kosa8Error);
  });

  it('sets, lists and deletes keys', async () => {
    const { cloud, seen } = mockCloud(aiApi);
    await cloud.setAiKey('openai', 'sk-secret');
    expect(seen.at(-1)!.body).toEqual({ key: 'sk-secret' });
    expect((await cloud.listAiKeys())[0]!.provider).toBe('openai');
    expect(await cloud.deleteAiKey('openai')).toEqual({ ok: true });
    expect(route(seen.at(-1)!)).toBe('DELETE /v1/ai/keys/openai');
    await expect(cloud.setAiKey('openai', '')).rejects.toThrow(Kosa8Error);
  });

  it('reads usage', async () => {
    const { cloud, seen } = mockCloud(aiApi);
    expect((await cloud.aiUsage()).total.calls).toBe(3);
    expect(seen.at(-1)!.url.search).toBe('');
    expect((await cloud.aiUsage('2026-10')).month).toBe('2026-10');
    await expect(cloud.aiUsage('2026-13')).rejects.toThrow(Kosa8Error);
  });

  it('sends ai_gateway on sandbox create', async () => {
    const { cloud, seen } = mockCloud(aiApi);
    await cloud.sandboxes.create({ aiGateway: true });
    expect(seen.at(-1)!.body).toEqual({ ai_gateway: true });
    await cloud.sandboxes.create({ aiGateway: false });
    expect(seen.at(-1)!.body).toEqual({ ai_gateway: false });
    await cloud.sandboxes.create();
    expect(seen.at(-1)!.body).not.toHaveProperty('ai_gateway');
  });
});

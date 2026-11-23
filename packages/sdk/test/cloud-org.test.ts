// Copyright (c) 2026 kosa8. Licensed under the MIT License; see LICENSE.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Kosa8Error, RetryPolicy, SDK_VERSION, USER_AGENT, classifyFailure, failureOf } from '../src/index.js';
import { info, mockCloud, route } from './helpers.js';
import type { Answer, Seen } from './helpers.js';

const BUSY: Answer = [503, {
  error: 'database_busy', message: "kosa8 Cloud's database is overloaded right now; try again in a few seconds",
  failure_class: 'infra', retryable: true, retry_after: 2, retry_after_s: 2,
}, { 'Retry-After': '2' }];
const BUILDING: Answer = [409, {
  error: 'template_building', message: 'the environment is being built', template: 'swe/x', state: 'building',
  eta_s: 40, retry_after_s: 10, failure_class: 'infra', retryable: true,
}, { 'Retry-After': '10' }];

/** Retries that wait at most a millisecond, Retry-After included. */
const FAST = { retry: { baseMs: 1, maxMs: 2, maxRetryAfterMs: 1 } };

describe('retries', () => {
  it('retries a create (POST) on 503 database_busy, then succeeds', async () => {
    const { cloud, seen } = mockCloud((s, n) => (n < 2 ? BUSY : [201, { sandbox: info() }]), FAST);
    const box = await cloud.sandboxes.create({ wait: false });
    expect(box.id).toBe('sbx_1');
    expect(seen.map(route)).toEqual(['POST /v1/sandboxes', 'POST /v1/sandboxes', 'POST /v1/sandboxes']);
  });

  it('retries a POST without an Idempotency-Key on database_busy', async () => {
    const { cloud, seen } = mockCloud((_s, n) => (n === 0 ? BUSY : [201, { webhook: { id: 'wh_1', secret: 's' } }]), FAST);
    expect((await cloud.webhooks.create('https://x')).id).toBe('wh_1');
    expect(seen).toHaveLength(2);
    expect(seen[0]!.headers['Idempotency-Key']).toBeUndefined();
  });

  it('retries a POST on 409 template_building and on 429', async () => {
    const answers: Answer[] = [BUILDING, [429, { error: 'rate_limited', message: 'slow down' }, { 'Retry-After': '1' }], [201, { sandbox: info() }]];
    const { cloud, seen } = mockCloud((_s, n) => answers[n]!, FAST);
    await cloud.sandboxes.create({ template: 'swe/x', wait: false });
    expect(seen).toHaveLength(3);
  });

  it('gives up after the policy\'s attempts and throws the last error', async () => {
    const { cloud, seen } = mockCloud(() => BUSY, FAST);
    const e = await cloud.sandboxes.create({ wait: false }).catch((x) => x);
    expect(e).toBeInstanceOf(Kosa8Error);
    expect(e.code).toBe('database_busy');
    expect(e.retryable).toBe(true);
    expect(e.failureClass).toBe('infra');
    expect(seen).toHaveLength(3);
  });

  it('does not resend a POST without an Idempotency-Key on a plain 5xx (it may have run), but does resend a GET', async () => {
    const { cloud, seen } = mockCloud(() => [502, { error: 'host_failed', message: 'host failed' }], FAST);
    await expect(cloud.webhooks.create('https://x')).rejects.toThrow();
    expect(seen).toHaveLength(1);
    const c = mockCloud(() => [502, { error: 'host_failed', message: 'host failed' }], FAST);
    await expect(c.cloud.sandboxes.create({ wait: false })).rejects.toThrow();
    expect(c.seen).toHaveLength(3);
    // The SDK's own key is renewed after each 5xx: every retry is a new attempt.
    expect(new Set(c.seen.map((x) => x.headers['Idempotency-Key'])).size).toBe(3);
    const g = mockCloud(() => [502, { error: 'host_failed', message: 'host failed' }], FAST);
    await expect(g.cloud.limits()).rejects.toThrow();
    expect(g.seen).toHaveLength(3);
  });

  it('honours retryable: false and client errors (no retry)', async () => {
    const { cloud, seen } = mockCloud(() => [400, { error: 'invalid_size', message: 'bad size' }], FAST);
    await expect(cloud.limits()).rejects.toThrow(/bad size/);
    expect(seen).toHaveLength(1);
    const q = mockCloud(() => [503, { error: 'whatever', message: 'no', failure_class: 'infra', retryable: false }], FAST);
    await expect(q.cloud.pricing()).rejects.toThrow();
    expect(q.seen).toHaveLength(1);
  });

  it('honours retryable: true in a body on a GET whatever its status', async () => {
    const { cloud, seen } = mockCloud((_s, n) => (n === 0 ? [409, { error: 'odd', message: 'x', retryable: true, failure_class: 'infra' }] : [200, { active: 1, max_running: 5, reached: false }]), FAST);
    expect((await cloud.limits()).max_running).toBe(5);
    expect(seen).toHaveLength(2);
  });

  it('reads retry_after from the body and Retry-After from the header, and waits at least that long', async () => {
    const { cloud } = mockCloud(() => [503, { error: 'database_busy', message: 'busy', retry_after: 3 }], { retry: false });
    const e = await cloud.limits().catch((x) => x);
    expect(e.retryAfter).toBe(3);
    const p = new RetryPolicy({ baseMs: 1, maxMs: 2 });
    expect(p.delayMs(e, 1, () => 0)).toBe(3000);
    const h = mockCloud(() => BUILDING, { retry: false });
    const e2 = await h.cloud.limits().catch((x) => x);
    expect(e2.retryAfter).toBe(10);
    expect(new RetryPolicy({ maxRetryAfterMs: 5000 }).delayMs(e2, 1, () => 0)).toBe(5000);
  });

  it('jitters and bounds the backoff', () => {
    const p = new RetryPolicy({ baseMs: 100, maxMs: 300 });
    const e = new Kosa8Error('x', { status: 503, code: 'database_busy' });
    expect(p.delayMs(e, 1, () => 1)).toBe(100);
    expect(p.delayMs(e, 2, () => 1)).toBe(200);
    expect(p.delayMs(e, 5, () => 1)).toBe(300);
    expect(p.delayMs(e, 5, () => 0.5)).toBe(150);
  });

  it('classes database_busy and template_building as retryable infra without a body class', () => {
    expect(failureOf(503, 'database_busy')).toEqual({ failureClass: 'infra', retryable: true });
    expect(failureOf(409, 'template_building')).toEqual({ failureClass: 'infra', retryable: true });
    expect(failureOf(400, 'invalid_timeout')).toEqual({ failureClass: 'client', retryable: false });
    expect(classifyFailure(new Kosa8Error('x', { status: 503, code: 'database_busy' })).retryable).toBe(true);
  });

  it('retries the bytes endpoints too', async () => {
    const { cloud, seen } = mockCloud((_s, n) => (n === 0 ? BUSY : [200, '{"seq":1,"action":"a"}\n{"seq":2,"action":"b"}\n']), FAST);
    const ev = await cloud.audit.export();
    expect(ev.map((x) => x.seq)).toEqual([1, 2]);
    expect(seen).toHaveLength(2);
  });
});

function orgApi(s: Seen): Answer {
  const r = route(s);
  const q = s.url.searchParams;
  switch (r) {
    case 'GET /v1/api-keys': return [200, { api_keys: [{ id: 'key_1', name: 'ci', scopes: ['sandboxes:write'] }] }];
    case 'POST /v1/api-keys': return [201, { api_key: { id: 'key_2', ...(s.body as object), secret: 'k8c_live_x' } }];
    case 'DELETE /v1/api-keys/key_1': return [200, { ok: true, id: 'key_1' }];
    case 'POST /v1/api-keys/key_1/rotate': return [201, { api_key: { id: 'key_3', secret: 's' }, old_key: { id: 'key_1', expires_at: 9 }, note: 'n' }];
    case 'GET /v1/webhooks': return [200, { webhooks: [{ id: 'wh_1', url: 'https://x', events: ['sandbox.deleted'] }], events: ['sandbox.deleted'] }];
    case 'POST /v1/webhooks': return [201, { webhook: { id: 'wh_2', ...(s.body as object), secret: 'whsec_x' } }];
    case 'DELETE /v1/webhooks/wh_1': return [200, { ok: true, id: 'wh_1' }];
    case 'GET /v1/webhooks/wh_1/deliveries': return [200, { deliveries: [{ id: 'dl_1', event: 'x', status: 'delivered', limit: q.get('limit') }] }];
    case 'POST /v1/webhooks/wh_1/test': return [200, { delivery: { id: 'dl_2', event: 'webhook.test', status: 'delivered' } }];
    case 'GET /v1/audit': return [200, { events: [{ seq: 5, action: q.get('action') }], next_before_seq: 4 }];
    case 'GET /v1/audit/verify': return [200, { ok: true, count: 5, head: { seq: 5, hash: 'h' }, verified_at: 1 }];
    case 'GET /v1/benchmarks': return [200, { benchmarks: [{ name: 'swe-bench-verified', instances: 500 }] }];
    case 'GET /v1/benchmarks/swe': return [200, { benchmark: { name: 'swe', instances: 3 } }];
    case 'GET /v1/benchmarks/swe/instances': return [200, { instances: [{ id: 'a', benchmark: 'swe', template: 'swe/a', state: q.get('state') }], next_cursor: '7' }];
    case 'GET /v1/benchmarks/swe/instances/a': return [200, { instance: { id: 'a', benchmark: 'swe', template: 'swe/a', state: 'ready' } }];
    case 'POST /v1/benchmarks/swe/prepare': return [202, { benchmark: 'swe', instances: [], echo: s.body }];
    case 'GET /v1/rl/compare': return [200, { runs: [{ id: 'a' }, { id: 'b' }], ids: q.get('ids') }];
    case 'GET /v1/rl/alerts': return [200, { alerts: [], event: 'rl.alert', kinds: {}, run: q.get('run_id') }];
    case 'POST /v1/rl/alerts': return [201, { alert: { id: 'rla_1', ...(s.body as object) } }];
    case 'PATCH /v1/rl/alerts/rla_1': return [200, { alert: { id: 'rla_1', ...(s.body as object) } }];
    case 'DELETE /v1/rl/alerts/rla_1': return [200, { deleted: true, id: 'rla_1' }];
    case 'GET /v1/pricing': return [200, { currency: 'usd' }];
    case 'GET /v1/limits': return [200, { active: 2, max_running: 10, reached: false }];
    case 'POST /v1/limits/request': return [200, { ok: true, echo: s.body }];
    case 'GET /v1/usage/insights': return [200, { days: [] }];
    case 'GET /v1/lineage': return [200, { nodes: [], roots: [], forked: 0 }];
    case 'GET /v1/checkpoints': return [200, { sandboxes: [], truncated: false }];
    case 'GET /v1/images': return [200, { images: [{ template: 'base' }] }];
    case 'GET /v1/functions/fn/invocations': return [200, { invocations: [{ id: 'inv_1', limit: q.get('limit') }] }];
    case 'GET /v1/browsers/brw_1': return [200, { browser: { id: 'brw_1', state: 'open', cdp_url: 'wss://api/v1/browsers/brw_1/cdp?token=t', cdp_url_expires_at: 5 } }];
    case 'GET /v1/browsers/brw_2': return [200, { browser: { id: 'brw_2', state: 'closed', cdp_url: null } }];
  }
  return [404, { error: 'not_found', message: `no route ${r}` }];
}

describe('org endpoints', () => {
  it('API keys: list, create, revoke, rotate', async () => {
    const { cloud, seen } = mockCloud(orgApi);
    expect((await cloud.apiKeys.list())[0]!.id).toBe('key_1');
    const k = await cloud.apiKeys.create({ name: 'ci', scopes: ['sandboxes:read'], expiresInS: 60 });
    expect(seen[1]!.body).toEqual({ name: 'ci', scopes: ['sandboxes:read'], expires_in_s: 60 });
    expect(k.secret).toBe('k8c_live_x');
    await cloud.apiKeys.revoke('key_1');
    const r = await cloud.apiKeys.rotate('key_1', { graceS: 30 });
    expect(seen[3]!.body).toEqual({ grace_s: 30 });
    expect(r.old_key.id).toBe('key_1');
  });

  it('webhooks: list, create, delete, deliveries, test', async () => {
    const { cloud, seen } = mockCloud(orgApi);
    expect((await cloud.webhooks.list()).events).toEqual(['sandbox.deleted']);
    const w = await cloud.webhooks.create('https://x', { events: ['sandbox.deleted'], description: 'd' });
    expect(w.secret).toBe('whsec_x');
    await cloud.webhooks.delete('wh_1');
    expect((await cloud.webhooks.deliveries('wh_1', { limit: 5 }))[0]!.limit).toBe('5');
    expect((await cloud.webhooks.test('wh_1')).event).toBe('webhook.test');
    expect(seen.map(route)).toContain('POST /v1/webhooks/wh_1/test');
  });

  it('audit: list with filters, verify', async () => {
    const { cloud, seen } = mockCloud(orgApi);
    const l = await cloud.audit.list({ action: 'sandbox.*', sandboxId: 'sbx_1', beforeSeq: 9, limit: 2 });
    expect(l.next_before_seq).toBe(4);
    expect(Object.fromEntries(seen[0]!.url.searchParams)).toEqual({ action: 'sandbox.*', sandbox_id: 'sbx_1', before_seq: '9', limit: '2' });
    expect((await cloud.audit.verify()).ok).toBe(true);
  });

  it('benchmarks: list, get, instances, instance, prepare', async () => {
    const { cloud, seen } = mockCloud(orgApi);
    expect((await cloud.benchmarks.list())[0]!.name).toBe('swe-bench-verified');
    expect((await cloud.benchmarks.get('swe')).instances).toBe(3);
    const p = await cloud.benchmarks.instances('swe', { state: 'ready', limit: 1 });
    expect(p.next_cursor).toBe('7');
    expect(p.instances[0]!.state).toBe('ready');
    expect((await cloud.benchmarks.instance('swe', 'a')).template).toBe('swe/a');
    await cloud.benchmarks.prepare('swe', 10, { seed: 1 });
    expect(seen.at(-1)!.body).toEqual({ instances: 10, seed: 1 });
  });

  it('rl: compare and alert rules', async () => {
    const { cloud, seen } = mockCloud(orgApi);
    expect(await cloud.rl.compare(['a', 'b'])).toHaveLength(2);
    expect(seen[0]!.url.searchParams.get('ids')).toBe('a,b');
    await expect(cloud.rl.compare(['a'])).rejects.toThrow(/2 to 4/);
    expect((await cloud.rl.alerts.list({ runId: 'run_1' })).alerts).toEqual([]);
    const a = await cloud.rl.alerts.create({ kind: 'infra_rate', threshold: 0.2, window: 50, runId: 'run_1' });
    expect(seen.at(-1)!.body).toEqual({ kind: 'infra_rate', threshold: 0.2, window: 50, run_id: 'run_1' });
    expect(a.id).toBe('rla_1');
    await cloud.rl.alerts.update('rla_1', { enabled: false });
    expect(seen.at(-1)!.body).toEqual({ enabled: false });
    await expect(cloud.rl.alerts.update('rla_1', {})).rejects.toThrow();
    await cloud.rl.alerts.delete('rla_1');
  });

  it('pricing, limits, usage insights, lineage, checkpoints, images, invocations', async () => {
    const { cloud, seen } = mockCloud(orgApi);
    expect((await cloud.pricing()).currency).toBe('usd');
    expect((await cloud.limits()).max_running).toBe(10);
    await cloud.requestLimit(50, 'eval run');
    expect(seen.at(-1)!.body).toEqual({ max_running: 50, reason: 'eval run' });
    expect(await cloud.usageInsights()).toEqual({ days: [] });
    expect((await cloud.lineage()).forked).toBe(0);
    expect((await cloud.checkpoints()).sandboxes).toEqual([]);
    expect((await cloud.images()).images).toHaveLength(1);
    expect((await cloud.functions.invocations('fn', { limit: 3 }))[0]!.limit).toBe('3');
  });

  it('browsers.cdp gives a fresh CDP URL, and refuses a closed browser', async () => {
    const { cloud } = mockCloud(orgApi);
    const c = await cloud.browsers.cdp('brw_1');
    expect(c.cdpUrl).toMatch(/^wss:.*\/cdp\?token=/);
    expect(c.endpoint).toBe('/v1/browsers/brw_1/cdp');
    await expect(cloud.browsers.cdp('brw_2')).rejects.toThrow(/closed/);
  });

  it('ai.gatewayUrl points a provider client at the gateway', () => {
    const { cloud } = mockCloud(orgApi, { baseUrl: 'https://api.kosa8.com' });
    expect(cloud.ai.gatewayUrl('openai')).toBe('https://api.kosa8.com/v1/ai/gw/openai/');
    expect(cloud.ai.gatewayUrl('anthropic', '/v1/messages')).toBe('https://api.kosa8.com/v1/ai/gw/anthropic/v1/messages');
    expect(() => cloud.ai.gatewayUrl('../x')).toThrow();
  });
});

describe('sandbox item paths', () => {
  it('spells out background exec, preview, schedule and code-context paths', async () => {
    const { cloud, seen } = mockCloud((s) => {
      const r = route(s);
      if (r === 'GET /v1/sandboxes/sbx_1') return [200, { sandbox: info() }];
      if (r === 'GET /v1/sandboxes/sbx_1/exec/bg_1') return [200, { exec: { id: 'bg_1', state: 'exited', exit: 0 } }];
      if (r === 'POST /v1/sandboxes/sbx_1/exec/bg_1/stop') return [200, { exec: { id: 'bg_1', state: 'exited' } }];
      if (s.method === 'DELETE') return [200, { ok: true }];
      return [404, { error: 'not_found', message: r }];
    });
    const box = await cloud.sandboxes.get('sbx_1');
    const job = await box.getExec('bg_1');
    expect((await job.stop()).state).toBe('exited');
    await box.previews.delete(3000);
    await box.schedules.delete('sch_1');
    await box.codeContexts.delete('ctx');
    expect(seen.map(route).slice(-3)).toEqual([
      'DELETE /v1/sandboxes/sbx_1/previews/3000', 'DELETE /v1/sandboxes/sbx_1/schedules/sch_1', 'DELETE /v1/sandboxes/sbx_1/code/contexts/ctx',
    ]);
  });
});

describe('version', () => {
  it('SDK_VERSION is package.json\'s and is sent as the User-Agent', async () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(SDK_VERSION).toBe(pkg.version);
    const { cloud, seen } = mockCloud(() => [200, { currency: 'usd' }]);
    await cloud.pricing();
    expect(seen[0]!.headers['User-Agent']).toBe(USER_AGENT);
  });
});

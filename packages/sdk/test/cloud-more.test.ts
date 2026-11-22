// Copyright (c) 2026 kosa8. Licensed under the MIT License; see LICENSE.

import { describe, expect, it } from 'vitest';
import { CloudSandbox, Kosa8CancelledError, Kosa8Error } from '../src/index.js';
import type { CloudOrgTemplate } from '../src/index.js';
import { info, mockCloud, route } from './helpers.js';

const tpl = (over: Partial<CloudOrgTemplate> = {}): CloudOrgTemplate => ({
  id: 'tpl_1', name: 'swe-task-1', state: 'queued', source: 'image', image: 'ghcr.io/x/y@sha256:abc', ...over,
});

describe('org templates', () => {
  it('build sends the image or Dockerfile with its size and setup, in API names', async () => {
    const { cloud, seen } = mockCloud(() => [202, { template: tpl() }]);
    const t = await cloud.orgTemplates.build({ name: 'swe-task-1', image: 'ghcr.io/x/y@sha256:abc', size: '4x8', setupCmd: 'pip install -e .', region: 'eu' });
    expect(t.id).toBe('tpl_1');
    expect(route(seen[0]!)).toBe('POST /v1/templates');
    expect(seen[0]!.body).toEqual({ name: 'swe-task-1', image: 'ghcr.io/x/y@sha256:abc', size: '4x8', setup_cmd: 'pip install -e .', region: 'eu' });
    await cloud.orgTemplates.build({ name: 'df', dockerfile: 'FROM alpine', buildArgs: { V: '1' }, cpus: 2, memMb: 4096 });
    expect(seen[1]!.body).toEqual({ name: 'df', dockerfile: 'FROM alpine', build_args: { V: '1' }, cpus: 2, mem_mb: 4096 });
  });

  it('build checks the name and the source before any request', async () => {
    const { cloud, seen } = mockCloud(() => [202, { template: tpl() }]);
    await expect(cloud.orgTemplates.build({ name: 'Bad Name', image: 'x' })).rejects.toThrow(/template name/);
    await expect(cloud.orgTemplates.build({ name: 'ok' })).rejects.toThrow(/image or dockerfile/);
    await expect(cloud.orgTemplates.build({ name: 'ok', image: 'x', dockerfile: 'y' })).rejects.toThrow(/image or dockerfile/);
    await expect(cloud.orgTemplates.build({ name: 'ok', image: 'x', cpus: 2 })).rejects.toThrow(/together/);
    expect(seen).toHaveLength(0);
  });

  it('import queues many images', async () => {
    const { cloud, seen } = mockCloud(() => [202, {
      import_id: 'imp_1', requested: 2, queued: 1, builds_at_once: 2, templates: [{ id: 'tpl_1', name: 'a', image: 'i@sha256:1' }],
      failed: [{ index: 1, name: 'b', code: 'plan_limit', message: 'snapshots' }],
    }]);
    const r = await cloud.orgTemplates.import([{ name: 'a', image: 'i@sha256:1' }, { name: 'b', image: 'i@sha256:2' }], { size: '2x4', partialOk: true });
    expect(route(seen[0]!)).toBe('POST /v1/templates/import');
    expect(seen[0]!.body).toEqual({ images: [{ name: 'a', image: 'i@sha256:1' }, { name: 'b', image: 'i@sha256:2' }], size: '2x4', partial_ok: true });
    expect(r).toMatchObject({ import_id: 'imp_1', queued: 1, failed: [{ code: 'plan_limit' }] });
    await expect(cloud.orgTemplates.import([])).rejects.toThrow(/1 to 1000/);
  });

  it('get, list and delete', async () => {
    const { cloud, seen } = mockCloud((s) => {
      if (s.method === 'DELETE') return [200, { ok: true, id: 'tpl_1' }];
      if (s.url.pathname === '/v1/templates') return [200, { templates: [], org_templates: [tpl({ state: 'ready' })] }];
      return [200, { template: tpl({ log: 'built' }) }];
    });
    expect((await cloud.orgTemplates.get('swe-task-1')).log).toBe('built');
    expect(route(seen[0]!)).toBe('GET /v1/templates/swe-task-1');
    expect((await cloud.orgTemplates.list())[0]!.state).toBe('ready');
    await cloud.orgTemplates.delete('tpl_1');
    expect(route(seen[2]!)).toBe('DELETE /v1/templates/tpl_1');
  });

  it('wait polls until ready, and throws when the build failed', async () => {
    const states = ['queued', 'building', 'ready'];
    const { cloud, seen } = mockCloud(() => [200, { template: tpl({ state: states.shift()! }) }]);
    expect((await cloud.orgTemplates.wait('tpl_1', { intervalMs: 1 })).state).toBe('ready');
    expect(seen).toHaveLength(3);
    const failed = mockCloud(() => [200, { template: tpl({ state: 'failed', last_error: 'pull denied' }) }]);
    await expect(failed.cloud.orgTemplates.wait('tpl_1', { intervalMs: 1 })).rejects.toThrow(/pull denied/);
  });
});

describe('burst passes', () => {
  it('get and activate', async () => {
    const { cloud, seen } = mockCloud((s) => (s.method === 'GET'
      ? [200, { available: true, pass: { id: 'burst_24h', max_active: 3 }, held: 1, active: [], adds_now: { running: 0, sandbox_hours: 0 } }]
      : [200, { ok: true, activated: 1, ends_at: '2026-11-22T00:00:00Z', held: 0, running_limit: 40 }]));
    expect((await cloud.burst.get()).held).toBe(1);
    expect(route(seen[0]!)).toBe('GET /v1/billing/burst');
    expect((await cloud.burst.activate(2)).activated).toBe(1);
    expect(seen[1]!.body).toEqual({ quantity: 2 });
    expect(() => cloud.burst.activate(0)).toThrow(/quantity/);
  });
});

describe('capability tokens', () => {
  it('create, list and revoke', async () => {
    const tok = { id: 'tok_1', prefix: 'k8c_tok_ab', scopes: ['sandboxes:read'], state: 'active', secret: 'k8c_tok_abcdef' };
    const { cloud, seen } = mockCloud((s) => (s.method === 'GET' ? [200, { tokens: [tok] }] : [s.method === 'POST' ? 201 : 200, { token: tok }]));
    const t = await cloud.tokens.create({ scopes: ['sandboxes:read', 'sandboxes:write'], sandboxIds: ['sbx_1'], labels: { user: 'u1' }, ttlS: 600, name: 'browser' });
    expect(t.secret).toBe('k8c_tok_abcdef');
    expect(route(seen[0]!)).toBe('POST /v1/tokens');
    expect(seen[0]!.body).toEqual({ scopes: ['sandboxes:read', 'sandboxes:write'], sandbox_ids: ['sbx_1'], labels: { user: 'u1' }, ttl_s: 600, name: 'browser' });
    expect(await cloud.tokens.list({ all: true })).toHaveLength(1);
    expect(seen[1]!.url.search).toBe('?all=1');
    await cloud.tokens.revoke('tok_1');
    expect(route(seen[2]!)).toBe('DELETE /v1/tokens/tok_1');
    await expect(cloud.tokens.create({ scopes: [] })).rejects.toThrow(/scope/);
    await expect(cloud.tokens.create({ scopes: ['sandboxes:read'], ttlS: 90_000 })).rejects.toThrow(/ttlS/);
  });
});

describe('embeds', () => {
  it('create, list and revoke', async () => {
    const emb = { id: 'emb_1', sandbox_id: 'sbx_1', mode: 'view', ui: 'terminal', origins: ['https://app.example.com'], url: 'https://e/x', snippet: '<iframe>' };
    const { cloud, seen } = mockCloud((s) => (s.method === 'GET' ? [200, { embeds: [emb] }] : s.method === 'POST' ? [201, { embed: emb }] : [200, { revoked: true }]));
    const box = new CloudSandbox(cloud, info());
    const e = await box.embeds.create({ origins: ['https://app.example.com'], mode: 'interact', ui: 'desktop', ttlS: 3600, command: ['htop'] });
    expect(e.url).toBe('https://e/x');
    expect(route(seen[0]!)).toBe('POST /v1/sandboxes/sbx_1/embed');
    expect(seen[0]!.body).toEqual({ origins: ['https://app.example.com'], mode: 'interact', ui: 'desktop', ttl_s: 3600, command: ['htop'] });
    expect(await box.embeds.list()).toHaveLength(1);
    expect(route(seen[1]!)).toBe('GET /v1/sandboxes/sbx_1/embeds');
    await box.embeds.revoke('emb_1');
    expect(route(seen[2]!)).toBe('DELETE /v1/sandboxes/sbx_1/embeds/emb_1');
    await expect(box.embeds.create({ origins: [] })).rejects.toThrow(/origins/);
    await expect(box.embeds.create({ origins: ['https://a'], ttlS: 10 })).rejects.toThrow(/ttlS/);
  });
});

describe('custom preview domains', () => {
  it('by sandbox and port, and by preview id', async () => {
    const dom = { hostname: 'preview.example.com', status: 'pending', records: [{ type: 'CNAME', name: 'preview', value: 'x', purpose: 'routing' }] };
    const { cloud, seen } = mockCloud((s) => {
      if (s.method === 'GET' && s.url.pathname.endsWith('/domains')) return [200, { domains: [dom], configured: true, cname_target: 'cname.kosa8.app' }];
      if (s.method === 'DELETE') return [200, { deleted: true }];
      return [s.method === 'POST' ? 201 : 200, { domain: dom }];
    });
    const domains = new CloudSandbox(cloud, info()).previews.domains(3000);
    const d = await domains.add('preview.example.com', { sslMethod: 'txt' });
    expect(d.records[0]!.purpose).toBe('routing');
    expect(route(seen[0]!)).toBe('POST /v1/sandboxes/sbx_1/previews/3000/domains');
    expect(seen[0]!.body).toEqual({ hostname: 'preview.example.com', ssl_method: 'txt' });
    expect(await domains.list()).toMatchObject({ configured: true, cnameTarget: 'cname.kosa8.app' });
    await domains.get('preview.example.com');
    expect(route(seen[2]!)).toBe('GET /v1/sandboxes/sbx_1/previews/3000/domains/preview.example.com');
    await cloud.previewDomains('sbx_1:3000').remove('preview.example.com');
    expect(seen[3]!.url.pathname).toBe('/v1/previews/sbx_1%3A3000/domains/preview.example.com');
    expect(() => new CloudSandbox(cloud, info()).previews.domains(0)).toThrow(/port/);
  });
});

describe('recordings', () => {
  it('list, link, delete, and a sandbox’s own', async () => {
    const rec = { id: 'rec_1', sandbox_id: 'sbx_1', state: 'ready', bytes: 10 };
    const { cloud, seen } = mockCloud((s) => {
      if (s.url.pathname.endsWith('/link')) return [200, { link: { url: 'https://r/x.mp4', expires_at: 9, bytes: 10 } }];
      if (s.method === 'DELETE') return [200, { deleted: true }];
      if (s.url.pathname.startsWith('/v1/sandboxes')) return [200, { recordings: [rec], record: true }];
      return [200, { recordings: [rec], configured: true, retention_days: 30 }];
    });
    expect(await cloud.recordings.list({ sandboxId: 'sbx_1', limit: 5 })).toEqual({ recordings: [rec], configured: true, retentionDays: 30 });
    expect(seen[0]!.url.search).toBe('?sandbox_id=sbx_1&limit=5');
    expect((await cloud.recordings.link('rec_1', { ttlS: 600 })).url).toBe('https://r/x.mp4');
    expect(seen[1]!.body).toEqual({ ttl_s: 600 });
    await cloud.recordings.delete('rec_1');
    expect(route(seen[2]!)).toBe('DELETE /v1/recordings/rec_1');
    expect(await new CloudSandbox(cloud, info()).recordings()).toEqual([rec]);
    expect(route(seen[3]!)).toBe('GET /v1/sandboxes/sbx_1/recordings');
    await expect(cloud.recordings.link('rec_1', { ttlS: 5 })).rejects.toThrow(/ttlS/);
  });
});

describe('forkMap', () => {
  /** A fake fork host: every fork makes n children; deletes and drains are recorded. */
  function forkHost(opts: { failFork?: number } = {}) {
    let next = 0;
    const deleted: string[] = [];
    let forks = 0;
    const m = mockCloud((s) => {
      if (s.url.pathname.endsWith('/fork')) {
        forks++;
        if (opts.failFork !== undefined && forks === opts.failFork) return [503, { error: 'no_capacity', message: 'full' }];
        const n = (s.body as { n: number }).n;
        return [201, { sandboxes: Array.from({ length: n }, () => info({ id: `sbx_k${next++}` })), failed: [], requested: n }];
      }
      if (s.url.pathname.endsWith('/drain')) {
        const ids = (s.body as { ids: string[] }).ids;
        deleted.push(...ids);
        return [200, { deleted: ids.length, ids, failed: [], more: false }];
      }
      if (s.method === 'DELETE') {
        deleted.push(s.url.pathname.split('/').pop()!);
        return [200, {}];
      }
      return [404, { error: 'not_found', message: route(s) }];
    }, { retry: false });
    return { ...m, deleted, base: new CloudSandbox(m.cloud, info({ id: 'sbx_base' })) };
  }

  it('runs fn in a fork per item, in order, and deletes every child', async () => {
    const { cloud, base, deleted, seen } = forkHost();
    const out = await cloud.forkMap(base, async (child, item: number) => `${child.id}:${item * 2}`, [1, 2, 3], { concurrency: 2, runId: 'run_1', leaseS: 600 });
    expect(out.map((r) => r.ok)).toEqual([true, true, true]);
    expect(out.map((r) => r.value!.split(':')[1])).toEqual(['2', '4', '6']);
    expect(new Set(deleted).size).toBe(3);
    expect(seen[0]!.body).toEqual({ n: 2, run_id: 'run_1', lease_s: 600, partial_ok: true });
  });

  it('retries an infra failure on a fresh child; reports other failures without throwing', async () => {
    const { cloud, base, deleted } = forkHost();
    let calls = 0;
    const out = await cloud.forkMap(base, async (_c, item: string) => {
      calls++;
      if (item === 'flaky' && calls === 1) throw new Kosa8Error('host gone', { status: 502, code: 'host_failed' });
      if (item === 'bug') throw new TypeError('my bug');
      return item;
    }, ['flaky', 'bug'], { concurrency: 1, policy: undefined, retries: 2 });
    expect(out[0]).toMatchObject({ ok: true, value: 'flaky', attempts: 2 });
    expect(out[1]).toMatchObject({ ok: false, failureClass: 'error', attempts: 1 });
    expect(out[1]!.error).toBeInstanceOf(TypeError);
    expect(deleted.length).toBeGreaterThanOrEqual(3);
  });

  it('gives up on an item past timeoutMs and deletes its child', async () => {
    const { cloud, base, deleted } = forkHost();
    const out = await cloud.forkMap(base, (c) => new Promise((r) => setTimeout(() => r(c.id), 200)), ['slow'], { timeoutMs: 10 });
    expect(out[0]).toMatchObject({ ok: false, failureClass: 'timeout' });
    expect(deleted).toContain(out[0]!.sandboxId);
  });

  it('an aborted map starts nothing more and deletes every child', async () => {
    const { cloud, base, deleted } = forkHost();
    const ctl = new AbortController();
    const out = await cloud.forkMap(base, async (c, i: number) => {
      if (i === 0) ctl.abort();
      return c.id;
    }, [0, 1, 2], { concurrency: 1, signal: ctl.signal });
    expect(out[0]!.ok).toBe(true);
    expect(out.slice(1).every((r) => r.error instanceof Kosa8CancelledError)).toBe(true);
    expect(deleted).toContain(out[0]!.sandboxId);
  });
});

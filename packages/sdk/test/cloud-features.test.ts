// Copyright (c) 2026 kosa8. Licensed under the MIT License; see LICENSE.

import { describe, expect, it } from 'vitest';
import { CLOUD_SIZES, Kosa8Cloud, Kosa8Error, Kosa8TimeoutError, pipelineRunDone } from '../src/index.js';
import type { CloudSandboxInfo, CloudSnapshot } from '../src/index.js';

const KEY = 'k8c_live_testkey';

interface Seen {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

type Answer = [number, unknown];

function cloudWith(answer: (s: Seen) => Answer) {
  const seen: Seen[] = [];
  const f = (async (url: string, init: RequestInit) => {
    let body: unknown;
    if (init.body instanceof Uint8Array) body = init.body;
    else if (init.body) body = JSON.parse(String(init.body));
    const s: Seen = { url: new URL(url), method: init.method ?? 'GET', headers: init.headers as Record<string, string>, body };
    seen.push(s);
    const [status, out] = answer(s);
    const payload = out instanceof Uint8Array ? out : out === undefined ? '' : JSON.stringify(out);
    return new Response(payload as BodyInit, { status });
  }) as unknown as typeof fetch;
  return { cloud: new Kosa8Cloud({ apiKey: KEY, env: {}, fetch: f }), seen };
}

const route = (s: Seen) => `${s.method} ${s.url.pathname}`;

const info = (over: Partial<CloudSandboxInfo> = {}): CloudSandboxInfo => ({
  id: 'sbx_1', state: 'running', template: 'base', cpus: 2, mem_mb: 4096, source: 'cold', region: 'us-ash1',
  own_host: false, created_at: 1, started_at: 1, stopped_at: null, deleted_at: null, last_error: null,
  running_s: 0, asleep_s: 0, cost_usd: 0, ...over,
});

const snap: CloudSnapshot = {
  id: 'snap_abcdefgh', name: 'base', state: 'ready', source_sandbox_id: 'sbx_1', template: 'base', cpus: 2,
  mem_mb: 4096, image: null, disk_gb: 32, persistent: false, bytes: 10, region: 'us-ash1', created_at: 1,
  deleted_at: null, last_error: null,
};

async function boxOf(cloud: Kosa8Cloud) {
  return cloud.sandboxes.get('sbx_1');
}

describe('sized and Docker creates', () => {
  it('sends size, image, docker, disk, cpu, name, env, egress and secrets in API names', async () => {
    const { cloud, seen } = cloudWith(() => [201, { sandbox: info() }]);
    await cloud.sandboxes.create({
      size: '4x8', image: 'kosa8-template/universal-24.04-20261115.2', docker: true, diskGb: 64, cpu: 'dedicated',
      name: 'web-1', env: { NODE_ENV: 'production' }, region: 'us', sleepAfterS: 0, egress: { presets: ['npm'] },
      secrets: ['OPENAI'],
    });
    expect(seen[0]!.body).toEqual({
      size: '4x8', image: 'kosa8-template/universal-24.04-20261115.2', docker: true, disk_gb: 64, cpu: 'dedicated',
      name: 'web-1', env: { NODE_ENV: 'production' }, region: 'us', sleep_after_s: 0, egress: { presets: ['npm'] },
      secrets: ['OPENAI'],
    });
    expect(CLOUD_SIZES).toContain('16x32');
  });

  it('sends cpus+mem_mb and persistent', async () => {
    const { cloud, seen } = cloudWith(() => [201, { sandbox: info() }]);
    await cloud.sandboxes.create({ cpus: 8, memMb: 16384, persistent: true });
    expect(seen[0]!.body).toEqual({ cpus: 8, mem_mb: 16384, persistent: true });
  });

  it('checks combinations before any request', async () => {
    const { cloud, seen } = cloudWith(() => [201, { sandbox: info() }]);
    await expect(cloud.sandboxes.create({ cpus: 4 })).rejects.toThrow(/together/);
    await expect(cloud.sandboxes.create({ size: '4x8', cpus: 4, memMb: 8192 })).rejects.toThrow(/not both/);
    await expect(cloud.sandboxes.create({ docker: true, persistent: false })).rejects.toThrow(/persistent/);
    await expect(cloud.sandboxes.create({ diskGb: 4 })).rejects.toThrow(Kosa8Error);
    await expect(cloud.sandboxes.create({ snapshot: 'snap_abcdefgh', size: '2x4', template: 'x' })).rejects.toThrow(/template, size/);
    expect(seen).toHaveLength(0);
  });

  it('waits for a cold boot (202 creating) until running', async () => {
    let gets = 0;
    const { cloud, seen } = cloudWith((s) => {
      if (s.method === 'POST') return [202, { sandbox: info({ state: 'creating' }) }];
      gets++;
      return [200, { sandbox: info({ state: gets < 2 ? 'creating' : 'running' }) }];
    });
    const box = await cloud.sandboxes.create({ size: '2x4' });
    // the poll interval is 1 s; two polls
    expect(box.info.state).toBe('running');
    expect(seen.map(route)).toEqual(['POST /v1/sandboxes', 'GET /v1/sandboxes/sbx_1', 'GET /v1/sandboxes/sbx_1']);
  }, 10_000);

  it('raises with last_error when the boot fails, and skips waiting with wait: false', async () => {
    const { cloud } = cloudWith((s) =>
      s.method === 'POST' ? [202, { sandbox: info({ state: 'creating' }) }] : [200, { sandbox: info({ state: 'error', last_error: 'no capacity' }) }]);
    await expect(cloud.sandboxes.create({ size: '2x4' })).rejects.toThrow(/no capacity/);
    const box = await cloud.sandboxes.create({ size: '2x4', wait: false });
    expect(box.info.state).toBe('creating');
  }, 10_000);

  it('makes a sandbox from a snapshot (id or object) and sets labels after', async () => {
    const { cloud, seen } = cloudWith((s) =>
      s.url.pathname.endsWith('/labels') ? [200, { id: 'sbx_1', labels: { team: 'ml' } }] : [201, { sandbox: info({ snapshot_id: snap.id }) }]);
    const box = await cloud.sandboxes.create({ snapshot: snap, env: { A: '1' }, labels: { team: 'ml' } });
    expect(seen[0]!.body).toEqual({ snapshot: 'snap_abcdefgh', env: { A: '1' } });
    expect(route(seen[1]!)).toBe('PUT /v1/sandboxes/sbx_1/labels');
    expect(seen[1]!.body).toEqual({ labels: { team: 'ml' } });
    expect(box.info.labels).toEqual({ team: 'ml' });
  });

  it('lists by name and labels', async () => {
    const { cloud, seen } = cloudWith(() => [200, { sandboxes: [] }]);
    await cloud.sandboxes.list({ name: 'web-1', labels: { team: 'ml', gpu: true } });
    expect(seen[0]!.url.searchParams.get('name')).toBe('web-1');
    expect(seen[0]!.url.searchParams.getAll('label')).toEqual(['team=ml', 'gpu']);
  });
});

describe('background exec', () => {
  it('starts with background: true and polls status until exited', async () => {
    let polls = 0;
    const { cloud, seen } = cloudWith((s) => {
      if (s.url.pathname === '/v1/sandboxes/sbx_1') return [200, { sandbox: info() }];
      if (s.method === 'POST') return [202, { exec: { id: 'bg_1', sandbox_id: 'sbx_1', state: 'running', pid: 7, exit: null, output_path: '/workspace/.kosa8/bg_1.out', exit_path: null } }];
      polls++;
      return [200, { exec: { id: 'bg_1', sandbox_id: 'sbx_1', state: polls < 2 ? 'running' : 'exited', pid: 7, exit: polls < 2 ? null : 0, output_path: 'x', exit_path: 'y', output: 'built\n' } }];
    });
    const box = await boxOf(cloud);
    const job = await box.execBackground('npm run build', { env: { CI: '1' } });
    expect(seen[1]!.body).toEqual({ cmd: ['sh', '-c', 'npm run build'], background: true, env: ['CI=1'] });
    expect(job.id).toBe('bg_1');
    const done = await job.wait({ intervalMs: 5 });
    expect(done).toMatchObject({ state: 'exited', exit: 0, output: 'built\n' });
    expect(route(seen[2]!)).toBe('GET /v1/sandboxes/sbx_1/exec/bg_1');
  });

  it('times out waiting, and getExec reads one by id', async () => {
    const { cloud } = cloudWith((s) =>
      s.url.pathname === '/v1/sandboxes/sbx_1' ? [200, { sandbox: info() }]
        : [200, { exec: { id: 'bg_2', sandbox_id: 'sbx_1', state: 'running', pid: 1, exit: null, output_path: null, exit_path: null } }]);
    const box = await boxOf(cloud);
    const job = await box.getExec('bg_2');
    expect(job.info.pid).toBe(1);
    await expect(job.wait({ timeoutMs: 20, intervalMs: 5 })).rejects.toThrow(Kosa8TimeoutError);
  });
});

describe('snapshots', () => {
  it('creates from a sandbox, lists, gets and deletes', async () => {
    const { cloud, seen } = cloudWith((s) => {
      if (s.url.pathname === '/v1/sandboxes/sbx_1') return [200, { sandbox: info() }];
      if (s.method === 'POST') return [201, { snapshot: snap, ms: 900 }];
      if (s.method === 'DELETE') return [200, { ok: true, id: snap.id }];
      if (s.url.pathname === '/v1/snapshots') return [200, { snapshots: [snap], max: 50 }];
      return [200, { snapshot: snap }];
    });
    const box = await boxOf(cloud);
    expect((await box.snapshot('base')).id).toBe(snap.id);
    expect(seen[1]!.body).toEqual({ name: 'base' });
    expect(await cloud.snapshots.list({ sandboxId: 'sbx_1' })).toHaveLength(1);
    expect(seen[2]!.url.search).toBe('?sandbox_id=sbx_1');
    expect((await cloud.snapshots.get(snap.id)).state).toBe('ready');
    await cloud.snapshots.delete(snap.id);
    await cloud.snapshots.create('sbx_1');
    expect(seen.slice(3).map(route)).toEqual([
      'GET /v1/snapshots/snap_abcdefgh', 'DELETE /v1/snapshots/snap_abcdefgh', 'POST /v1/sandboxes/sbx_1/snapshots',
    ]);
  });
});

describe('previews', () => {
  it('creates, lists, links, rotates and deletes', async () => {
    const p = { port: 3000, public: false, url: 'https://abc.kosa8labs.com/?t=x', host: 'abc.kosa8labs.com' };
    const { cloud, seen } = cloudWith((s) => {
      if (s.url.pathname === '/v1/sandboxes/sbx_1') return [200, { sandbox: info() }];
      if (s.url.pathname.endsWith('/previews') && s.method === 'GET') return [200, { previews: [p], configured: true }];
      if (s.method === 'DELETE') return [200, { deleted: true, port: 3000 }];
      return [200, { preview: p }];
    });
    const box = await boxOf(cloud);
    expect((await box.previews.create(3000, { public: false, expiresInS: 600, wake: true, wakePerHour: 5 })).url).toContain('kosa8labs.com');
    expect(seen[1]!.body).toEqual({ port: 3000, public: false, expires_in_s: 600, wake: true, wake_per_hour: 5 });
    expect(await box.previews.list()).toHaveLength(1);
    await box.previews.link(3000, { expiresInS: 60 });
    expect(seen[3]!.body).toEqual({ expires_in_s: 60 });
    await box.previews.rotate(3000);
    await box.previews.delete(3000);
    expect(seen.slice(3).map(route)).toEqual([
      'POST /v1/sandboxes/sbx_1/previews/3000/link', 'POST /v1/sandboxes/sbx_1/previews/3000/rotate',
      'DELETE /v1/sandboxes/sbx_1/previews/3000',
    ]);
    await expect(box.previews.create(0)).rejects.toThrow(/port/);
  });
});

describe('secrets', () => {
  it('sends the value in the body only, lists and deletes', async () => {
    const { cloud, seen } = cloudWith((s) => {
      if (s.method === 'PUT') return [201, { secret: { name: 'OPENAI', upstream: 'api.openai.com', pipelines: true }, replaced: false }];
      if (s.method === 'DELETE') return [200, { deleted: 'OPENAI', still_held_by: ['sbx_1'] }];
      return [200, { secrets: [{ name: 'OPENAI' }] }];
    });
    const r = await cloud.secrets.set('OPENAI', 'sk-secret', { upstream: 'api.openai.com', pipelines: true });
    expect(seen[0]!.url.pathname).toBe('/v1/secrets/OPENAI');
    expect(seen[0]!.url.search).toBe('');
    expect(seen[0]!.body).toEqual({ value: 'sk-secret', upstream: 'api.openai.com', pipelines: true });
    expect(JSON.stringify(r)).not.toContain('sk-secret');
    expect(await cloud.secrets.list()).toEqual([{ name: 'OPENAI' }]);
    expect(await cloud.secrets.delete('OPENAI')).toEqual({ deleted: 'OPENAI', stillHeldBy: ['sbx_1'] });
    await expect(cloud.secrets.set('X', '')).rejects.toThrow(/value/);
  });
});

describe('sandbox extras', () => {
  it('egress, terminal, code, schedules, labels, metrics, logs and held secrets', async () => {
    const eg = { internet: false, allow: ['pypi.org'], deny: [], presets: [], source: 'sandbox', enforced: 'host' };
    const { cloud, seen } = cloudWith((s) => {
      const p = s.url.pathname;
      if (p === '/v1/sandboxes/sbx_1') return [200, { sandbox: info() }];
      if (p.endsWith('/egress')) return [200, { egress: eg }];
      if (p.endsWith('/terminal')) return [200, { terminal: { url: 'wss://x', expires_at: 1, protocol: 'kosa8-pty' } }];
      if (p.endsWith('/code')) return [200, { context: 'default', execution_count: 1, results: [{ type: 'text', data: '42' }], stdout: '', stderr: '' }];
      if (p.endsWith('/code/contexts') && s.method === 'GET') return [200, { contexts: [{ name: 'default', execution_count: 1 }] }];
      if (p.endsWith('/code/contexts')) return [201, { context: { name: 'nb', execution_count: 0 } }];
      if (p.includes('/code/contexts/')) return [200, {}];
      if (p.endsWith('/schedules') && s.method === 'POST') return [201, { schedule: { id: 'sch_1', cron: '0 * * * *' } }];
      if (p.endsWith('/schedules')) return [200, { schedules: [] }];
      if (p.endsWith('/run')) return [200, { schedule: {}, run: { status: 'ok', exit: 0 } }];
      if (p.includes('/schedules/')) return [200, { deleted: true }];
      if (p.endsWith('/metrics')) return [200, { metrics: { cpu_pct: 3 } }];
      if (p.endsWith('/logs')) return [200, { id: 'sbx_1', entries: [{ cmd: ['ls'], exit: 0 }] }];
      if (p.endsWith('/secrets')) return [200, { id: 'sbx_1', secrets: ['OPENAI'] }];
      return [404, { error: 'not_found' }];
    });
    const box = await boxOf(cloud);
    expect((await box.setEgress({ internet: false, allow: ['pypi.org'] })).allow).toEqual(['pypi.org']);
    await box.egress();
    await box.resetEgress();
    expect((await box.terminal({ cols: 80, rows: 24 })).url).toBe('wss://x');
    expect(seen[4]!.body).toEqual({ cols: 80, rows: 24 });
    const run = await box.runCode('6*7', { context: 'nb', timeoutS: 5 });
    expect(seen[5]!.body).toEqual({ code: '6*7', context: 'nb', timeout_s: 5 });
    expect(run.results[0]!.data).toBe('42');
    expect(await box.codeContexts.list()).toHaveLength(1);
    expect((await box.codeContexts.create('nb')).name).toBe('nb');
    await box.codeContexts.reset('nb');
    await box.codeContexts.delete('nb');
    await box.schedules.create({ cron: '0 * * * *', cmd: 'date', env: { TZ: 'UTC' }, wake: true });
    expect(seen[10]!.body).toEqual({ cron: '0 * * * *', cmd: ['sh', '-c', 'date'], env: ['TZ=UTC'], wake: true });
    await box.schedules.list();
    expect((await box.schedules.run('sch_1')).run.exit).toBe(0);
    await box.schedules.delete('sch_1');
    expect((await box.metrics()).cpu_pct).toBe(3);
    expect(await box.logs({ limit: 5 })).toHaveLength(1);
    expect(seen[15]!.url.search).toBe('?limit=5');
    expect(await box.secrets()).toEqual(['OPENAI']);
    expect(seen.slice(1).map(route)).toEqual([
      'PUT /v1/sandboxes/sbx_1/egress', 'GET /v1/sandboxes/sbx_1/egress', 'DELETE /v1/sandboxes/sbx_1/egress',
      'POST /v1/sandboxes/sbx_1/terminal', 'POST /v1/sandboxes/sbx_1/code', 'GET /v1/sandboxes/sbx_1/code/contexts',
      'POST /v1/sandboxes/sbx_1/code/contexts', 'POST /v1/sandboxes/sbx_1/code/contexts/nb/reset',
      'DELETE /v1/sandboxes/sbx_1/code/contexts/nb', 'POST /v1/sandboxes/sbx_1/schedules',
      'GET /v1/sandboxes/sbx_1/schedules', 'POST /v1/sandboxes/sbx_1/schedules/sch_1/run',
      'DELETE /v1/sandboxes/sbx_1/schedules/sch_1', 'GET /v1/sandboxes/sbx_1/metrics', 'GET /v1/sandboxes/sbx_1/logs',
      'GET /v1/sandboxes/sbx_1/secrets',
    ]);
    await expect(box.schedules.create({ cron: '', cmd: 'x' })).rejects.toThrow(/cron/);
  });

  it('streams files through /files/raw and makes presigned links', async () => {
    const { cloud, seen } = cloudWith((s) => {
      const p = s.url.pathname;
      if (p === '/v1/sandboxes/sbx_1') return [200, { sandbox: info() }];
      if (p.endsWith('/files/link')) return [200, { link: { url: 'https://h/x', method: 'PUT', path: '/workspace/big', expires_at: 1 } }];
      if (s.method === 'PUT') return [200, { file: { path: '/workspace/big', size: 3 } }];
      return [200, new Uint8Array([1, 2, 3])];
    });
    const box = await boxOf(cloud);
    expect(Array.from(await box.files.readRaw('/workspace/big'))).toEqual([1, 2, 3]);
    expect((await box.files.writeRaw('/workspace/big', 'abc')).size).toBe(3);
    expect((await box.files.link('/workspace/big', { method: 'PUT', ttlS: 60 })).method).toBe('PUT');
    expect(seen[3]!.body).toEqual({ path: '/workspace/big', method: 'PUT', ttl_s: 60 });
    expect(seen.slice(1, 3).map((s) => `${route(s)}${s.url.search}`)).toEqual([
      'GET /v1/sandboxes/sbx_1/files/raw?path=%2Fworkspace%2Fbig', 'PUT /v1/sandboxes/sbx_1/files/raw?path=%2Fworkspace%2Fbig',
    ]);
    await expect(box.files.link('/x', { ttlS: 1000 })).rejects.toThrow(Kosa8Error);
  });
});

describe('org-level', () => {
  it('egress presets, org egress and capabilities', async () => {
    const { cloud, seen } = cloudWith((s) => {
      if (s.url.pathname === '/v1/egress/presets') return [200, { presets: { pypi: ['pypi.org'] } }];
      if (s.url.pathname === '/v1/org/egress') return [200, { egress: null, applied: 0, failed: [] }];
      return [200, { features: {} }];
    });
    expect(await cloud.egressPresets()).toEqual({ pypi: ['pypi.org'] });
    expect(await cloud.orgEgress()).toBeNull();
    await cloud.setOrgEgress({ internet: false, presets: ['pypi'] }, { enforce: true });
    expect(seen[2]!.body).toEqual({ default: { internet: false, presets: ['pypi'] }, enforce: true });
    await cloud.setOrgEgress(null);
    expect(seen[3]!.body).toEqual({ default: null });
    await cloud.capabilities();
    expect(route(seen[4]!)).toBe('GET /v1/capabilities');
  });
});

describe('pipelines', () => {
  const run = (state: string) => ({ id: 'run_1', state, finished_at: null, repo_url: 'https://github.com/a/b' });

  it('runs, lists, reads logs and artifacts, cancels and waits', async () => {
    let gets = 0;
    const { cloud, seen } = cloudWith((s) => {
      const p = s.url.pathname;
      if (p === '/v1/pipelines/runs' && s.method === 'POST') return [201, { run: run('queued') }];
      if (p === '/v1/pipelines/runs') return [200, { runs: [run('running')] }];
      if (p.endsWith('/logs')) return [200, { run_id: 'run_1', state: 'running', done: false, logs: [{ job: 'test', text: 'ok', next: 2 }] }];
      if (p.endsWith('/cancel')) return [200, { run: run('cancelled') }];
      if (p.endsWith('/artifacts')) return [200, { artifacts: [{ job: 'build', idx: 0, path: 'dist', bytes: 3, url: '/x' }] }];
      if (p.includes('/artifacts/')) return [200, new Uint8Array([31, 139])];
      gets++;
      return [200, { run: run(gets < 2 ? 'running' : 'success') }];
    });
    await cloud.pipelines.run({ repoUrl: 'https://github.com/a/b', ref: 'main', size: '4x8', secrets: ['NPM'], tokenSecret: 'GH', timeoutS: 600 });
    expect(seen[0]!.body).toEqual({ repo_url: 'https://github.com/a/b', ref: 'main', size: '4x8', secrets: ['NPM'], token_secret: 'GH', timeout_s: 600 });
    await cloud.pipelines.list({ state: 'running', limit: 5 });
    expect(seen[1]!.url.search).toBe('?state=running&limit=5');
    expect((await cloud.pipelines.logs('run_1', { job: 'test', after: 10 })).logs[0]!.next).toBe(2);
    expect(seen[2]!.url.search).toBe('?job=test&after=10');
    expect(await cloud.pipelines.artifacts('run_1')).toHaveLength(1);
    expect(Array.from(await cloud.pipelines.downloadArtifact('run_1', 'build', 0))).toEqual([31, 139]);
    expect(seen[4]!.url.pathname).toBe('/v1/pipelines/runs/run_1/artifacts/build/0');
    expect((await cloud.pipelines.cancel('run_1')).state).toBe('cancelled');
    expect((await cloud.pipelines.wait('run_1', { intervalMs: 5 })).state).toBe('success');
    expect(pipelineRunDone({ state: 'failure', finished_at: null })).toBe(true);
    expect(pipelineRunDone({ state: 'running', finished_at: null })).toBe(false);
    await expect(cloud.pipelines.run({ repoUrl: '' })).rejects.toThrow(/repoUrl/);
  });

  it('makes, lists and deletes hooks', async () => {
    const { cloud, seen } = cloudWith((s) => {
      if (s.method === 'POST') return [201, { hook: { id: 'hk_1', url: 'https://api.kosa8.com/v1/pipelines/hooks/hk_1', secret: 'whsec' } }];
      if (s.method === 'DELETE') return [200, { deleted: 'hk_1' }];
      return [200, { hooks: [] }];
    });
    const h = await cloud.pipelines.hooks.create({ repoUrl: 'https://github.com/a/b', provider: 'github', cron: '0 3 * * *', cronRef: 'main' });
    expect(seen[0]!.body).toEqual({ repo_url: 'https://github.com/a/b', provider: 'github', cron: '0 3 * * *', cron_ref: 'main' });
    expect(h.secret).toBe('whsec');
    await cloud.pipelines.hooks.list();
    await cloud.pipelines.hooks.delete('hk_1');
    expect(seen.map(route)).toEqual(['POST /v1/pipelines/hooks', 'GET /v1/pipelines/hooks', 'DELETE /v1/pipelines/hooks/hk_1']);
  });
});

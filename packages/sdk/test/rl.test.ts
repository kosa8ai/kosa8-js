// Copyright (c) 2026 kosa8. Licensed under the MIT License; see LICENSE.

import { afterEach, describe, expect, it } from 'vitest';
import { CloudSandbox, Kosa8Error, rl } from '../src/index.js';
import { info, mockCloud, route } from './helpers.js';
import type { Seen } from './helpers.js';

/** A fake kosa8 Cloud with an RL run, forks, grades, heartbeats and drains. */
function fakeRl(opts: { grade?: (s: Seen) => unknown; rolloutsFail?: number } = {}) {
  let next = 0;
  const rows: Record<string, unknown>[] = [];
  const deleted: string[] = [];
  const beats: unknown[] = [];
  const drains: unknown[] = [];
  const patches: unknown[] = [];
  let rolloutCalls = 0;
  const m = mockCloud((s) => {
    const p = s.url.pathname;
    if (p === '/v1/rl/runs' && s.method === 'POST') return [201, { run: { id: 'run_1', name: (s.body as { name: string }).name, status: 'running' } }];
    if (p === '/v1/rl/runs' && s.method === 'GET') return [200, { runs: [{ id: 'run_1' }], next_cursor: 'c2' }];
    if (p === '/v1/rl/runs/run_1/rollouts' && s.method === 'POST') {
      rolloutCalls++;
      if (opts.rolloutsFail !== undefined && rolloutCalls <= opts.rolloutsFail) return [400, { error: 'invalid_rollout', message: 'no' }];
      const r = (s.body as { rollouts: Record<string, unknown>[] }).rollouts;
      rows.push(...r);
      return [200, { recorded: r.length, ids: r.map((_x, i) => `ro_${i}`) }];
    }
    if (p === '/v1/rl/runs/run_1/rollouts') return [200, { rollouts: rows, next_cursor: null }];
    if (p === '/v1/rl/runs/run_1/export') return [200, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', { 'Content-Type': 'application/x-ndjson' }];
    if (p === '/v1/rl/runs/run_1' && s.method === 'PATCH') {
      patches.push(s.body);
      return [200, { run: { id: 'run_1', status: (s.body as { status?: string }).status } }];
    }
    if (p === '/v1/rl/runs/run_1') return [200, { run: { id: 'run_1' }, summary: { rollouts: rows.length }, recommendations: [] }];
    if (p === '/v1/sandboxes/heartbeat') {
      beats.push(s.body);
      return [200, { extended: 1 }];
    }
    if (p === '/v1/sandboxes/drain') {
      drains.push(s.body);
      return [200, { deleted: 0, ids: [], failed: [], more: false }];
    }
    if (p.endsWith('/fork')) {
      const n = (s.body as { n: number }).n;
      return [201, { sandboxes: Array.from({ length: n }, () => info({ id: `sbx_k${next++}` })), failed: [], requested: n }];
    }
    if (p.endsWith('/grade')) return [200, opts.grade?.(s) ?? { reward: 1, exit: 0, failure_class: 'ok', grader_id: 'sbx_g', recorded: true }];
    if (p === '/v1/sandboxes' && s.method === 'POST') return [201, { sandbox: info({ id: `sbx_c${next++}` }) }];
    if (p.endsWith('/labels')) return [200, { labels: (s.body as { labels: unknown }).labels }];
    if (s.method === 'DELETE') {
      deleted.push(p.split('/').pop()!);
      return [200, {}];
    }
    return [404, { error: 'not_found', message: route(s) }];
  });
  return { ...m, rows, deleted, beats, drains, patches };
}

const quiet = { signals: false, warn: () => {} } as const;

describe('rl.Run', () => {
  it('starts a run, labels and leases what the client makes while open, and finishes it', async () => {
    const f = fakeRl();
    const run = await rl.RlRun.start(f.cloud, { name: 'grpo-1', project: 'p', config: { lr: 1e-5 }, leaseS: 300, ...quiet });
    expect(run.id).toBe('run_1');
    expect(f.seen[0]!.body).toEqual({ name: 'grpo-1', project: 'p', config: { lr: 1e-5 } });
    await f.cloud.sandboxes.create({ template: 'python' });
    const create = f.seen.find((s) => s.url.pathname === '/v1/sandboxes')!;
    expect(create.body).toEqual({ template: 'python', lease_s: 300, labels: { 'kosa8.run': 'run_1' } });
    expect(f.seen.some((s) => s.url.pathname.endsWith('/labels'))).toBe(false);
    await run.finish();
    expect(f.drains).toEqual([{ run_id: 'run_1' }]);
    expect(f.patches).toEqual([{ status: 'finished' }]);
    expect(run.status).toBe('finished');
    // Closed: the client no longer defaults to the run.
    await f.cloud.sandboxes.create();
    expect(f.seen.at(-1)!.body).toEqual({});
    await run.finish(); // twice is fine
    expect(f.patches).toHaveLength(1);
  });

  it('record buffers rollouts and sends them in batches', async () => {
    const f = fakeRl();
    const run = await rl.RlRun.start(f.cloud, { name: 'r', flushEvery: 2, ...quiet });
    await run.record({ step: 0, group: 0, index: 0, reward: 1 });
    expect(run.pending).toBe(1);
    await run.record([{ step: 0, group: 1, index: 0, reward: 0 }]);
    expect(run.pending).toBe(0);
    expect(f.rows).toHaveLength(2);
    await run.record({ reward: 0.5 });
    await run.finish();
    expect(f.rows).toHaveLength(3);
    expect(run.recorded).toBe(3);
  });

  it('keeps rows buffered when a flush fails', async () => {
    const f = fakeRl({ rolloutsFail: 1 });
    const run = await rl.RlRun.start(f.cloud, { name: 'r', ...quiet });
    await run.record({ reward: 1 });
    await expect(run.flush()).rejects.toThrow(/no/);
    expect(run.pending).toBe(1);
    expect(await run.flush()).toBe(1);
    await run.finish();
  });

  it('a flush that failed is sent again as the same chunk with the same Idempotency-Key, so it is never stored twice', async () => {
    const f = fakeRl({ rolloutsFail: 1 });
    const run = await rl.RlRun.start(f.cloud, { name: 'r', ...quiet });
    await run.record([{ reward: 1 }, { reward: 0 }]);
    await expect(run.flush()).rejects.toThrow(/no/);
    await run.record({ reward: 0.5 });
    expect(await run.flush()).toBe(3);
    const posts = f.seen.filter((s) => s.method === 'POST' && s.url.pathname === '/v1/rl/runs/run_1/rollouts');
    expect(posts).toHaveLength(3);
    const k = posts.map((s) => s.headers['Idempotency-Key']);
    expect(k[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(k[1]).toBe(k[0]);
    expect((posts[1]!.body as { rollouts: unknown[] }).rollouts).toEqual((posts[0]!.body as { rollouts: unknown[] }).rollouts);
    expect(k[2]).not.toBe(k[0]);
    expect((posts[2]!.body as { rollouts: unknown[] }).rollouts).toHaveLength(1);
    await run.finish();
  });

  it('withRun marks the run failed when fn throws, and drains', async () => {
    const f = fakeRl();
    await expect(rl.withRun(f.cloud, { name: 'r', ...quiet }, async () => {
      throw new Error('trainer crashed');
    })).rejects.toThrow(/crashed/);
    expect(f.patches).toEqual([{ status: 'failed' }]);
    expect(f.drains).toHaveLength(1);
  });

  it('await using finishes the run', async () => {
    const f = fakeRl();
    {
      await using run = await rl.Run.start(f.cloud, { name: 'r', drainOnExit: false, ...quiet });
      expect(run.status).toBe('running');
    }
    expect(f.patches).toEqual([{ status: 'finished' }]);
    expect(f.drains).toHaveLength(0);
  });

  it('attach, list, summary, rollouts, export and drain', async () => {
    const f = fakeRl();
    const run = await rl.RlRun.attach(f.cloud, 'run_1', quiet);
    expect(f.seen.some((s) => route(s) === 'POST /v1/rl/runs')).toBe(false);
    await run.record({ step: 1, reward: 1 }, { flush: true });
    expect((await run.summary()).summary).toEqual({ rollouts: 1 });
    const page = await run.rollouts({ step: 1, failureClass: 'ok', minReward: 0.5, limit: 10 });
    expect(page.rollouts).toHaveLength(1);
    expect(f.seen.at(-1)!.url.search).toBe('?step=1&failure_class=ok&min_reward=0.5&limit=10');
    expect(await run.export()).toBe('{"step":1,"reward":1}\n');
    expect(await run.exportRows()).toEqual([{ step: 1, reward: 1 }]);
    await run.drain();
    expect(f.drains).toEqual([{ run_id: 'run_1' }]);
    expect(await rl.RlRun.list(f.cloud, { project: 'p', status: 'running' })).toEqual({ runs: [{ id: 'run_1' }], nextCursor: 'c2' });
    expect(f.seen.at(-1)!.url.search).toBe('?project=p&status=running');
    await run.finish();
  });

  it('checks its options', () => {
    const f = fakeRl();
    expect(() => new rl.RlRun(f.cloud, {})).toThrow(/name/);
    expect(() => new rl.RlRun(f.cloud, { name: 'r', flushEvery: 501 })).toThrow(/flushEvery/);
  });
});

describe('rl.Run.map', () => {
  it('forks per rollout, grades in a sealed copy, groups, records and deletes', async () => {
    let i = 0;
    const f = fakeRl({ grade: () => ({ reward: (i++ % 2), exit: 0, failure_class: 'ok', grader_id: 'sbx_g', recorded: true, metrics: { m: 1 } }) });
    const run = await rl.RlRun.start(f.cloud, { name: 'r', ...quiet });
    const base = new CloudSandbox(f.cloud, info({ id: 'sbx_base' }));
    const tasks = [{ id: 't1', files: { '/grader/t.py': 'x' } }, { id: 't2', files: { '/grader/t.py': 'y' } }];
    const out = await run.map(base, tasks, async (box) => (await box.id), { gradeCmd: ['python', '/grader/t.py'], groupSize: 2, concurrency: 4 });
    expect(out).toHaveLength(4);
    expect(out.map((r) => [r.group, r.index])).toEqual([[0, 0], [0, 1], [1, 0], [1, 1]]);
    expect(out.groups().map((g) => g.length)).toEqual([2, 2]);
    expect(out.rewards.filter((r) => r !== null)).toHaveLength(4);
    expect(out.mask).toEqual([true, true, true, true]);
    expect(out.meanReward).toBe(0.5);
    expect(out.byClass).toEqual({ ok: 4 });
    const grades = f.seen.filter((s) => s.url.pathname.endsWith('/grade'));
    expect(grades).toHaveLength(4);
    expect(grades[0]!.body).toMatchObject({ cmd: ['python', '/grader/t.py'], run_id: 'run_1', rollout: { step: 0, group: 0, index: 0, meta: { task: 't1' } } });
    expect((grades[0]!.body as { files: Record<string, string> }).files['/grader/t.py']).toBe('eA==');
    // The first fork is ahead of the workers and is the run's, leased.
    expect(f.seen.find((s) => s.url.pathname.endsWith('/fork'))!.body).toEqual({ n: 4, run_id: 'run_1', lease_s: 600, partial_ok: true });
    expect(new Set(f.deleted).size).toBe(4);
    // The grader recorded them; the run sends nothing again.
    await run.finish();
    expect(f.rows).toHaveLength(0);
  });

  it('masks infra failures (reward null, never 0), retries them, and records what solve returns', async () => {
    const f = fakeRl();
    const run = await rl.RlRun.start(f.cloud, { name: 'r', ...quiet });
    const base = new CloudSandbox(f.cloud, info({ id: 'sbx_base' }));
    const tries: Record<string, number> = {};
    const out = await run.map(base, ['ok', 'flaky', 'down', 'bug'], async (_box, t) => {
      tries[t] = (tries[t] ?? 0) + 1;
      if (t === 'flaky' && tries[t] === 1) throw new Kosa8Error('host gone', { status: 502, code: 'host_failed' });
      if (t === 'down') throw new Kosa8Error('no room', { status: 503, code: 'no_capacity' });
      if (t === 'bug') throw new TypeError('oops');
      return { reward: 0.25, tokens: 12 };
    }, { retries: 1, concurrency: 2 });
    expect(out[0]).toMatchObject({ reward: 0.25, tokens: 12, failureClass: 'ok', masked: false, ok: true });
    expect(out[1]).toMatchObject({ reward: 0.25, attempts: 2, ok: true });
    expect(out[2]).toMatchObject({ reward: null, failureClass: 'infra', masked: true, attempts: 2, ok: false });
    expect(out[3]).toMatchObject({ reward: null, failureClass: 'error', masked: true, attempts: 1 });
    expect(out.mask).toEqual([true, true, false, false]);
    await run.finish();
    expect(f.rows).toHaveLength(4);
    const byGroup = (g: number) => f.rows.find((r) => r.group === g);
    expect(byGroup(2)).toMatchObject({ failure_class: 'infra', reward: null, meta: { masked: true, attempts: 2 } });
    expect(byGroup(0)).toMatchObject({ step: 0, group: 0, index: 0, reward: 0.25, tokens: 12, failure_class: 'ok' });
  });

  it('creates each sandbox from create options, a snapshot or a function', async () => {
    const f = fakeRl();
    const run = await rl.RlRun.start(f.cloud, { name: 'r', leaseS: 120, ...quiet });
    await run.map({ image: 'ghcr.io/x/task:1' }, [1], async () => 1);
    expect(f.seen.find((s) => s.url.pathname === '/v1/sandboxes')!.body).toEqual({ image: 'ghcr.io/x/task:1', lease_s: 120, labels: { 'kosa8.run': 'run_1' } });
    await run.map('snap_abcdefgh', [1], async () => 1, { step: 7 });
    expect(f.seen.filter((s) => s.url.pathname === '/v1/sandboxes')[1]!.body).toEqual({ snapshot: 'snap_abcdefgh', lease_s: 120, labels: { 'kosa8.run': 'run_1' } });
    const made: string[] = [];
    const r = await run.map(async (t: string) => {
      made.push(t);
      return new CloudSandbox(f.cloud, info({ id: `sbx_own_${t}` }));
    }, ['a'], async () => 1, { reward: () => ({ reward: 0.9, metrics: { x: 1 } }) });
    expect(made).toEqual(['a']);
    expect(r[0]).toMatchObject({ reward: 0.9, metrics: { x: 1 }, sandboxId: 'sbx_own_a', step: 1 }); // an explicit step does not count
    expect(f.deleted).toContain('sbx_own_a');
    await expect(run.map('not-a-snap', [1], async () => 1)).rejects.toThrow(/snapshot id/);
    await run.finish();
  });

  it('a rollout with no reward is an error, masked', async () => {
    const f = fakeRl();
    const out = await rl.mapRollouts(async () => 'no reward here', [1], { base: new CloudSandbox(f.cloud, info()) });
    expect(out[0]).toMatchObject({ failureClass: 'error', masked: true, reward: null });
    expect(out[0]!.error).toMatch(/no reward/);
  });

  it('a grade that timed out is masked only when asked', async () => {
    const f = fakeRl({ grade: () => ({ reward: null, exit: null, failure_class: 'timeout', grader_id: 'g' }) });
    const base = new CloudSandbox(f.cloud, info());
    const a = await rl.mapRollouts(async () => 0, [1], { base, gradeCmd: 'pytest', retries: 0 });
    expect(a[0]).toMatchObject({ failureClass: 'timeout', masked: false, reward: null });
    const b = await rl.mapRollouts(async () => 0, [1], { base, gradeCmd: 'pytest', retries: 0, mask: [...rl.DEFAULT_MASK, 'timeout'] });
    expect(b[0]!.masked).toBe(true);
    await expect(rl.mapRollouts(async () => 0, [1], { base, mask: ['nope'] })).rejects.toThrow(/unknown failure classes/);
  });
});

describe('rl.lease', () => {
  const extra: (() => void)[] = [];
  afterEach(() => {
    for (const h of extra.splice(0)) process.off('SIGTERM', h);
  });

  it('heartbeats on a timer and drains on close', async () => {
    const f = fakeRl();
    const ticks: number[] = [];
    const l = rl.lease(f.cloud, { labels: { job: 'e7' }, leaseS: 60, intervalMs: 5, signals: false, onTick: () => ticks.push(1) });
    await new Promise((r) => setTimeout(r, 40));
    expect(f.beats.length).toBeGreaterThan(0);
    expect(f.beats[0]).toEqual({ labels: { job: 'e7' }, extend_s: 60 });
    const d = await l.close();
    expect(d).toEqual({ deleted: 0, ids: [], failed: [], more: false });
    expect(f.drains).toEqual([{ labels: { job: 'e7' } }]);
    expect(l.closed).toBe(true);
    expect(ticks.length).toBeGreaterThan(1);
    const n = f.beats.length;
    await new Promise((r) => setTimeout(r, 20));
    expect(f.beats.length).toBe(n);
    expect(await l.close()).toBe(d);
  });

  it('closes and drains on SIGTERM (exiting only if nothing else listens)', async () => {
    const f = fakeRl();
    const other = () => {};
    process.on('SIGTERM', other);
    extra.push(other);
    const before = process.listenerCount('SIGTERM');
    const l = rl.lease(f.cloud, { runId: 'run_1', intervalMs: 10_000, warn: () => {} });
    expect(process.listenerCount('SIGTERM')).toBe(before + 1);
    process.emit('SIGTERM', 'SIGTERM');
    await l.close();
    expect(f.drains).toEqual([{ run_id: 'run_1' }]);
    expect(process.listenerCount('SIGTERM')).toBe(before);
  });

  it('await using drains; a lease needs a selector and a lease of 60 s or more', async () => {
    const f = fakeRl();
    {
      await using _l = rl.lease(f.cloud, { ids: ['sbx_1'], signals: false });
    }
    expect(f.drains).toEqual([{ ids: ['sbx_1'] }]);
    expect(() => rl.lease(f.cloud, {})).toThrow(/runId, labels or ids/);
    expect(() => rl.lease(f.cloud, { runId: 'r', leaseS: 30 })).toThrow(/60/);
  });

  it('a failed drain is kept as lastError, not thrown', async () => {
    const m = mockCloud(() => [500, { error: 'internal', message: 'boom' }], { retry: false });
    const l = new rl.Lease(m.cloud, { runId: 'r', signals: false, warn: () => {} });
    expect(await l.close()).toBeNull();
    expect(l.lastError).toBeInstanceOf(Kosa8Error);
  });
});

// Copyright (c) 2026 kosa8. Licensed under the MIT License; see LICENSE.

import { describe, expect, it } from 'vitest';
import {
  CloudSandbox,
  Kosa8ApiError,
  Kosa8Cloud,
  Kosa8ConnectionError,
  Kosa8Error,
  Kosa8ExecTimeoutError,
  NO_RETRY,
  RetryPolicy,
  RUN_LABEL,
  SMALL_CLOUD_SIZES,
  callWithRetry,
  classifyFailure,
  failureOf,
  newIdempotencyKey,
} from '../src/index.js';
import { BASE, KEY, UUID_RE, info, mockCloud, route } from './helpers.js';

describe('Idempotency-Key', () => {
  it('sends a fresh UUID on every create, batch, fork and grade', async () => {
    const { cloud, seen } = mockCloud((s) => {
      if (s.url.pathname.endsWith('/grade')) return [200, { reward: 1, exit: 0, failure_class: 'ok', grader_id: 'sbx_g' }];
      if (s.url.pathname.endsWith('/fork')) return [201, { sandboxes: [info({ id: 'sbx_f' })] }];
      if (s.url.pathname.endsWith('/batch')) return [200, { sandboxes: [info()], failed: [], requested: 1, created: 1 }];
      return [201, { sandbox: info() }];
    });
    const box = await cloud.sandboxes.create();
    await cloud.sandboxes.create();
    await cloud.sandboxes.createMany(1);
    await box.fork();
    await box.grade('true');
    const keys = seen.map((s) => s.headers['Idempotency-Key']);
    for (const k of keys) expect(k).toMatch(UUID_RE);
    expect(new Set(keys).size).toBe(5);
  });

  it('reuses the key across retries, and takes the caller’s own', async () => {
    const { cloud, seen } = mockCloud((_s, n) => (n === 0 ? [503, { error: 'no_capacity', message: 'full' }] : [201, { sandbox: info() }]));
    await cloud.sandboxes.create({ idempotencyKey: 'my-key-1' });
    expect(seen).toHaveLength(2);
    expect(seen[0]!.headers['Idempotency-Key']).toBe('my-key-1');
    expect(seen[1]!.headers['Idempotency-Key']).toBe('my-key-1');
  });

  it('is not sent on other calls', async () => {
    const { cloud, seen } = mockCloud(() => [200, { org: {} }]);
    await cloud.me();
    expect(seen[0]!.headers['Idempotency-Key']).toBeUndefined();
  });

  it('newIdempotencyKey makes v4 UUIDs', () => {
    expect(newIdempotencyKey()).toMatch(UUID_RE);
  });
});

describe('failure classes', () => {
  it('failureOf follows the server', () => {
    expect(failureOf(200)).toEqual({ failureClass: 'ok', retryable: false });
    expect(failureOf(504, 'exec_timeout')).toEqual({ failureClass: 'timeout', retryable: false });
    expect(failureOf(429, 'rate_limited')).toEqual({ failureClass: 'quota', retryable: true });
    expect(failureOf(429, 'quota_exceeded')).toEqual({ failureClass: 'quota', retryable: false });
    expect(failureOf(402, 'plan_limit')).toEqual({ failureClass: 'quota', retryable: false });
    expect(failureOf(423)).toEqual({ failureClass: 'quota', retryable: false });
    expect(failureOf(501, 'not_available')).toEqual({ failureClass: 'infra', retryable: false });
    expect(failureOf(503, 'no_capacity')).toEqual({ failureClass: 'infra', retryable: true });
    expect(failureOf(400, 'invalid_lease')).toEqual({ failureClass: 'client', retryable: false });
  });

  it('errors carry failureClass and retryable: the answer’s own, else worked out', async () => {
    const { cloud } = mockCloud((_s, n) => [
      [409, { error: 'conflict', message: 'x', failure_class: 'infra', retryable: true }],
      [402, { error: 'payment_required', message: 'pay' }],
      [400, { error: 'bad', message: 'bad' }],
    ][n]! as [number, unknown], { retry: false });
    const a = await cloud.me().catch((e) => e);
    expect([a.failureClass, a.retryable]).toEqual(['infra', true]);
    const b = await cloud.me().catch((e) => e);
    expect([b.failureClass, b.retryable]).toEqual(['quota', false]);
    const c = await cloud.me().catch((e) => e);
    expect([c.failureClass, c.retryable]).toEqual(['client', false]);
  });

  it('classifyFailure: no answer is infra, an exec timeout is timeout, your own errors are error', () => {
    expect(classifyFailure(new Kosa8ConnectionError('down'))).toEqual({ failureClass: 'infra', retryable: true });
    expect(classifyFailure(new Kosa8ExecTimeoutError('slow', { status: 504 }))).toEqual({ failureClass: 'timeout', retryable: false });
    expect(classifyFailure(new TypeError('bug'))).toEqual({ failureClass: 'error', retryable: false });
    expect(classifyFailure(new Kosa8Error('client-side check'))).toEqual({ failureClass: 'error', retryable: false });
  });

  it('exec results carry failureClass and retryable', async () => {
    const { cloud } = mockCloud((_s, n) => [
      [200, { exit: 0, stdout: 'ok', stderr: '', failure_class: 'ok', retryable: false }],
      [200, { exit: 3, stdout: '', stderr: 'no' }],
      [200, { exit: null, stdout: '', stderr: '', stdout_truncated: true }],
    ][n]! as [number, unknown]);
    const box = new CloudSandbox(cloud, info());
    expect(await box.exec('true')).toMatchObject({ exitCode: 0, failureClass: 'ok', retryable: false });
    expect(await box.exec('false')).toMatchObject({ exitCode: 3, failureClass: 'exit_nonzero', retryable: false });
    expect(await box.exec('x')).toMatchObject({ exitCode: null, failureClass: 'infra', retryable: true, stdoutTruncated: true });
  });
});

describe('RetryPolicy', () => {
  it('waits with full jitter, doubling up to maxMs', () => {
    const p = new RetryPolicy({ baseMs: 100, maxMs: 300 });
    const e = new Kosa8ApiError('x', { status: 503 });
    expect(p.delayMs(e, 1, () => 1)).toBe(100);
    expect(p.delayMs(e, 2, () => 1)).toBe(200);
    expect(p.delayMs(e, 3, () => 1)).toBe(300);
    expect(p.delayMs(e, 3, () => 0.5)).toBe(150);
    expect(p.delayMs(e, 1, () => 0)).toBe(0);
  });

  it('never waits less than Retry-After, capped', () => {
    const p = new RetryPolicy({ baseMs: 10, maxMs: 10, maxRetryAfterMs: 5000 });
    expect(p.delayMs(new Kosa8ApiError('x', { status: 429, retryAfter: 2 }), 1, () => 0)).toBe(2000);
    expect(p.delayMs(new Kosa8ApiError('x', { status: 429, retryAfter: 60 }), 1, () => 0)).toBe(5000);
  });

  it('retries only what can pass, up to attempts', () => {
    const p = new RetryPolicy({ attempts: 3 });
    const infra = new Kosa8ApiError('x', { status: 502, code: 'host_failed' });
    expect(p.shouldRetry(infra, 1)).toBe(true);
    expect(p.shouldRetry(infra, 3)).toBe(false);
    expect(p.shouldRetry(new Kosa8ApiError('x', { status: 402 }), 1)).toBe(false);
    expect(p.shouldRetry(new Error('mine'), 1)).toBe(false);
    expect(NO_RETRY.shouldRetry(infra, 1)).toBe(false);
    expect(() => new RetryPolicy({ attempts: 0 })).toThrow(/attempts/);
  });

  it('callWithRetry calls until it resolves, reporting each retry', async () => {
    let n = 0;
    const retried: number[] = [];
    const out = await callWithRetry(async () => {
      if (++n < 3) throw new Kosa8ConnectionError('down');
      return 'done';
    }, new RetryPolicy({ baseMs: 1, maxMs: 1 }), { onRetry: (_e, a) => retried.push(a) });
    expect(out).toBe('done');
    expect(retried).toEqual([1, 2]);
  });
});

describe('the client retries', () => {
  it('a GET on a 503, honouring retry_after_s', async () => {
    const { cloud, seen } = mockCloud((_s, n) => (n === 0 ? [503, { error: 'no_capacity', message: 'full', retry_after_s: 0.001 }] : [200, { org: { id: 'o' } }]));
    expect(await cloud.me()).toEqual({ org: { id: 'o' } });
    expect(seen).toHaveLength(2);
  });

  it('a network failure on a GET', async () => {
    let n = 0;
    const f = (async () => {
      if (n++ === 0) throw new TypeError('fetch failed');
      return new Response(JSON.stringify({ ok: 1 }), { status: 200 });
    }) as unknown as typeof fetch;
    const cloud = new Kosa8Cloud({ apiKey: KEY, env: {}, baseUrl: BASE, fetch: f, retry: { baseMs: 1, maxMs: 1 } });
    expect(await cloud.usage()).toEqual({ ok: 1 });
  });

  it('not a POST without an Idempotency-Key on a 502, but any request on a passing 429', async () => {
    const { cloud, seen } = mockCloud((s, n) => {
      if (s.url.pathname.endsWith('/invoke')) return [502, { error: 'host_failed', message: 'down' }];
      return n === 1 ? [429, { error: 'rate_limited', message: 'slow' }, { 'Retry-After': '0' }] : [200, { ok: true }];
    });
    await expect(cloud.functions.invoke('f')).rejects.toBeInstanceOf(Kosa8ApiError);
    expect(seen).toHaveLength(1);
    await cloud.functions.map('f', [1]);
    expect(seen).toHaveLength(3);
  });

  it('heartbeat and drain on infra failures; never a used-up quota', async () => {
    const { cloud, seen } = mockCloud((s, n) => {
      if (s.url.pathname.endsWith('/heartbeat')) return n === 0 ? [500, { error: 'internal', message: 'x' }] : [200, { extended: 2 }];
      return [429, { error: 'quota_exceeded', message: 'q' }];
    });
    expect(await cloud.sandboxes.heartbeat({ runId: 'r1' })).toBe(2);
    expect(seen).toHaveLength(2);
    await expect(cloud.sandboxes.create()).rejects.toMatchObject({ code: 'quota_exceeded' });
    expect(seen).toHaveLength(3);
  });

  it('retry: false sends once', async () => {
    const { cloud, seen } = mockCloud(() => [503, { error: 'no_capacity', message: 'full' }], { retry: false });
    await expect(cloud.me()).rejects.toMatchObject({ status: 503, failureClass: 'infra', retryable: true });
    expect(seen).toHaveLength(1);
  });
});

describe('createMany', () => {
  it('posts a batch in API names and answers the sandboxes with failed, requested and created', async () => {
    const { cloud, seen } = mockCloud(() => [200, {
      sandboxes: [info({ id: 'sbx_a' }), info({ id: 'sbx_b' })],
      failed: [{ index: 2, code: 'running_limit', message: 'full', failure_class: 'quota', retryable: false }],
      requested: 3, created: 2, run_id: 'run_1',
    }]);
    const batch = await cloud.sandboxes.createMany(3, {
      template: 'python', size: '0.5x1', runId: 'run_1', leaseS: 600, labels: { team: 'ml' }, prefix: 'roll', region: 'eu',
    });
    expect(route(seen[0]!)).toBe('POST /v1/sandboxes/batch');
    expect(seen[0]!.body).toEqual({
      count: 3, template: 'python', size: '0.5x1', region: 'eu', run_id: 'run_1', lease_s: 600, labels: { team: 'ml' },
      prefix: 'roll', partial_ok: true,
    });
    expect(batch.map((b) => b.id)).toEqual(['sbx_a', 'sbx_b']);
    expect(batch).toBeInstanceOf(Array);
    expect(batch.created).toBe(2);
    expect(batch.requested).toBe(3);
    expect(batch.runId).toBe('run_1');
    expect(batch.failed[0]).toMatchObject({ code: 'running_limit', failure_class: 'quota' });
  });

  it('waits for cold boots and moves a failed boot to failed (deleting it)', async () => {
    const { cloud, seen } = mockCloud((s) => {
      if (s.method === 'POST') return [200, { sandboxes: [info({ id: 'sbx_a', state: 'creating' }), info({ id: 'sbx_b', state: 'creating' })], failed: [], requested: 2 }];
      if (s.method === 'DELETE') return [200, {}];
      if (s.url.pathname.endsWith('sbx_a')) return [200, { sandbox: info({ id: 'sbx_a' }) }];
      return [200, { sandbox: info({ id: 'sbx_b', state: 'error', last_error: 'image pull failed' }) }];
    });
    const batch = await cloud.sandboxes.createMany(2, { image: 'x', partialOk: true });
    expect(batch.map((b) => b.id)).toEqual(['sbx_a']);
    expect(batch.failed).toHaveLength(1);
    expect(batch.failed[0]).toMatchObject({ index: 1, id: 'sbx_b', failure_class: 'infra' });
    expect(seen.some((s) => route(s) === 'DELETE /v1/sandboxes/sbx_b')).toBe(true);
  });

  it('checks n, the lease and partialOk: false before or as it sends', async () => {
    const { cloud, seen } = mockCloud(() => [200, { sandboxes: [], failed: [], requested: 1 }]);
    await expect(cloud.sandboxes.createMany(0)).rejects.toThrow(/n must be/);
    await expect(cloud.sandboxes.createMany(1001)).rejects.toThrow(/n must be/);
    await expect(cloud.sandboxes.createMany(2, { leaseS: 30 })).rejects.toThrow(/leaseS/);
    await expect(cloud.sandboxes.createMany(2, { leaseS: 600, ttlS: 600 })).rejects.toThrow(/not both/);
    await expect(cloud.sandboxes.createMany(2, { prefix: '-bad' })).rejects.toThrow(/prefix/);
    expect(seen).toHaveLength(0);
    await cloud.sandboxes.createMany(2, { partialOk: false, wait: false });
    expect(seen[0]!.body).toEqual({ count: 2, partial_ok: false });
  });
});

describe('fork options', () => {
  it('a plain fork(n) still sends only n', async () => {
    const { cloud, seen } = mockCloud(() => [201, { sandboxes: [info({ id: 'sbx_f' })] }]);
    const kids = await new CloudSandbox(cloud, info()).fork(2);
    expect(seen[0]!.body).toEqual({ n: 2 });
    expect(kids.failed).toEqual([]);
    expect(kids.requested).toBe(2);
  });

  it('sends labels, run_id, lease_s, prefix and partial_ok, up to 1000', async () => {
    const { cloud, seen } = mockCloud(() => [201, {
      parent: 'sbx_1', sandboxes: [info({ id: 'sbx_f1' })], requested: 500, created: 1,
      failed: [{ index: 1, code: 'no_capacity', message: 'host full', failure_class: 'infra', retryable: true }],
    }]);
    const kids = await new CloudSandbox(cloud, info()).fork(500, {
      labels: { a: 'b' }, runId: 'run_9', leaseS: 900, prefix: 'kid', partialOk: true,
    });
    expect(seen[0]!.body).toEqual({ n: 500, labels: { a: 'b' }, run_id: 'run_9', lease_s: 900, prefix: 'kid', partial_ok: true });
    expect(kids.map((k) => k.id)).toEqual(['sbx_f1']);
    expect(kids.failed[0]!.failure_class).toBe('infra');
    await new CloudSandbox(cloud, info()).fork({ n: 3, runId: 'run_9' });
    expect(seen[1]!.body).toEqual({ n: 3, run_id: 'run_9' });
    await expect(new CloudSandbox(cloud, info()).fork({ n: 1, runId: 'bad id' })).rejects.toThrow(/runId/);
  });
});

describe('heartbeat, drain and grade', () => {
  it('heartbeat sends the selector and extend_s', async () => {
    const { cloud, seen } = mockCloud(() => [200, { extended: 4, at: 1 }]);
    expect(await cloud.sandboxes.heartbeat({ runId: 'run_1', labels: { a: 'b' }, extendS: 120 })).toBe(4);
    expect(seen[0]!.body).toEqual({ run_id: 'run_1', labels: { a: 'b' }, extend_s: 120 });
    const box = new CloudSandbox(cloud, info({ id: 'sbx_7' }));
    await box.heartbeat();
    expect(seen[1]!.body).toEqual({ ids: ['sbx_7'] });
    await cloud.sandboxes.heartbeat({ ids: [box, 'sbx_8'] });
    expect(seen[2]!.body).toEqual({ ids: ['sbx_7', 'sbx_8'] });
    await expect(cloud.sandboxes.heartbeat({})).rejects.toThrow(/runId, labels or ids/);
    await expect(cloud.sandboxes.heartbeat({ runId: 'r', extendS: 10 })).rejects.toThrow(/extendS/);
  });

  it('drain answers deleted, ids, failed and more', async () => {
    const { cloud, seen } = mockCloud(() => [200, { deleted: 2, ids: ['a', 'b'], failed: [], more: false }]);
    expect(await cloud.sandboxes.drain({ runId: 'run_1' })).toEqual({ deleted: 2, ids: ['a', 'b'], failed: [], more: false });
    expect(route(seen[0]!)).toBe('POST /v1/sandboxes/drain');
    expect(seen[0]!.body).toEqual({ run_id: 'run_1' });
  });

  it('grade sends cmd, base64 files, timeout, env, keep, run_id and rollout; reads the reward', async () => {
    const { cloud, seen } = mockCloud(() => [200, {
      reward: 0.5, metrics: { passed: 1 }, reward_from: 'json', exit: 0, stdout: '{"reward":0.5}', stderr: '',
      failure_class: 'ok', retryable: false, ms: 900, grader_id: 'sbx_g', kept: false, sandbox_id: 'sbx_1', recorded: true,
    }]);
    const g = await new CloudSandbox(cloud, info()).grade(['pytest', '-q', '/grader/t.py'], {
      files: { '/grader/t.py': 'assert 1', '/grader/b.bin': new Uint8Array([0, 1, 2]) }, timeoutS: 60, env: { A: '1' },
      keep: true, runId: 'run_1', rollout: { step: 3, group: 1, index: 0 },
    });
    expect(route(seen[0]!)).toBe('POST /v1/sandboxes/sbx_1/grade');
    expect(seen[0]!.body).toEqual({
      cmd: ['pytest', '-q', '/grader/t.py'], files: { '/grader/t.py': 'YXNzZXJ0IDE=', '/grader/b.bin': 'AAEC' }, timeout_s: 60,
      env: ['A=1'], keep: true, run_id: 'run_1', rollout: { step: 3, group: 1, index: 0 },
    });
    expect(g).toMatchObject({ reward: 0.5, metrics: { passed: 1 }, rewardFrom: 'json', exitCode: 0, failureClass: 'ok', graderId: 'sbx_g', recorded: true, ms: 900 });
  });

  it('a grade that did not finish has reward null; checks paths and timeoutS', async () => {
    const { cloud, seen } = mockCloud(() => [200, { reward: null, exit: null, failure_class: 'timeout', retryable: true, grader_id: 'sbx_g' }]);
    const g = await cloud.sandboxes.grade('sbx_1', 'pytest');
    expect(seen[0]!.body).toEqual({ cmd: ['sh', '-c', 'pytest'] });
    expect(g).toMatchObject({ reward: null, failureClass: 'timeout', retryable: true });
    const box = new CloudSandbox(cloud, info());
    await expect(box.grade('x', { files: { 'rel/path': 'x' } })).rejects.toThrow(/absolute/);
    await expect(box.grade('x', { timeoutS: 91 })).rejects.toThrow(/timeoutS/);
  });
});

describe('create: lease, run, record, small sizes', () => {
  it('sends lease_s, record and labels (kosa8.run for runId) in the one create', async () => {
    const { cloud, seen } = mockCloud((s) => [201, { sandbox: info({ labels: (s.body as { labels: Record<string, string> }).labels }) }]);
    const box = await cloud.sandboxes.create({ image: 'ghcr.io/azmxai/kosa8-desktop', persistent: true, record: true, leaseS: 600, runId: 'run_1', labels: { a: 'b' } });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.body).toEqual({
      image: 'ghcr.io/azmxai/kosa8-desktop', persistent: true, record: true, lease_s: 600, labels: { a: 'b', [RUN_LABEL]: 'run_1' },
    });
    expect(box.info.labels).toEqual({ a: 'b', 'kosa8.run': 'run_1' });
  });

  it('refuses a lease with a TTL, and a lease out of range', async () => {
    const { cloud, seen } = mockCloud(() => [201, { sandbox: info() }]);
    await expect(cloud.sandboxes.create({ leaseS: 600, ttlS: 600 })).rejects.toThrow(/not both/);
    await expect(cloud.sandboxes.create({ leaseS: 86_401 })).rejects.toThrow(/leaseS/);
    expect(seen).toHaveLength(0);
  });

  it('deletes a sandbox whose boot wait fails, and rethrows', async () => {
    const { cloud, seen } = mockCloud((s) => {
      if (s.method === 'POST') return [202, { sandbox: info({ state: 'creating' }) }];
      if (s.method === 'DELETE') return [200, {}];
      return [200, { sandbox: info({ state: 'error', last_error: 'image pull failed' }) }];
    });
    await expect(cloud.sandboxes.create({ image: 'x' })).rejects.toThrow(/image pull failed/);
    expect(route(seen.at(-1)!)).toBe('DELETE /v1/sandboxes/sbx_1');
  });

  it('checks labels before any request', async () => {
    const { cloud, seen } = mockCloud(() => [201, { sandbox: info() }]);
    const many = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`k${i}`, 'v']));
    await expect(cloud.sandboxes.create({ labels: many, runId: 'run_1' })).rejects.toThrow(/16 labels/);
    expect(seen).toHaveLength(0);
  });

  it('takes the small sizes', async () => {
    const { cloud, seen } = mockCloud(() => [201, { sandbox: info({ cpus: 0.25, mem_mb: 512 }) }]);
    expect(SMALL_CLOUD_SIZES).toEqual(['0.25x0.5', '0.5x1', '1x2']);
    await cloud.sandboxes.create({ size: '0.25x0.5' });
    await cloud.sandboxes.create({ cpus: 0.25, memMb: 512 });
    expect(seen[0]!.body).toEqual({ size: '0.25x0.5' });
    expect(seen[1]!.body).toEqual({ cpus: 0.25, mem_mb: 512 });
  });
});

describe('dispose', () => {
  it('await using deletes the sandbox when the block ends; one gone already is fine', async () => {
    const { cloud, seen } = mockCloud((s) => (s.method === 'DELETE' ? [404, { error: 'not_found', message: 'gone' }] : [201, { sandbox: info() }]));
    {
      await using box = await cloud.sandboxes.create();
      expect(box.id).toBe('sbx_1');
    }
    expect(route(seen[1]!)).toBe('DELETE /v1/sandboxes/sbx_1');
    expect(typeof Symbol.asyncDispose).toBe('symbol');
  });

  it('dispose() rethrows other errors', async () => {
    const { cloud } = mockCloud(() => [409, { error: 'conflict', message: 'busy' }]);
    await expect(new CloudSandbox(cloud, info()).dispose()).rejects.toThrow(/busy/);
  });
});

describe('capability tokens as keys', () => {
  it('a k8c_tok_ token works as the API key', async () => {
    const { seen } = mockCloud(() => [200, {}]);
    const f = (async (url: string, init: RequestInit) => {
      seen.push({ url: new URL(url), method: init.method ?? 'GET', headers: init.headers as Record<string, string>, body: undefined });
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const c = new Kosa8Cloud({ apiKey: 'k8c_tok_abc', env: {}, baseUrl: BASE, fetch: f });
    await c.me();
    expect(seen[0]!.headers.Authorization).toBe('Bearer k8c_tok_abc');
    expect(() => new Kosa8Cloud({ apiKey: 'sk_nope', env: {}, fetch: f })).toThrow(/k8c_live_/);
  });
});

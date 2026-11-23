// Copyright (c) 2026 kosa8. Licensed under the MIT License; see LICENSE.

import { describe, expect, it } from 'vitest';
import { Kosa8Error, Kosa8TimeoutError, jobBody, jobDone } from '../src/index.js';
import type { CloudJob } from '../src/index.js';
import { UUID_RE, mockCloud, route } from './helpers.js';

const job = (over: Partial<CloudJob> = {}): CloudJob => ({ id: 'job_1', run_id: 'run_1', status: 'queued', ...over });
const OPTS = {
  name: 'swe-eval',
  template: 'python',
  tasks: [{ id: 't1', input: { q: 1 }, files: { '/workspace/a.txt': 'hi' } }, { id: 2 }],
  solver: { cmd: 'python /workspace/solve.py', timeoutS: 1800 },
  grader: { cmd: 'pytest -q /hidden/test.py', files: { '/hidden/test.py': new Uint8Array([111, 107]) } },
};

describe('hosted jobs', () => {
  it('submit sends the body in API names, with an Idempotency-Key', async () => {
    const { cloud, seen } = mockCloud(() => [202, { job_id: 'job_1', run_id: 'run_1', job: { status: 'queued' } }]);
    const j = await cloud.jobs.submit({ ...OPTS, concurrency: 64, budgetUsd: 20, retriesOnInfra: 2, leaseS: 900, size: '2x4', project: 'p' });
    expect(j).toMatchObject({ id: 'job_1', run_id: 'run_1', status: 'queued' });
    expect(route(seen[0]!)).toBe('POST /v1/jobs');
    expect(seen[0]!.headers['Idempotency-Key']).toMatch(UUID_RE);
    expect(seen[0]!.body).toEqual({
      name: 'swe-eval',
      tasks: [{ id: 't1', input: { q: 1 }, files: { '/workspace/a.txt': 'aGk=' } }, { id: '2' }],
      solver: { cmd: 'python /workspace/solve.py', timeout_s: 1800 },
      grader: { cmd: 'pytest -q /hidden/test.py', files: { '/hidden/test.py': 'b2s=' } },
      project: 'p', template: 'python', size: '2x4', concurrency: 64, retries_on_infra: 2, lease_s: 900, budget_usd: 20,
    });
    await cloud.jobs.submit({ ...OPTS, idempotencyKey: 'mine' });
    expect(seen[1]!.headers['Idempotency-Key']).toBe('mine');
  });

  it('submit renews its own key after a 5xx, never the caller’s', async () => {
    const { cloud, seen } = mockCloud((_s, n) =>
      n % 2 === 0 ? [502, { error: 'host_failed', message: 'down' }] : [202, { job_id: 'job_1', job: { status: 'queued' } }]);
    await cloud.jobs.submit(OPTS);
    expect(seen[1]!.headers['Idempotency-Key']).not.toBe(seen[0]!.headers['Idempotency-Key']);
    await cloud.jobs.submit({ ...OPTS, idempotencyKey: 'mine' });
    expect(seen[2]!.headers['Idempotency-Key']).toBe('mine');
    expect(seen[3]!.headers['Idempotency-Key']).toBe('mine');
  });

  it('takes JSONL text, keeping its base64 files, and plain commands', () => {
    const body = jobBody({
      name: 'e', image: 'ghcr.io/x/y', tasks: '{"id":"a","files":{"/x":"aGk="}}\n\n{"id":"b"}\n',
      solver: 'true', solverTimeoutS: 60, grader: ['sh', '-c', 'echo 1'], graderTimeoutS: 30, graderFiles: { '/hidden/g': 'x' },
    });
    expect(body.tasks).toEqual([{ id: 'a', files: { '/x': 'aGk=' } }, { id: 'b' }]);
    expect(body.solver).toEqual({ cmd: 'true', timeout_s: 60 });
    expect(body.grader).toEqual({ cmd: ['sh', '-c', 'echo 1'], timeout_s: 30, files: { '/hidden/g': 'eA==' } });
  });

  it('checks the job before any request', async () => {
    const { cloud, seen } = mockCloud(() => [202, { job: job() }]);
    const bad = [
      { ...OPTS, name: '' },
      { ...OPTS, template: undefined },
      { ...OPTS, image: 'x' },
      { ...OPTS, tasks: [] },
      { ...OPTS, tasks: [{ id: 'a' }, { id: 'a' }] },
      { ...OPTS, tasks: 'not json' },
      { ...OPTS, solver: 'true' },
      { ...OPTS, solver: { cmd: 'true', timeoutS: 1, files: {} } },
      { ...OPTS, grader: { cmd: '' } },
      { ...OPTS, graderFiles: { 'relative/path': 'x' } },
    ];
    for (const o of bad) await expect(cloud.jobs.submit(o as never)).rejects.toThrow(Kosa8Error);
    await expect(cloud.jobs.estimate({ ...OPTS, sample: 2, sampleJobId: 'job_0' })).rejects.toThrow(/not both/);
    expect(seen).toHaveLength(0);
  });

  it('get, list, cancel and estimate', async () => {
    const { cloud, seen } = mockCloud((s) => {
      if (s.url.pathname === '/v1/jobs' && s.method === 'GET') return [200, { jobs: [job()] }];
      if (s.url.pathname === '/v1/jobs/estimate') return [200, { basis: 'timeout', sandbox_hours: { low: 1, high: 2 } }];
      if (s.url.pathname.endsWith('/cancel')) return [200, { job: job({ status: 'cancelled' }) }];
      return [200, { job: job({ status: 'running' }) }];
    });
    expect((await cloud.jobs.get('job_1')).status).toBe('running');
    expect(route(seen[0]!)).toBe('GET /v1/jobs/job_1');
    expect(await cloud.jobs.list({ status: 'running', project: 'p', limit: 5, cursor: 'c' })).toHaveLength(1);
    expect(seen[1]!.url.search).toBe('?status=running&project=p&limit=5&cursor=c');
    expect((await cloud.jobs.cancel('job_1')).status).toBe('cancelled');
    expect(route(seen[2]!)).toBe('POST /v1/jobs/job_1/cancel');
    expect((await cloud.jobs.estimate({ ...OPTS, sample: 2 })).basis).toBe('timeout');
    expect(seen[3]!.body).toMatchObject({ name: 'swe-eval', sample: 2 });
    await cloud.jobs.estimate({ ...OPTS, sampleJobId: 'job_0' });
    expect(seen[4]!.body).toMatchObject({ sample_job_id: 'job_0' });
  });

  it('wait polls until the job is done, calling progress', async () => {
    const states = ['queued', 'running', 'done'];
    const { cloud } = mockCloud(() => [200, { job: job({ status: states.shift()! }) }]);
    const seen: string[] = [];
    const done = await cloud.jobs.wait('job_1', { pollMs: 1, progress: (j) => { seen.push(j.status); } });
    expect(done.status).toBe('done');
    expect(seen).toEqual(['queued', 'running', 'done']);
    expect(jobDone(done)).toBe(true);
    expect(jobDone({ status: 'running' })).toBe(false);
  });

  it('wait throws past its timeout', async () => {
    const { cloud } = mockCloud(() => [200, { job: job({ status: 'running' }) }]);
    await expect(cloud.jobs.wait('job_1', { pollMs: 50, timeoutMs: 10 })).rejects.toThrow(Kosa8TimeoutError);
  });
});

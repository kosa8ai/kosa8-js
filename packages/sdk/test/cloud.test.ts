import { describe, expect, it } from 'vitest';
import {
  Kosa8Cloud,
  Kosa8ConnectionError,
  Kosa8Error,
  Kosa8NotFoundError,
  Kosa8PaymentRequiredError,
  Kosa8RateLimitError,
  Kosa8TimeoutError,
} from '../src/index.js';

const KEY = 'k8c_live_testkey';

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function stub(answer: (s: Seen) => [number, unknown]) {
  const seen: Seen[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const s: Seen = {
      url,
      method: init.method ?? 'GET',
      headers: init.headers as Record<string, string>,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    };
    seen.push(s);
    const [status, body] = answer(s);
    return new Response(body === undefined ? '' : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { f, seen };
}

const sbx = (over: Record<string, unknown> = {}) => ({
  id: 'sbx_1', state: 'running', template: 'python', cpus: 1, mem_mb: 512, source: 'pool', region: 'eu-hel1',
  own_host: false, created_at: 1, started_at: 1, stopped_at: null, deleted_at: null, last_error: null,
  running_s: 0, asleep_s: 0, sleep_bytes: 0, cost_usd: 0, ...over,
});

describe('Kosa8Cloud', () => {
  it('reads the key and address from the environment, and refuses bad ones', () => {
    const c = new Kosa8Cloud({ env: { KOSA8_API_KEY: KEY }, fetch: stub(() => [200, {}]).f });
    expect(c.baseUrl).toBe('https://api.kosa8.cloud');
    expect(() => new Kosa8Cloud({ env: {} })).toThrow(/KOSA8_API_KEY/);
    expect(() => new Kosa8Cloud({ apiKey: 'sk-other', env: {} })).toThrow(/k8c_live_/);
    expect(() => new Kosa8Cloud({ apiKey: KEY, baseUrl: 'http://cp.example.com', env: {} })).toThrow(/https/);
    expect(new Kosa8Cloud({ apiKey: KEY, baseUrl: 'http://localhost:8787/', env: {}, fetch: stub(() => [200, {}]).f }).baseUrl)
      .toBe('http://localhost:8787');
  });

  it('creates, execs, sleeps, wakes and deletes a sandbox', async () => {
    const { f, seen } = stub((s) => {
      if (s.method === 'POST' && s.url.endsWith('/v1/sandboxes')) return [201, { sandbox: sbx(), host_ms: 6 }];
      if (s.url.endsWith('/exec')) return [200, { exit: 0, stdout: '42\n', stderr: '', woke_ms: 70 }];
      if (s.url.endsWith('/sleep')) return [200, { sandbox: sbx({ state: 'sleeping' }) }];
      if (s.url.endsWith('/wake')) return [200, { sandbox: sbx() }];
      if (s.method === 'DELETE') return [200, { ok: true, id: 'sbx_1' }];
      return [404, { error: 'not_found', message: 'no route' }];
    });
    const cloud = new Kosa8Cloud({ apiKey: KEY, baseUrl: 'https://cp.test', env: {}, fetch: f });
    const box = await cloud.sandboxes.create({ template: 'python', sleepAfterS: 600 });
    expect(seen[0]!.body).toEqual({ template: 'python', sleep_after_s: 600 });
    expect(seen[0]!.headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(box.id).toBe('sbx_1');

    const r = await box.exec('python3 -c "print(6*7)"', { env: { A: '1' } });
    expect(seen[1]!.body).toEqual({ cmd: ['sh', '-c', 'python3 -c "print(6*7)"'], env: ['A=1'] });
    expect(r).toEqual({ exitCode: 0, stdout: '42\n', stderr: '', wokeMs: 70 });

    expect((await box.sleep()).info.state).toBe('sleeping');
    expect((await box.wake()).info.state).toBe('running');
    await box.delete();
    expect(seen.map((s) => `${s.method} ${new URL(s.url).pathname}`)).toEqual([
      'POST /v1/sandboxes', 'POST /v1/sandboxes/sbx_1/exec', 'POST /v1/sandboxes/sbx_1/sleep',
      'POST /v1/sandboxes/sbx_1/wake', 'DELETE /v1/sandboxes/sbx_1',
    ]);
  });

  it('invokes and maps functions', async () => {
    const { f, seen } = stub((s) => {
      if (s.url.endsWith('/invoke')) return [200, { invocation: { id: 'inv_1', function: 'hello', function_id: 'fn_1', version: 1, trigger: 'api' }, ok: true, result: { hello: 'kosa8' }, logs: '' }];
      return [200, { function: 'hello', count: 2, succeeded: 2, failed: 0, results: [] }];
    });
    const cloud = new Kosa8Cloud({ apiKey: KEY, env: {}, fetch: f });
    const r = await cloud.functions.invoke<{ hello: string }>('hello', { name: 'kosa8' });
    expect(r.result?.hello).toBe('kosa8');
    expect(r.invocation?.id).toBe('inv_1');
    expect(seen[0]!.body).toEqual({ event: { name: 'kosa8' } });
    await cloud.functions.map('hello', [1, 2], { concurrency: 4 });
    expect(seen[1]!.body).toEqual({ events: [1, 2], concurrency: 4 });
  });

  it('turns cloud errors into typed errors with the message and code', async () => {
    const answers: [number, unknown][] = [
      [402, { error: 'payment_required', message: 'add a payment method to start running work' }],
      [429, { error: 'quota_exceeded', message: 'this organization already has 20 active sandboxes' }],
      [404, { error: 'not_found', message: 'no such sandbox' }],
    ];
    const { f } = stub(() => answers.shift()!);
    const cloud = new Kosa8Cloud({ apiKey: KEY, env: {}, fetch: f });

    const pay = await cloud.sandboxes.create().catch((e) => e);
    expect(pay).toBeInstanceOf(Kosa8PaymentRequiredError);
    expect(pay.code).toBe('payment_required');
    expect(pay.message).toBe('add a payment method to start running work');
    expect(pay.status).toBe(402);

    const quota = await cloud.sandboxes.create().catch((e) => e);
    expect(quota).toBeInstanceOf(Kosa8RateLimitError);
    expect(quota.code).toBe('quota_exceeded');

    const missing = await cloud.sandboxes.get('sbx_x').catch((e) => e);
    expect(missing).toBeInstanceOf(Kosa8NotFoundError);
    expect(missing).toBeInstanceOf(Kosa8Error);
  });

  it('reports an unreachable cloud as a connection error', async () => {
    const f = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    const cloud = new Kosa8Cloud({ apiKey: KEY, env: {}, fetch: f });
    const e = await cloud.me().catch((x) => x);
    expect(e).toBeInstanceOf(Kosa8ConnectionError);
    expect(e.message).toMatch(/could not reach kosa8 Cloud/);
  });

  it('reports a cloud that does not answer in time as a timeout', async () => {
    const f = ((_u: string, init: RequestInit) => new Promise((_res, rej) => {
      init.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
    })) as unknown as typeof fetch;
    const cloud = new Kosa8Cloud({ apiKey: KEY, env: {}, fetch: f, timeoutMs: 20 });
    const e = await cloud.me().catch((x) => x);
    expect(e).toBeInstanceOf(Kosa8TimeoutError);
    expect(e).toBeInstanceOf(Kosa8ConnectionError);
  });
});

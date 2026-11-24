import { describe, expect, it } from 'vitest';
import { CloudSandbox, Kosa8Cloud, Kosa8TimeoutError, runFileBytes } from '../src/index.js';
import type { CloudSandboxInfo } from '../src/index.js';

const KEY = 'k8c_live_testkey';

interface Seen { url: URL; method: string; headers: Record<string, string>; body: unknown }

function cloudWith(answer: (s: Seen) => [number, unknown], opts: { timeoutMs?: number; retry?: { attempts: number; baseMs: number } } = {}) {
  const seen: Seen[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const s: Seen = { url: new URL(url), method: init.method ?? 'GET', headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(String(init.body)) : undefined };
    seen.push(s);
    const [status, out] = answer(s);
    return new Response(JSON.stringify(out), { status, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { cloud: new Kosa8Cloud({ apiKey: KEY, env: {}, fetch: f, ...opts }), seen };
}

describe('cloud.run (POST /v1/run)', () => {
  it('sends the body in the API spelling and resolves with the run; a failed command is not a throw', async () => {
    const run = { id: 'sr_1', status: 'failed', exit: 3, stdout: 'hi\n', stderr: '', files: [{ path: '/workspace/o.txt', bytes: 2, content_base64: 'b2s=' }] };
    const { cloud, seen } = cloudWith(() => [200, { run }]);
    const r = await cloud.run({ code: 'print(1)', language: 'python', env: { A: '1' }, timeoutS: 30, outputs: ['o.txt'], share: true });
    expect(r.status).toBe('failed');
    expect(r.exit).toBe(3);
    expect(new TextDecoder().decode(runFileBytes(r.files![0]!))).toBe('ok');
    expect(`${seen[0]!.method} ${seen[0]!.url.pathname}`).toBe('POST /v1/run');
    expect(seen[0]!.body).toEqual({ code: 'print(1)', language: 'python', env: { A: '1' }, timeout_s: 30, outputs: ['o.txt'], share: true });
    expect(seen[0]!.headers['Idempotency-Key']).toBeUndefined();
  });

  it('checks its options before any request', async () => {
    const { cloud, seen } = cloudWith(() => [200, {}]);
    await expect(cloud.run({})).rejects.toThrow(/code or command/);
    await expect(cloud.run({ command: 'ls', timeoutS: 3601 })).rejects.toThrow(/timeoutS/);
    expect(seen).toHaveLength(0);
  });

  it('is not sent again after a 5xx (a run is not idempotent)', async () => {
    const { cloud, seen } = cloudWith(() => [502, { error: 'host_failed', message: 'the host failed' }], { retry: { attempts: 3, baseMs: 0 } });
    await expect(cloud.run({ command: 'ls' })).rejects.toThrow(/host failed/);
    expect(seen).toHaveLength(1);
  });

  it('waits timeoutS plus a minute, past the client timeout', async () => {
    let calls = 0;
    const f = ((_u: string, init: RequestInit) => {
      calls++;
      return new Promise<Response>((resolve, reject) => {
        const t = setTimeout(() => resolve(new Response(JSON.stringify({ run: { id: 'sr_2', status: 'ok', exit: 0 } }), { status: 200 })), 80);
        init.signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); });
      });
    }) as unknown as typeof fetch;
    const cloud = new Kosa8Cloud({ apiKey: KEY, env: {}, fetch: f, timeoutMs: 20, retry: false });
    expect((await cloud.run({ command: 'sleep 0' })).status).toBe('ok');
    await expect(cloud.sandboxes.list()).rejects.toBeInstanceOf(Kosa8TimeoutError);
    expect(calls).toBe(2);
  });

  it('runs.list, get and share', async () => {
    const { cloud, seen } = cloudWith((s) => [200, s.url.pathname === '/v1/runs' ? { runs: [{ id: 'sr_1', status: 'ok', exit: 0 }] } : { run: { id: 'sr_1', status: 'ok', exit: 0 } }]);
    expect((await cloud.runs.list({ limit: 5 })).map((r) => r.id)).toEqual(['sr_1']);
    expect(seen[0]!.url.search).toBe('?limit=5');
    expect((await cloud.runs.get('sr_1')).id).toBe('sr_1');
    expect(`${seen[1]!.method} ${seen[1]!.url.pathname}`).toBe('GET /v1/runs/sr_1');
    await cloud.runs.share('sr_1', { public: true, code: false });
    expect(`${seen[2]!.method} ${seen[2]!.url.pathname}`).toBe('POST /v1/runs/sr_1/share');
    expect(seen[2]!.body).toEqual({ public: true, code: false });
  });
});

describe('box.direct (POST /v1/sandboxes/{id}/direct)', () => {
  it('answers the direct object', async () => {
    const direct = { exec_url: 'https://host-1.kosa8.com/x/exec', files_url: 'https://host-1.kosa8.com/x/files', token: 't', expires_at: 1 };
    const { cloud, seen } = cloudWith(() => [200, { direct }]);
    const box = new CloudSandbox(cloud, { id: 'sbx_1', state: 'running', template: 'base' } as CloudSandboxInfo);
    expect(await box.direct()).toEqual(direct);
    expect(`${seen[0]!.method} ${seen[0]!.url.pathname}`).toBe('POST /v1/sandboxes/sbx_1/direct');
  });
});

// Copyright (c) 2026 kosa8. Licensed under the MIT License; see LICENSE.

import { describe, expect, it } from 'vitest';
import { Kosa8Cloud } from '../src/index.js';
import type { CloudSandboxInfo } from '../src/index.js';

const KEY = 'k8c_live_testkey';

const info = (over: Partial<CloudSandboxInfo> = {}): CloudSandboxInfo => ({
  id: 'sbx_1', state: 'running', template: 'base', cpus: 1, mem_mb: 256, source: 'pool', region: 'us-ash1',
  own_host: false, created_at: 1, started_at: 1, stopped_at: null, deleted_at: null, last_error: null,
  running_s: 0, asleep_s: 0, cost_usd: 0, ...over,
});

interface Seen {
  url: URL;
  method: string;
  body: unknown;
  signal?: AbortSignal;
}

/** A fetch whose answer for a path can be a Response built by the test. */
function cloudWith(answer: (s: Seen) => Response) {
  const seen: Seen[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const s: Seen = {
      url: new URL(url),
      method: init.method ?? 'GET',
      body: init.body ? JSON.parse(String(init.body)) : undefined,
      signal: init.signal ?? undefined,
    };
    seen.push(s);
    if (s.url.pathname === '/v1/sandboxes/sbx_1' && s.method === 'GET') {
      return new Response(JSON.stringify({ sandbox: info() }), { status: 200 });
    }
    return answer(s);
  }) as unknown as typeof fetch;
  return { cloud: new Kosa8Cloud({ apiKey: KEY, env: {}, fetch: f }), seen };
}

describe('exec options', () => {
  it('sends timeout_s and env, and checks timeoutS before any request', async () => {
    const { cloud, seen } = cloudWith(() => new Response(JSON.stringify({ exit: 0, stdout: 'hi\n', stderr: '' })));
    const box = await cloud.sandboxes.get('sbx_1');
    expect((await box.exec('echo hi', { env: { A: '1' }, timeoutS: 30 })).stdout).toBe('hi\n');
    expect(seen[1]!.body).toEqual({ cmd: ['sh', '-c', 'echo hi'], env: ['A=1'], timeout_s: 30 });
    await expect(box.exec('true', { timeoutS: 0 })).rejects.toThrow(/timeoutS/);
    await expect(box.execBackground('true', { timeoutS: 86_401 })).rejects.toThrow(/timeoutS/);
    expect(seen).toHaveLength(2);
  });

  it('passes the caller signal to fetch; an aborted signal refuses before sending', async () => {
    const { cloud, seen } = cloudWith(() => new Response(JSON.stringify({ exit: 0, stdout: '', stderr: '' })));
    const box = await cloud.sandboxes.get('sbx_1');
    const ctl = new AbortController();
    await box.exec('true', { signal: ctl.signal });
    expect(seen[1]!.signal).toBeDefined();
    expect(seen[1]!.signal!.aborted).toBe(false);
    ctl.abort(new Error('stop'));
    expect(seen[1]!.signal!.aborted).toBe(true);
    await expect(box.exec('true', { signal: ctl.signal })).rejects.toThrow('stop');
    expect(seen).toHaveLength(2);
  });

  it('a signal aborted mid-request rejects with its reason, not a timeout', async () => {
    const f = ((_url: string, init: RequestInit) =>
      new Promise((_res, rej) => {
        if (String(_url).endsWith('/sbx_1')) return _res(new Response(JSON.stringify({ sandbox: info() })));
        init.signal!.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
      })) as unknown as typeof fetch;
    const cloud = new Kosa8Cloud({ apiKey: KEY, env: {}, fetch: f });
    const box = await cloud.sandboxes.get('sbx_1');
    const ctl = new AbortController();
    const p = box.exec('sleep 9', { signal: ctl.signal });
    ctl.abort(new Error('user abort'));
    await expect(p).rejects.toThrow('user abort');
  });
});

describe('background exec stop', () => {
  it('POSTs …/exec/{id}/stop and sends timeout_s on start', async () => {
    const { cloud, seen } = cloudWith((s) => {
      if (s.url.pathname.endsWith('/stop')) return new Response(JSON.stringify({ exec: { id: 'bg_1', sandbox_id: 'sbx_1', state: 'stopping' } }));
      return new Response(
        JSON.stringify({ exec: { id: 'bg_1', sandbox_id: 'sbx_1', state: 'running', pid: 9, exit: null, output_path: '/workspace/.kosa8-bg/bg_1.out', exit_path: null } }),
        { status: 202 },
      );
    });
    const box = await cloud.sandboxes.get('sbx_1');
    const job = await box.execBackground('sleep 100', { timeoutS: 300 });
    expect(seen[1]!.body).toEqual({ cmd: ['sh', '-c', 'sleep 100'], timeout_s: 300, background: true });
    expect(await job.stop()).toEqual({ id: 'bg_1', state: 'stopping' });
    expect(`${seen[2]!.method} ${seen[2]!.url.pathname}`).toBe('POST /v1/sandboxes/sbx_1/exec/bg_1/stop');
  });
});

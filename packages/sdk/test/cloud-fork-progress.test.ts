import { describe, expect, it } from 'vitest';
import { CloudSandbox, Kosa8Cloud, Kosa8Error } from '../src/index.js';
import type { CloudForkProgress } from '../src/index.js';

const KEY = 'k8c_live_testkey';

function cloudWith(answer: (headers: Record<string, string>) => Response) {
  const seen: { headers: Record<string, string>; body: unknown }[] = [];
  const f = (async (_url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    seen.push({ headers, body: init.body ? JSON.parse(String(init.body)) : undefined });
    return answer(headers);
  }) as unknown as typeof fetch;
  const cloud = new Kosa8Cloud({ apiKey: KEY, baseUrl: 'http://localhost:8787', env: {}, fetch: f });
  const box = new CloudSandbox(cloud, { id: 'sbx_1', state: 'running', template: 'base' } as never);
  return { box, seen };
}

// An NDJSON body sent in pieces, a line split across two of them.
function ndjson(lines: object[]): Response {
  const text = lines.map((l) => JSON.stringify(l) + '\n').join('');
  const enc = new TextEncoder();
  const cut = Math.floor(text.length / 2);
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(enc.encode(text.slice(0, cut)));
      c.enqueue(enc.encode(text.slice(cut)));
      c.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } });
}

describe('box.fork({ onProgress })', () => {
  it('streams progress per host call, then answers as a plain fork does', async () => {
    const kids = Array.from({ length: 150 }, (_, i) => ({ id: `sbx_k${i}`, state: 'running', parent_id: 'sbx_1' }));
    const { box, seen } = cloudWith(() => ndjson([
      { event: 'progress', requested: 150, created: 0, failed: 0 },
      { event: 'progress', requested: 150, created: 100, failed: 0 },
      { event: 'progress', requested: 150, created: 150, failed: 0 },
      { event: 'result', status: 201, parent: 'sbx_1', sandboxes: kids, requested: 150, created: 150, failed: [] },
    ]));
    const got: CloudForkProgress[] = [];
    const out = await box.fork(150, { onProgress: (p) => got.push(p) });
    expect(out.length).toBe(150);
    expect(got.map((p) => p.created)).toEqual([0, 100, 150]);
    expect(seen[0]!.headers.Accept).toContain('application/x-ndjson');
    expect(seen[0]!.headers['Idempotency-Key']).toBeTruthy();
    expect(seen[0]!.body).toEqual({ n: 150 });
  });

  it('throws the typed error a streamed failure ends with', async () => {
    const { box } = cloudWith(() => ndjson([
      { event: 'progress', requested: 2, created: 0, failed: 0 },
      { event: 'result', status: 409, error: 'fork_refused', message: 'the host refused the fork' },
    ]));
    await expect(box.fork(2, { onProgress: () => {} })).rejects.toMatchObject({ status: 409, code: 'fork_refused' });
    await expect(box.fork(2, { onProgress: () => {} })).rejects.toBeInstanceOf(Kosa8Error);
  });

  it('takes a plain JSON answer from an API that does not stream; without onProgress nothing changes', async () => {
    const { box, seen } = cloudWith(() => new Response(JSON.stringify({ parent: 'sbx_1', sandboxes: [{ id: 'sbx_k', state: 'running' }] }), { status: 201 }));
    const got: CloudForkProgress[] = [];
    expect((await box.fork(1, { onProgress: (p) => got.push(p) })).map((s) => s.id)).toEqual(['sbx_k']);
    expect(got).toEqual([]);
    await box.fork(1);
    expect(seen[1]!.headers.Accept).toBe('application/json');
  });
});

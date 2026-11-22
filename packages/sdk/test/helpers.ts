// Copyright (c) 2026 kosa8. Licensed under the MIT License; see LICENSE.

// A mocked fetch for kosa8 Cloud tests. Clients point at 127.0.0.1:9 (the
// discard port), so a request that escaped the mock would go nowhere.

import { Kosa8Cloud } from '../src/index.js';
import type { CloudSandboxInfo, Kosa8CloudOptions } from '../src/index.js';

export const KEY = 'k8c_live_testkey';
export const BASE = 'http://127.0.0.1:9';

export interface Seen {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** [status, body, headers?]; a thrown error is a network failure. */
export type Answer = [number, unknown, Record<string, string>?];

export function mockCloud(answer: (s: Seen, n: number) => Answer | Promise<Answer>, opts: Partial<Kosa8CloudOptions> = {}) {
  const seen: Seen[] = [];
  const f = (async (url: string, init: RequestInit) => {
    let body: unknown;
    if (init.body instanceof Uint8Array) body = init.body;
    else if (typeof init.body === 'string') body = JSON.parse(init.body);
    const s: Seen = { url: new URL(url), method: init.method ?? 'GET', headers: { ...(init.headers as Record<string, string>) }, body };
    seen.push(s);
    const [status, out, headers] = await answer(s, seen.length - 1);
    const payload = typeof out === 'string' ? out : out === undefined ? '' : JSON.stringify(out);
    return new Response(payload, { status, headers: { 'Content-Type': 'application/json', ...(headers ?? {}) } });
  }) as unknown as typeof fetch;
  const cloud = new Kosa8Cloud({ apiKey: KEY, env: {}, baseUrl: BASE, fetch: f, retry: { baseMs: 1, maxMs: 2 }, ...opts });
  return { cloud, seen };
}

export const route = (s: Seen) => `${s.method} ${s.url.pathname}`;

export const info = (over: Partial<CloudSandboxInfo> = {}): CloudSandboxInfo => ({
  id: 'sbx_1', state: 'running', template: 'base', cpus: 2, mem_mb: 4096, source: 'cold', region: 'us-ash1',
  own_host: false, created_at: 1, started_at: 1, stopped_at: null, deleted_at: null, last_error: null,
  running_s: 0, asleep_s: 0, cost_usd: 0, ...over,
});

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

import { describe, expect, it } from 'vitest';
import {
  CloudSandbox,
  DEFAULT_CLOUD_URL,
  Kosa8ApiError,
  Kosa8Cloud,
  Kosa8Error,
  Kosa8ExecTimeoutError,
  Kosa8OrgFrozenError,
  Kosa8PaymentRequiredError,
  Kosa8RateLimitError,
  Kosa8UnsupportedError,
} from '../src/index.js';
import type { CloudSandboxInfo } from '../src/index.js';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

const KEY = 'k8c_live_testkey';

interface Seen {
  url: URL;
  method: string;
  headers: Record<string, string>;
  /** Decoded JSON for a JSON body; the raw bytes for an octet-stream body. */
  body: unknown;
}

type Answer = [number, unknown] | [number, unknown, Record<string, string>];

function stub(answer: (s: Seen) => Answer) {
  const seen: Seen[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    let body: unknown;
    if (init.body instanceof Uint8Array) body = init.body;
    else if (init.body) body = JSON.parse(String(init.body));
    const s: Seen = { url: new URL(url), method: init.method ?? 'GET', headers, body };
    seen.push(s);
    const [status, out, h] = answer(s);
    const payload = out instanceof Uint8Array ? out : out === undefined ? '' : JSON.stringify(out);
    return new Response(payload as BodyInit, { status, headers: h });
  }) as unknown as typeof fetch;
  return { f, seen };
}

const info = (over: Partial<CloudSandboxInfo> = {}): CloudSandboxInfo => ({
  id: 'sbx_1', state: 'running', template: 'base', origin_item_version: null, cpus: 1, mem_mb: 512, source: 'pool',
  parent_id: null, region: 'eu-hel1', own_host: false, created_at: 1, started_at: 1, stopped_at: null, deleted_at: null,
  delete_after: null, sleep_after_s: 300, last_error: null, host_unreachable: false, running_s: 0, asleep_s: 0,
  sleep_bytes: 0, cost_usd: 0, ...over,
});

function cloudWith(answer: (s: Seen) => Answer) {
  const { f, seen } = stub(answer);
  return { cloud: new Kosa8Cloud({ apiKey: KEY, env: {}, fetch: f }), seen };
}

const route = (s: Seen) => `${s.method} ${s.url.pathname}`;

describe('kosa8 Cloud defaults', () => {
  it('talks to https://api.kosa8.com with no environment', () => {
    expect(DEFAULT_CLOUD_URL).toBe('https://api.kosa8.com');
    const c = new Kosa8Cloud({ apiKey: KEY, env: {}, fetch: stub(() => [200, {}]).f });
    expect(c.baseUrl).toBe('https://api.kosa8.com');
  });

  it('is version 0.4.0', () => {
    expect(pkg.version).toBe('0.4.0');
  });
});

describe('cloud.sandboxes.create', () => {
  it('sends ttl_s, accept_price and only the fields set', async () => {
    const { cloud, seen } = cloudWith(() => [201, { sandbox: info({ delete_after: 99 }) }]);
    const box = await cloud.sandboxes.create({ template: 'me/tool@1.0.0', ttlS: 3600, acceptPrice: 2.5 });
    expect(seen[0]!.body).toEqual({ template: 'me/tool@1.0.0', ttl_s: 3600, accept_price: 2.5 });
    expect(box.info.delete_after).toBe(99);
    await cloud.sandboxes.create();
    expect(seen[1]!.body).toEqual({});
  });

  it('sends delete_after as Unix ms from a number or a Date', async () => {
    const { cloud, seen } = cloudWith(() => [201, { sandbox: info() }]);
    await cloud.sandboxes.create({ deleteAfter: 1_800_000_000_000, sleepAfterS: 0, region: 'eu-hel1' });
    expect(seen[0]!.body).toEqual({ delete_after: 1_800_000_000_000, sleep_after_s: 0, region: 'eu-hel1' });
    await cloud.sandboxes.create({ deleteAfter: new Date(1_800_000_000_000) });
    expect(seen[1]!.body).toEqual({ delete_after: 1_800_000_000_000 });
  });

  it('refuses bad lifetimes before any request', async () => {
    const { cloud, seen } = cloudWith(() => [201, { sandbox: info() }]);
    for (const bad of [59, 7_776_001, 1.5]) {
      await expect(cloud.sandboxes.create({ ttlS: bad })).rejects.toThrow(/ttlS/);
    }
    await expect(cloud.sandboxes.create({ ttlS: 60, deleteAfter: 1 })).rejects.toThrow(/not both/);
    await expect(cloud.sandboxes.create({ sleepAfterS: 604_801 })).rejects.toThrow(/sleepAfterS/);
    await expect(cloud.sandboxes.create({ sleepAfterS: -1 })).rejects.toBeInstanceOf(Kosa8Error);
    expect(seen).toHaveLength(0);
    await cloud.sandboxes.create({ ttlS: 60 });
    await cloud.sandboxes.create({ ttlS: 7_776_000 });
    expect(seen).toHaveLength(2);
  });
});

describe('CloudSandbox.update', () => {
  it('PATCHes the lifetime and refreshes info', async () => {
    const { cloud, seen } = cloudWith((s) =>
      s.method === 'PATCH'
        ? [200, { sandbox: info({ delete_after: 5, sleep_after_s: 60 }), notes: ['sleep timer applies from the next idle period'] }]
        : [201, { sandbox: info() }]);
    const box = await cloud.sandboxes.create();
    const r = await box.update({ ttlS: 600, sleepAfterS: 60 });
    expect(route(seen[1]!)).toBe('PATCH /v1/sandboxes/sbx_1');
    expect(seen[1]!.body).toEqual({ ttl_s: 600, sleep_after_s: 60 });
    expect(r.notes).toEqual(['sleep timer applies from the next idle period']);
    expect(box.info.delete_after).toBe(5);
    expect(box.info.sleep_after_s).toBe(60);
  });

  it('clears the lifetime with ttlS: null, and answers notes: [] when there are none', async () => {
    const { cloud, seen } = cloudWith(() => [200, { sandbox: info() }]);
    const box = new CloudSandbox(cloud, info({ delete_after: 5 }));
    const r = await box.update({ ttlS: null });
    expect(seen[0]!.body).toEqual({ ttl_s: null });
    expect(r.notes).toEqual([]);
    expect(box.info.delete_after).toBeNull();
    await box.update({ deleteAfter: null });
    expect(seen[1]!.body).toEqual({ delete_after: null });
    await box.update({ deleteAfter: new Date(42) });
    expect(seen[2]!.body).toEqual({ delete_after: 42 });
  });

  it('refuses an empty or invalid update before any request', async () => {
    const { cloud, seen } = cloudWith(() => [200, { sandbox: info() }]);
    const box = new CloudSandbox(cloud, info());
    await expect(box.update({})).rejects.toThrow(/ttlS, deleteAfter or sleepAfterS/);
    await expect(box.update({ ttlS: 10 })).rejects.toThrow(/ttlS/);
    await expect(box.update({ ttlS: 600, deleteAfter: 1 })).rejects.toThrow(/not both/);
    expect(seen).toHaveLength(0);
  });
});

describe('listing sandboxes', () => {
  it('list keeps returning a plain array and passes all/limit/cursor', async () => {
    const { cloud, seen } = cloudWith(() => [200, { sandboxes: [info(), info({ id: 'sbx_2' })] }]);
    const all = await cloud.sandboxes.list({ all: true, limit: 10, cursor: 'c1' });
    expect(all.map((b) => b.id)).toEqual(['sbx_1', 'sbx_2']);
    expect(all[0]).toBeInstanceOf(CloudSandbox);
    expect(seen[0]!.url.pathname).toBe('/v1/sandboxes');
    expect(Object.fromEntries(seen[0]!.url.searchParams)).toEqual({ all: '1', limit: '10', cursor: 'c1' });
    await cloud.sandboxes.list();
    expect(seen[1]!.url.search).toBe('');
  });

  it('listPage answers nextCursor null when the server does not paginate', async () => {
    const { cloud } = cloudWith(() => [200, { sandboxes: [info()] }]);
    const page = await cloud.sandboxes.listPage();
    expect(page.nextCursor).toBeNull();
    expect(page.sandboxes).toHaveLength(1);
  });

  it('listPage reads next_cursor and treats "" as the end', async () => {
    const answers: Answer[] = [
      [200, { sandboxes: [info()], next_cursor: 'c2' }],
      [200, { sandboxes: [], next_cursor: '' }],
    ];
    const { cloud } = cloudWith(() => answers.shift()!);
    expect((await cloud.sandboxes.listPage({ limit: 1 })).nextCursor).toBe('c2');
    expect((await cloud.sandboxes.listPage({ cursor: 'c2' })).nextCursor).toBeNull();
  });

  it('iterate follows next_cursor across pages', async () => {
    const pages: Record<string, unknown> = {
      '': { sandboxes: [info({ id: 'a' }), info({ id: 'b' })], next_cursor: 'p2' },
      p2: { sandboxes: [info({ id: 'c' })], next_cursor: 'p3' },
      p3: { sandboxes: [info({ id: 'd' })] },
    };
    const { cloud, seen } = cloudWith((s) => [200, pages[s.url.searchParams.get('cursor') ?? '']]);
    const ids: string[] = [];
    for await (const b of cloud.sandboxes.iterate({ limit: 2, all: true })) ids.push(b.id);
    expect(ids).toEqual(['a', 'b', 'c', 'd']);
    expect(seen).toHaveLength(3);
    expect(seen.every((s) => s.url.searchParams.get('limit') === '2' && s.url.searchParams.get('all') === '1')).toBe(true);
  });

  it('iterate stops when the server repeats a cursor', async () => {
    const { cloud, seen } = cloudWith(() => [200, { sandboxes: [info()], next_cursor: 'same' }]);
    const ids: string[] = [];
    for await (const b of cloud.sandboxes.iterate()) ids.push(b.id);
    expect(seen).toHaveLength(2);
    expect(ids).toHaveLength(2);
  });

  it('iterate makes one request against a server without pagination', async () => {
    const { cloud, seen } = cloudWith(() => [200, { sandboxes: [info(), info({ id: 'sbx_2' })] }]);
    const ids: string[] = [];
    for await (const b of cloud.sandboxes.iterate()) ids.push(b.id);
    expect(ids).toEqual(['sbx_1', 'sbx_2']);
    expect(seen).toHaveLength(1);
  });
});

describe('CloudSandbox.files', () => {
  const box = (answer: (s: Seen) => Answer) => {
    const { cloud, seen } = cloudWith(answer);
    return { sbx: new CloudSandbox(cloud, info()), seen };
  };

  it('read answers the raw bytes and url-encodes the path', async () => {
    const bytes = new Uint8Array([0, 1, 2, 255]);
    const { sbx, seen } = box(() => [200, bytes, { 'Content-Type': 'application/octet-stream' }]);
    const got = await sbx.files.read('/workspace/a b&c.bin');
    expect(got).toBeInstanceOf(Uint8Array);
    expect(Array.from(got)).toEqual([0, 1, 2, 255]);
    expect(route(seen[0]!)).toBe('GET /v1/sandboxes/sbx_1/files');
    expect(seen[0]!.url.search).toBe('?path=%2Fworkspace%2Fa%20b%26c.bin');
    expect(seen[0]!.url.searchParams.get('path')).toBe('/workspace/a b&c.bin');
  });

  it('readText decodes UTF-8', async () => {
    const { sbx } = box(() => [200, new TextEncoder().encode('héllo\n')]);
    expect(await sbx.files.readText('/workspace/h.txt')).toBe('héllo\n');
  });

  it('write sends a string or bytes as application/octet-stream', async () => {
    const fi = { name: 'x', path: '/workspace/x', type: 'file', size: 3, mode: '-rw-r--r--', mod_time: '2026-11-12T00:00:00Z' };
    const { sbx, seen } = box(() => [200, { file: fi }]);
    expect(await sbx.files.write('/workspace/x', 'abc')).toEqual(fi);
    expect(seen[0]!.method).toBe('PUT');
    expect(seen[0]!.headers['Content-Type']).toBe('application/octet-stream');
    expect(Array.from(seen[0]!.body as Uint8Array)).toEqual([97, 98, 99]);
    await sbx.files.write('/workspace/y', new Uint8Array([9, 8]));
    expect(Array.from(seen[1]!.body as Uint8Array)).toEqual([9, 8]);
    expect(seen[1]!.url.searchParams.get('path')).toBe('/workspace/y');
  });

  it('list defaults to /workspace', async () => {
    const { sbx, seen } = box(() => [200, { path: '/workspace', files: [{ name: 'a', path: '/workspace/a', type: 'dir' }] }]);
    expect(await sbx.files.list()).toEqual([{ name: 'a', path: '/workspace/a', type: 'dir' }]);
    expect(route(seen[0]!)).toBe('GET /v1/sandboxes/sbx_1/files/list');
    expect(seen[0]!.url.searchParams.get('path')).toBe('/workspace');
    await sbx.files.list('/tmp');
    expect(seen[1]!.url.searchParams.get('path')).toBe('/tmp');
  });

  it('mkdir POSTs the path', async () => {
    const { sbx, seen } = box(() => [200, { file: { path: '/workspace/d', type: 'dir' } }]);
    expect((await sbx.files.mkdir('/workspace/d')).type).toBe('dir');
    expect(route(seen[0]!)).toBe('POST /v1/sandboxes/sbx_1/files/mkdir');
    expect(seen[0]!.body).toEqual({ path: '/workspace/d' });
  });

  it('delete removes a file, or a folder with recursive', async () => {
    const { sbx, seen } = box((s) => [200, { removed: s.url.searchParams.get('path') }]);
    expect(await sbx.files.delete('/workspace/f')).toBe('/workspace/f');
    expect(route(seen[0]!)).toBe('DELETE /v1/sandboxes/sbx_1/files');
    expect(seen[0]!.url.searchParams.has('recursive')).toBe(false);
    await sbx.files.delete('/workspace/d', { recursive: true });
    expect(seen[1]!.url.searchParams.get('recursive')).toBe('1');
  });

  it('a JSON error on a bytes endpoint is still a typed error', async () => {
    const { sbx } = box(() => [413, { error: 'too_large', message: 'one file is at most 8388608 bytes through the API' }]);
    const e = await sbx.files.read('/workspace/big').catch((x) => x);
    expect(e).toBeInstanceOf(Kosa8ApiError);
    expect(e.status).toBe(413);
    expect(e.code).toBe('too_large');
    expect(e.message).toMatch(/8388608/);
  });
});

describe('checkpoints, rewind, fork, ports, templates', () => {
  it('checkpoint saves with an optional label', async () => {
    const cp = { id: 'cp_1', label: 'before', auto: false, created_at: '2026-11-12T00:00:00Z', bytes: 10 };
    const { cloud, seen } = cloudWith(() => [201, { checkpoint: cp, evicted: [], ms: 40 }]);
    const sbx = new CloudSandbox(cloud, info());
    expect(await sbx.checkpoint('before')).toEqual(cp);
    expect(route(seen[0]!)).toBe('POST /v1/sandboxes/sbx_1/checkpoints');
    expect(seen[0]!.body).toEqual({ label: 'before' });
    await sbx.checkpoint();
    expect(seen[1]!.body).toEqual({});
    await expect(sbx.checkpoint('x'.repeat(201))).rejects.toThrow(/200/);
    expect(seen).toHaveLength(2);
  });

  it('checkpoints lists them oldest first', async () => {
    const { cloud, seen } = cloudWith(() => [200, { checkpoints: [{ id: 'cp_1' }, { id: 'cp_2' }], max: 10 }]);
    const list = await new CloudSandbox(cloud, info()).checkpoints();
    expect(list.map((c) => c.id)).toEqual(['cp_1', 'cp_2']);
    expect(route(seen[0]!)).toBe('GET /v1/sandboxes/sbx_1/checkpoints');
  });

  it('rewind goes back and refreshes info', async () => {
    const { cloud, seen } = cloudWith(() => [200, {
      sandbox: info({ state: 'running', running_s: 9 }), checkpoint: { id: 'cp_1' }, backup: { id: 'cp_auto', auto: true }, ms: 80,
    }]);
    const sbx = new CloudSandbox(cloud, info());
    const r = await sbx.rewind({ id: 'cp_1' });
    expect(route(seen[0]!)).toBe('POST /v1/sandboxes/sbx_1/rewind');
    expect(seen[0]!.body).toEqual({ checkpoint_id: 'cp_1' });
    expect(r).toEqual({ checkpoint: { id: 'cp_1' }, backup: { id: 'cp_auto', auto: true }, ms: 80 });
    expect(sbx.info.running_s).toBe(9);
    await sbx.rewind('cp_2');
    expect(seen[1]!.body).toEqual({ checkpoint_id: 'cp_2' });
  });

  it('fork answers new sandboxes and checks n', async () => {
    const { cloud, seen } = cloudWith(() => [201, {
      parent: 'sbx_1', host_ms: 30,
      sandboxes: [info({ id: 'sbx_f1', source: 'fork', parent_id: 'sbx_1' }), info({ id: 'sbx_f2', source: 'fork', parent_id: 'sbx_1' })],
    }]);
    const sbx = new CloudSandbox(cloud, info());
    const kids = await sbx.fork(2);
    expect(route(seen[0]!)).toBe('POST /v1/sandboxes/sbx_1/fork');
    expect(seen[0]!.body).toEqual({ n: 2 });
    expect(kids.map((k) => k.id)).toEqual(['sbx_f1', 'sbx_f2']);
    expect(kids[0]!.info.source).toBe('fork');
    expect(kids[0]!.info.parent_id).toBe('sbx_1');
    await sbx.fork();
    expect(seen[1]!.body).toEqual({ n: 1 });
    await expect(sbx.fork(0)).rejects.toThrow(/n must be/);
    await expect(sbx.fork(101)).rejects.toThrow(/n must be/);
    expect(seen).toHaveLength(2);
  });

  it('ports lists listening ports', async () => {
    const p = { port: 8000, address: '0.0.0.0', container: 'main', loopback: false };
    const { cloud, seen } = cloudWith(() => [200, { ports: [p] }]);
    expect(await new CloudSandbox(cloud, info()).ports()).toEqual([p]);
    expect(route(seen[0]!)).toBe('GET /v1/sandboxes/sbx_1/ports');
  });

  it('templates lists what the org can create from', async () => {
    const t = { key: 'python', cpus: 1, mem_mb: 512, image: 'kosa8/python', regions: ['eu-hel1'], hosts: 1, warm: 2, own_host: false };
    const { cloud, seen } = cloudWith(() => [200, { templates: [t], default_template: 'base' }]);
    expect(await cloud.templates()).toEqual([t]);
    expect(route(seen[0]!)).toBe('GET /v1/templates');
  });
});

describe('cloud error mapping', () => {
  const fail = async (answer: Answer, call: (c: Kosa8Cloud) => Promise<unknown>) => {
    const { cloud } = cloudWith(() => answer);
    return call(cloud).then(() => { throw new Error('expected an error'); }, (e: any) => e);
  };
  const exec = (c: Kosa8Cloud) => new CloudSandbox(c, info()).exec('sleep 60');

  it('402 exposes code, upgradeUrl and agentMessage', async () => {
    const e = await fail([402, {
      error: 'spending_cap_reached', message: 'this month reached the spending cap',
      upgrade_url: 'https://app.kosa8.com/#billing', agent_message: 'Tell your person to raise the cap.',
    }], (c) => c.sandboxes.create());
    expect(e).toBeInstanceOf(Kosa8PaymentRequiredError);
    expect(e.code).toBe('spending_cap_reached');
    expect(e.upgradeUrl).toBe('https://app.kosa8.com/#billing');
    expect(e.agentMessage).toBe('Tell your person to raise the cap.');
    expect(e.message).toBe('this month reached the spending cap');
  });

  it('402 without the extras answers null for them', async () => {
    const e = await fail([402, { error: 'price_not_accepted', message: 'accept the price' }], (c) => c.sandboxes.create());
    expect(e).toBeInstanceOf(Kosa8PaymentRequiredError);
    expect(e.upgradeUrl).toBeNull();
    expect(e.agentMessage).toBeNull();
  });

  it('423 is Kosa8OrgFrozenError', async () => {
    const e = await fail([423, { error: 'org_frozen', message: 'this organization is frozen' }], (c) => c.sandboxes.create());
    expect(e).toBeInstanceOf(Kosa8OrgFrozenError);
    expect(e).toBeInstanceOf(Kosa8ApiError);
    expect(e.code).toBe('org_frozen');
    expect(e.status).toBe(423);
  });

  it('429 reads Retry-After in seconds', async () => {
    const e = await fail([429, { error: 'rate_limited', message: 'slow down' }, { 'Retry-After': '7' }], (c) => c.me());
    expect(e).toBeInstanceOf(Kosa8RateLimitError);
    expect(e.retryAfter).toBe(7);
    expect(e.code).toBe('rate_limited');
  });

  it('429 reads Retry-After as an HTTP date, and leaves it undefined when absent', async () => {
    const at = new Date(Date.now() + 30_000).toUTCString();
    const e = await fail([429, { error: 'quota_exceeded', message: 'q' }, { 'Retry-After': at }], (c) => c.me());
    expect(e.retryAfter).toBeGreaterThan(20);
    expect(e.retryAfter).toBeLessThanOrEqual(31);
    const none = await fail([429, { error: 'quota_exceeded', message: 'q' }], (c) => c.me());
    expect(none.retryAfter).toBeUndefined();
  });

  it('504 is Kosa8ExecTimeoutError', async () => {
    const e = await fail([504, { error: 'gateway_timeout', message: 'upstream timed out' }], exec);
    expect(e).toBeInstanceOf(Kosa8ExecTimeoutError);
    expect(e).toBeInstanceOf(Kosa8ApiError);
    expect(e.status).toBe(504);
    expect(e.message).toMatch(/upstream timed out/);
    expect(e.message).toMatch(/30 s/);
    expect(e.message).toMatch(/nohup/);
  });

  it('code exec_timeout is Kosa8ExecTimeoutError on any status', async () => {
    const e = await fail([408, { error: 'exec_timeout', message: 'the command ran past 30 s' }], exec);
    expect(e).toBeInstanceOf(Kosa8ExecTimeoutError);
    expect(e.code).toBe('exec_timeout');
  });

  it('502 host_failed on /exec that timed out is Kosa8ExecTimeoutError', async () => {
    const e = await fail([502, { error: 'host_failed', message: 'exec failed on the host: context deadline: timed out' }], exec);
    expect(e).toBeInstanceOf(Kosa8ExecTimeoutError);
    expect(e.message).toMatch(/exec failed on the host/);
  });

  it('other 502 host_failed answers stay plain API errors', async () => {
    const notExec = await fail([502, { error: 'host_failed', message: 'the host timed out starting it' }], (c) => c.sandboxes.create());
    expect(notExec).not.toBeInstanceOf(Kosa8ExecTimeoutError);
    expect(notExec).toBeInstanceOf(Kosa8ApiError);
    const otherExec = await fail([502, { error: 'host_failed', message: 'exec failed on the host: no such container' }], exec);
    expect(otherExec).not.toBeInstanceOf(Kosa8ExecTimeoutError);
  });

  it('501 from a host without the data plane is Kosa8UnsupportedError', async () => {
    for (const code of ['not_available', 'not_supported']) {
      const e = await fail([501, { error: code, message: 'Checkpoints is not available on this host yet' }], (c) => new CloudSandbox(c, info()).checkpoint());
      expect(e).toBeInstanceOf(Kosa8UnsupportedError);
      expect(e.code).toBe(code);
    }
  });

  it('keeps the whole cloud answer as body', async () => {
    const answer = { error: 'payment_required', message: 'add a card', upgrade_url: 'https://app.kosa8.com/#billing' };
    const e = await fail([402, answer], (c) => c.sandboxes.create());
    expect(e.body).toEqual(answer);
  });
});

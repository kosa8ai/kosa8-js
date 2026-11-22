// Copyright (c) 2026 kosa8. Licensed under the MIT License; see LICENSE.

// Streamed exec (POST …/exec {stream: true}) in the cloud client and the E2B
// shim: output reaches callbacks as NDJSON frames arrive, not at the end.

import { afterEach, describe, expect, it } from 'vitest';
import { CloudSandbox, Kosa8BadRequestError, Kosa8Cloud, Kosa8ExecTimeoutError, Kosa8StreamError } from '../src/index.js';
import { CommandExitError, CommandHandle, Sandbox, TimeoutError, Unsupported, setDefaultCloud } from '../src/compat/e2b.js';
import { KEY, info } from './helpers.js';

type Frame = Record<string, unknown>;
const b64 = (s: string | Uint8Array) => Buffer.from(s).toString('base64');
const out = (stream: 'stdout' | 'stderr', data: string | Uint8Array): Frame => ({ stream, data: b64(data) });

/**
 * A Response whose body hands over one NDJSON line per pull, logging each,
 * so a test can see callbacks interleave with arrival.
 */
function ndjson(frames: Frame[], log: string[] = []): Response {
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(ctl) {
      if (i >= frames.length) {
        ctl.close();
        return;
      }
      log.push(`frame${i}`);
      ctl.enqueue(new TextEncoder().encode(JSON.stringify(frames[i++]) + '\n'));
    },
  }, { highWaterMark: 0 });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } });
}

interface Seen {
  method: string;
  path: string;
  body: Record<string, unknown> | undefined;
  accept: string | undefined;
}

function fakeCloud(answer: (s: Seen) => Response | undefined) {
  const seen: Seen[] = [];
  const bg: Record<string, { polls: string[]; exit: number }> = {};
  let n = 0;
  const f = (async (url: string, init: RequestInit) => {
    const u = new URL(url);
    const s: Seen = {
      method: init.method ?? 'GET', path: u.pathname,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      accept: (init.headers as Record<string, string>).Accept,
    };
    seen.push(s);
    const own = answer(s);
    if (own) return own;
    const j = (status: number, v: unknown) => new Response(JSON.stringify(v), { status });
    if (s.path === '/v1/sandboxes' && s.method === 'POST') return j(201, { sandbox: info({ id: 'sbx_1' }) });
    if (s.path === '/v1/sandboxes/sbx_1' && s.method === 'GET') return j(200, { sandbox: info() });
    if (s.path === '/v1/sandboxes/sbx_1' && s.method === 'DELETE') return j(200, {});
    if (s.path === '/v1/sandboxes/sbx_1/exec' && s.body?.background) {
      const id = `bg_${++n}`;
      bg[id] = { polls: [...bgPolls], exit: 0 };
      return j(202, { exec: { id, state: 'running', exit: null } });
    }
    const m = /^\/v1\/sandboxes\/sbx_1\/exec\/(bg_\d+)$/.exec(s.path);
    if (m) {
      const b = bg[m[1]!]!;
      const output = b.polls.shift() ?? '';
      return j(200, { exec: { id: m[1], state: b.polls.length ? 'running' : 'exited', exit: b.polls.length ? null : b.exit, output } });
    }
    if (s.path === '/v1/sandboxes/sbx_1/exec') {
      if (s.body?.stream) return ndjson([out('stdout', 'ok\n'), { done: true, exit: 0 }]);
      return j(200, { exit: 0, stdout: 'buffered\n', stderr: '' });
    }
    return j(404, { error: 'not_found', message: `no route ${s.method} ${s.path}` });
  }) as unknown as typeof fetch;
  let bgPolls: string[] = [];
  const cloud = new Kosa8Cloud({ apiKey: KEY, env: {}, baseUrl: 'http://127.0.0.1:9', fetch: f, retry: { baseMs: 1, maxMs: 2 } });
  return { cloud, seen, setBg: (p: string[]) => (bgPolls = p), last: () => seen.filter((x) => x.path.endsWith('/exec')).at(-1)! };
}

describe('CloudSandbox.execStream', () => {
  it('calls back as frames arrive and returns the whole result', async () => {
    const log: string[] = [];
    const { cloud, last } = fakeCloud((s) => s.body?.stream
      ? ndjson([out('stdout', '1\n'), { stream: 'stdout', data: '', heartbeat: true }, out('stderr', 'w\n'), out('stdout', '2\n'), { done: true, exit: 0 }], log)
      : undefined);
    const box = new CloudSandbox(cloud, info());
    const r = await box.exec('x', { onStdout: (t) => log.push(`out:${t}`), onStderr: (t) => log.push(`err:${t}`), timeoutS: 300 });
    expect(log).toEqual(['frame0', 'out:1\n', 'frame1', 'frame2', 'err:w\n', 'frame3', 'out:2\n', 'frame4']);
    expect(r).toMatchObject({ exitCode: 0, stdout: '1\n2\n', stderr: 'w\n', failureClass: 'ok' });
    expect(last().body).toMatchObject({ stream: true, timeout_s: 300, cmd: ['sh', '-c', 'x'] });
    expect(last().accept).toContain('application/x-ndjson');
  });

  it('iterates, decoding UTF-8 split across frames', async () => {
    const snow = new TextEncoder().encode('☃');
    const { cloud } = fakeCloud(() => ndjson([out('stdout', snow.slice(0, 1)), out('stdout', new Uint8Array([...snow.slice(1), 33])), { done: true, exit: 3 }]));
    const s = await new CloudSandbox(cloud, info()).execStream(['x']);
    const got: string[] = [];
    for await (const c of s) got.push(`${c.stream}:${c.text}`);
    expect(got).toEqual(['stdout:☃!']);
    expect(s.exitCode).toBe(3);
  });

  it('a timeout frame throws Kosa8ExecTimeoutError with the output so far', async () => {
    const { cloud } = fakeCloud(() => ndjson([out('stdout', 'part'), { done: true, error: 'ran past timeout_s', code: 'exec_timeout' }]));
    const err = await (await new CloudSandbox(cloud, info()).execStream('sleep 9', { timeoutS: 2 })).result().catch((e) => e);
    expect(err).toBeInstanceOf(Kosa8ExecTimeoutError);
    expect(err.stdout).toBe('part');
  });

  it('an error frame or a cut stream throws Kosa8StreamError', async () => {
    const a = fakeCloud(() => ndjson([out('stderr', 'e'), { done: true, error: 'host lost' }]));
    const e1 = await (await new CloudSandbox(a.cloud, info()).execStream('x')).result().catch((e) => e);
    expect(e1).toBeInstanceOf(Kosa8StreamError);
    expect([e1.message, e1.stderr]).toEqual(['host lost', 'e']);
    const b = fakeCloud(() => ndjson([out('stdout', 'a')]));
    await expect((await new CloudSandbox(b.cloud, info()).execStream('x')).result()).rejects.toBeInstanceOf(Kosa8StreamError);
  });

  it('a refusal throws before any output', async () => {
    const { cloud } = fakeCloud(() => new Response(JSON.stringify({ error: 'invalid_cmd', message: 'bad' }), { status: 400 }));
    await expect(new CloudSandbox(cloud, info()).execStream(['x'])).rejects.toBeInstanceOf(Kosa8BadRequestError);
  });

  it('exec stays buffered without callbacks or a long timeout', async () => {
    const { cloud, last } = fakeCloud(() => undefined);
    const box = new CloudSandbox(cloud, info());
    expect((await box.exec('x')).stdout).toBe('buffered\n');
    expect(last().body?.stream).toBeUndefined();
    expect((await box.exec('x', { timeoutS: 120 })).stdout).toBe('ok\n');
    expect(last().body?.stream).toBe(true);
  });
});

describe('E2B shim', () => {
  afterEach(() => {
    setDefaultCloud(undefined);
    CommandHandle.pollIntervalMs = 1000;
  });

  it('creates with E2B options and kills', async () => {
    const f = fakeCloud(() => undefined);
    setDefaultCloud(f.cloud);
    const sb = await Sandbox.create({ timeoutMs: 600_000, envs: { A: '1' }, metadata: { team: 'ml' }, allowInternetAccess: false });
    expect(sb.sandboxId).toBe('sbx_1');
    expect(f.seen[0]!.body).toMatchObject({ template: 'python', ttl_s: 600, env: { A: '1' }, labels: { team: 'ml' }, egress: { internet: false } });
    await Sandbox.create('node');
    expect(f.seen.at(-1)!.body).toMatchObject({ template: 'node', ttl_s: 300 });
    expect(await sb.kill()).toBe(true);
    expect((await Sandbox.connect('sbx_1')).sandboxId).toBe('sbx_1');
  });

  it('commands.run with callbacks streams, in order', async () => {
    const f = fakeCloud((s) => s.body?.stream
      ? ndjson([out('stdout', '1\n'), out('stderr', 'w\n'), out('stdout', '2\n'), { done: true, exit: 0 }])
      : undefined);
    setDefaultCloud(f.cloud);
    const sb = await Sandbox.create();
    const got: string[] = [];
    const r = await sb.commands.run('x', { onStdout: (d) => void got.push(`o:${d}`), onStderr: (d) => void got.push(`e:${d}`), cwd: 'src', envs: { X: '1' } });
    expect(got).toEqual(['o:1\n', 'e:w\n', 'o:2\n']);
    expect(r).toEqual({ exitCode: 0, stdout: '1\n2\n', stderr: 'w\n' });
    expect(f.last().body).toMatchObject({ stream: true, timeout_s: 60, env: ['X=1'] });
    const cmd = f.last().body!.cmd as string[];
    expect([cmd[4], cmd.at(-1)]).toEqual(['/workspace/src', 'x']);
  });

  it('a long or no timeout streams; a plain run is buffered', async () => {
    const f = fakeCloud(() => undefined);
    setDefaultCloud(f.cloud);
    const sb = await Sandbox.create();
    await sb.commands.run('sleep 100', { timeoutMs: 150_000 });
    expect(f.last().body).toMatchObject({ stream: true, timeout_s: 150 });
    await sb.commands.run('serve', { timeoutMs: 0 });
    expect(f.last().body?.stream).toBe(true);
    expect(f.last().body?.timeout_s).toBeUndefined();
    expect((await sb.commands.run('echo')).stdout).toBe('buffered\n');
    expect(f.last().body?.stream).toBeUndefined();
  });

  it('a non-zero exit and a timeout throw E2B errors', async () => {
    let frames: Frame[] = [];
    const f = fakeCloud((s) => (s.body?.stream ? ndjson(frames) : undefined));
    setDefaultCloud(f.cloud);
    const sb = await Sandbox.create();
    frames = [out('stderr', 'bad'), { done: true, exit: 2 }];
    const e = await sb.commands.run('false', { onStderr: () => {} }).catch((x) => x);
    expect(e).toBeInstanceOf(CommandExitError);
    expect([e.exitCode, e.stderr]).toEqual([2, 'bad']);
    frames = [{ done: true, error: 'ran past its timeout_s', code: 'exec_timeout' }];
    await expect(sb.commands.run('sleep 999', { timeoutMs: 120_000 })).rejects.toBeInstanceOf(TimeoutError);
  });

  it('background callbacks and wait get each new piece', async () => {
    const f = fakeCloud(() => undefined);
    setDefaultCloud(f.cloud);
    CommandHandle.pollIntervalMs = 1;
    const sb = await Sandbox.create();
    f.setBg(['a', 'a', 'ab', 'abc']);
    const got: string[] = [];
    const h = await sb.commands.run('make', { background: true, onStdout: (d) => void got.push(d) });
    expect(h.pid).toBe('bg_1');
    const r = await h.wait();
    expect([got, r.stdout]).toEqual([['a', 'b', 'c'], 'abc']);
    f.setBg(['x', 'xy']);
    const h2 = await sb.commands.run('make', { background: true });
    const seen: string[] = [];
    await h2.wait({ onStdout: (d) => void seen.push(d) });
    expect(seen).toEqual(['x', 'y']);
  });

  it('files map to /workspace', async () => {
    const f = fakeCloud((s) => {
      if (s.path.endsWith('/files/list')) return new Response(JSON.stringify({ files: [{ name: 'a.txt', path: '/workspace/a.txt', type: 'file', size: 2 }] }));
      if (s.path.endsWith('/files') && s.method === 'GET') return new Response('hi');
      if (s.path.endsWith('/files') && s.method === 'PUT') return new Response(JSON.stringify({ file: { path: '/workspace/a.txt' } }));
      return undefined;
    });
    setDefaultCloud(f.cloud);
    const sb = await Sandbox.create();
    expect(await sb.files.read('a.txt')).toBe('hi');
    expect(await sb.files.write('a.txt', 'hi')).toMatchObject({ path: '/workspace/a.txt', type: 'file' });
    expect((await sb.files.list('.'))[0]).toMatchObject({ name: 'a.txt', type: 'file', size: 2 });
    expect(await sb.files.exists('a.txt')).toBe(true);
  });

  it('what kosa8 cannot do throws Unsupported', async () => {
    setDefaultCloud(fakeCloud(() => undefined).cloud);
    const sb = await Sandbox.create();
    expect(() => sb.pty).toThrow(Unsupported);
    await expect(sb.commands.run('x', { user: 'root' })).rejects.toBeInstanceOf(Unsupported);
    await expect(sb.files.watchDir()).rejects.toBeInstanceOf(Unsupported);
    await expect(Sandbox.create({ domain: 'e2b.app' })).rejects.toBeInstanceOf(Unsupported);
  });
});

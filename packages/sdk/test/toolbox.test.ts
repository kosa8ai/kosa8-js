import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  Kosa8Client,
  Kosa8NotFoundError,
  Kosa8PolicyError,
  Kosa8StreamError,
  MemoryCheckpointStore,
  tarContext,
} from '../src/index.js';
import { MockDaemon, frames, json, sandbox } from './mock-daemon.js';

const S = '/kosa8/v1/sandboxes/sb1';
let d: MockDaemon;
let client: Kosa8Client;
const tmps: string[] = [];

beforeEach(async () => {
  d = new MockDaemon();
  await d.start();
  client = new Kosa8Client({ socketPath: d.socketPath, env: {}, checkpointStore: new MemoryCheckpointStore() });
});
afterEach(async () => {
  await d.stop();
  for (const t of tmps.splice(0)) fs.rmSync(t, { recursive: true, force: true });
});

const last = () => d.requests[d.requests.length - 1]!;
const query = (r: { url: string }) => new URL(r.url, 'http://x').searchParams;

function ctxDir(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'k8ctx-'));
  tmps.push(dir);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

/** Names (and file contents) in a tar archive, PAX paths applied. */
function untar(buf: Buffer): Map<string, string> {
  const out = new Map<string, string>();
  let off = 0;
  let paxPath: string | undefined;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const cstr = (a: number, n: number) => h.subarray(a, a + n).toString('utf8').replace(/\0.*$/s, '');
    const size = parseInt(cstr(124, 12), 8);
    const type = cstr(156, 1);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i]!;
    expect(parseInt(cstr(148, 8), 8)).toBe(sum);
    const data = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') {
      const m = /\d+ path=(.*)\n/.exec(data.toString('utf8'));
      paxPath = m?.[1];
      continue;
    }
    out.set(paxPath ?? cstr(0, 100), data.toString('utf8'));
    paxPath = undefined;
  }
  return out;
}

describe('runCode', () => {
  it('sends the snippet and decodes artifacts to bytes', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    d.on('POST', S + '/code', (_r, res) =>
      json(res, 200, {
        language: 'python',
        image: 'python:3.12-slim',
        exit: 0,
        stdout: 'hi\n',
        stderr: '',
        artifacts: [{ type: 'image/png', name: 'figure-1.png', data: png.toString('base64') }],
        duration_ms: 12,
      }),
    );
    const r = await client.runCode('sb1', "print('hi')", { env: { A: '1' }, timeoutS: 10, approval: 'ap-1' });
    expect(r.ok).toBe(true);
    expect(r.stdout).toBe('hi\n');
    expect(r.durationMs).toBe(12);
    expect(r.artifacts[0]!.name).toBe('figure-1.png');
    expect(Buffer.compare(r.artifacts[0]!.data, png)).toBe(0);
    expect(JSON.parse(last().body)).toEqual({ language: 'python', code: "print('hi')", env: { A: '1' }, timeout_s: 10 });
    expect(last().headers['x-kosa8-approval']).toBe('ap-1');
  });

  it('a timed-out run is not ok, and a non-zero exit is a result', async () => {
    d.on('POST', S + '/code', (_r, res) => json(res, 200, { exit: 124, stdout: '', stderr: 'killed', timed_out: true }));
    const r = await client.runCode('sb1', 'while True: pass', { language: 'python' });
    expect(r.ok).toBe(false);
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBe(124);
    expect(r.artifacts).toEqual([]);
  });

  it('a refusal is typed and keeps the daemon words', async () => {
    d.on('POST', S + '/code', (_r, res) => json(res, 403, { error: 'egress denied', remediation: 'allow the host' }));
    const err = await client.runCode('sb1', 'x').catch((e) => e);
    expect(err).toBeInstanceOf(Kosa8PolicyError);
    expect(err.message).toBe('egress denied (allow the host)');
  });
});

describe('files', () => {
  it('lists, stats, reads, writes, deletes, makes folders and moves', async () => {
    d.on('GET', S + '/files', (_r, res) =>
      json(res, 200, { path: '/workspace', files: [{ name: 'a.txt', path: '/workspace/a.txt', type: 'file', size: 3 }] }),
    );
    d.on('GET', S + '/files/stat', (_r, res) => json(res, 200, { name: 'a.txt', path: '/workspace/a.txt', type: 'file', size: 5 }));
    d.on('GET', S + '/files/content', (_r, res) => {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': '5' });
      res.end('hello');
    });
    d.on('PUT', S + '/files/content', (r, res) => json(res, 200, { name: 'b.txt', path: '/workspace/b.txt', type: 'file', size: r.raw.length }));
    d.on('DELETE', S + '/files', (_r, res) => json(res, 200, { removed: '/workspace/d' }));
    d.on('POST', S + '/files/mkdir', (r, res) => json(res, 200, { path: JSON.parse(r.body).path, type: 'dir' }));
    d.on('POST', S + '/files/move', (r, res) => json(res, 200, { path: JSON.parse(r.body).to, type: 'file' }));

    expect((await client.listFiles('sb1'))[0]!.name).toBe('a.txt');
    expect(query(last()).get('path')).toBe('/workspace');
    expect((await client.statFile('sb1', 'a.txt')).size).toBe(5);
    expect(query(last()).get('path')).toBe('a.txt');
    expect(await client.readText('sb1', 'a.txt')).toBe('hello');
    expect((await client.readFile('sb1', 'a.txt')).length).toBe(5);

    const w = await client.writeFile('sb1', 'b.txt', 'héllo', { mode: '0644' });
    expect(w.size).toBe(6);
    expect(last().raw.toString('utf8')).toBe('héllo');
    expect(last().headers['content-type']).toBe('application/octet-stream');
    expect(query(last()).get('mode')).toBe('0644');

    const bin = Buffer.from([0, 255, 1, 254]);
    await client.writeFile('sb1', 'bin', bin);
    expect(Buffer.compare(last().raw, bin)).toBe(0);
    expect(query(last()).has('mode')).toBe(false);

    await client.deleteFile('sb1', 'd', { recursive: true });
    expect(query(last()).get('recursive')).toBe('1');
    await client.deleteFile('sb1', 'f');
    expect(query(last()).has('recursive')).toBe(false);

    expect((await client.makeDir('sb1', '/workspace/x/y')).type).toBe('dir');
    expect(JSON.parse(last().body)).toEqual({ path: '/workspace/x/y' });
    await client.moveFile('sb1', 'a', 'b');
    expect(JSON.parse(last().body)).toEqual({ from: 'a', to: 'b' });
  });

  it('a missing file is a typed error', async () => {
    d.on('GET', S + '/files/content', (_r, res) => json(res, 404, { error: 'no such file: nope', remediation: '' }));
    await expect(client.readFile('sb1', 'nope')).rejects.toBeInstanceOf(Kosa8NotFoundError);
  });

  it('a body cut short is a stream error', async () => {
    d.on('GET', S + '/files/content', (_r, res) => {
      res.writeHead(200, { 'Content-Length': '10' });
      res.write('abc');
      setTimeout(() => res.destroy(), 10);
    });
    await expect(client.readFile('sb1', 'x')).rejects.toBeInstanceOf(Kosa8StreamError);
  });

  it('streams an async iterable upload', async () => {
    d.on('PUT', S + '/files/content', (r, res) => json(res, 200, { size: r.raw.length }));
    async function* gen() {
      yield 'ab';
      yield Buffer.from('cd');
    }
    expect((await client.writeFile('sb1', 'big', gen())).size).toBe(4);
    expect(last().raw.toString()).toBe('abcd');
  });
});

describe('git', () => {
  it('maps fields onto the daemon names and parses status', async () => {
    d.on('POST', S + '/git', (r, res) => {
      const b = JSON.parse(r.body);
      json(res, 200, {
        op: b.op,
        path: '/workspace/repo',
        ok: true,
        exit: 0,
        stdout: '',
        stderr: '',
        ...(b.op === 'status' ? { status: { branch: 'main', ahead: 0, behind: 0, clean: true, files: [] } } : {}),
      });
    });
    const c = await client.gitClone('sb1', 'https://github.com/x/y', { path: 'repo', depth: 1, token: 't' });
    expect(c.ok).toBe(true);
    expect(JSON.parse(last().body)).toEqual({ op: 'clone', url: 'https://github.com/x/y', path: 'repo', depth: 1, token: 't' });
    const s = await client.gitStatus('sb1', 'repo');
    expect(s.status?.branch).toBe('main');
    expect(s.path).toBe('/workspace/repo');
    await client.git('sb1', 'log', { path: 'repo', n: 3, authorName: 'A', authorEmail: 'a@x' });
    expect(JSON.parse(last().body)).toEqual({ op: 'log', path: 'repo', n: 3, author_name: 'A', author_email: 'a@x' });
  });

  it('gitCommit stages first, then commits', async () => {
    d.on('POST', S + '/git', (r, res) => json(res, 200, { op: JSON.parse(r.body).op, ok: true, exit: 0, stdout: '', stderr: '' }));
    const r = await client.gitCommit('sb1', 'repo', 'msg');
    expect(r.ok).toBe(true);
    expect(d.requests.map((q) => JSON.parse(q.body).op)).toEqual(['add', 'commit']);
    expect(JSON.parse(last().body)).toEqual({ op: 'commit', path: 'repo', message: 'msg' });
  });

  it('gitCommit returns a failed add without committing; addAll: false skips it', async () => {
    d.on('POST', S + '/git', (r, res) => {
      const op = JSON.parse(r.body).op;
      json(res, 200, { op, ok: op !== 'add', exit: op === 'add' ? 128 : 0, stdout: '', stderr: op === 'add' ? 'not a repo' : '' });
    });
    const r = await client.gitCommit('sb1', 'repo', 'msg');
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(128);
    expect(d.requests.length).toBe(1);
    await client.gitCommit('sb1', 'repo', 'msg', { addAll: false });
    expect(JSON.parse(last().body).op).toBe('commit');
    expect(d.requests.length).toBe(2);
  });
});

describe('sessions', () => {
  it('create, list, exec, delete', async () => {
    d.on('POST', S + '/sessions', (r, res) => json(res, 200, { name: JSON.parse(r.body).name, id: 'session-dev', image: 'alpine', status: 'running' }));
    d.on('GET', S + '/sessions', (_r, res) => json(res, 200, [{ name: 'dev', id: 'session-dev', image: 'alpine', status: 'running' }]));
    d.on('POST', S + '/sessions/dev/exec', (_r, res) => json(res, 200, { exit: 0, stdout: 'x\n', stderr: '', cwd: '/tmp', duration_ms: 3 }));
    d.on('DELETE', S + '/sessions/dev', (_r, res) => json(res, 200, { deleted: 'dev' }));
    expect((await client.createSession('sb1', 'dev', { image: 'alpine', env: { A: '1' } })).id).toBe('session-dev');
    expect(JSON.parse(last().body)).toEqual({ name: 'dev', image: 'alpine', env: { A: '1' } });
    expect((await client.listSessions('sb1')).map((s) => s.name)).toEqual(['dev']);
    const r = await client.sessionExec('sb1', 'dev', 'cd /tmp; echo x', { timeoutS: 5 });
    expect(r).toMatchObject({ ok: true, exitCode: 0, stdout: 'x\n', cwd: '/tmp', durationMs: 3 });
    expect(JSON.parse(last().body)).toEqual({ command: 'cd /tmp; echo x', timeout_s: 5 });
    expect(await client.deleteSession('sb1', 'dev')).toEqual({ deleted: 'dev' });
  });

  it('shell makes the session on first use', async () => {
    const made: unknown[] = [];
    d.on('POST', S + '/sessions/main/exec', (_r, res) =>
      made.length === 0
        ? json(res, 404, { error: 'no such session: main', remediation: 'create it with POST …/sessions' })
        : json(res, 200, { exit: 0, stdout: '/tmp\n', stderr: '', cwd: '/tmp' }),
    );
    d.on('POST', S + '/sessions', (r, res) => {
      made.push(JSON.parse(r.body));
      json(res, 200, { name: 'main', id: 'session-main', status: 'running' });
    });
    const r = await client.shell('sb1', 'cd /tmp && pwd');
    expect(r.cwd).toBe('/tmp');
    expect(made).toEqual([{ name: 'main' }]);
    expect(d.requests.map((q) => q.url)).toEqual([S + '/sessions/main/exec', S + '/sessions', S + '/sessions/main/exec']);
  });

  it('shell does not hide any other 404', async () => {
    d.on('POST', S + '/sessions/main/exec', (_r, res) => json(res, 404, { error: 'no such sandbox: sb1' }));
    await expect(client.shell('sb1', 'ls')).rejects.toBeInstanceOf(Kosa8NotFoundError);
    expect(d.requests.length).toBe(1);
  });

  it('shell uses the named session', async () => {
    d.on('POST', S + '/sessions/w/exec', (_r, res) => json(res, 200, { exit: 2, stdout: '', stderr: 'no' }));
    const r = await client.shell('sb1', 'false', { session: 'w' });
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(2);
  });
});

describe('terminals, previews, lifecycle', () => {
  it('startPty and resizePty', async () => {
    d.on('POST', S + '/pty', (_r, res) => json(res, 200, { id: 'pty-1', image: 'alpine', resized: true }));
    d.on('POST', S + '/containers/pty-1/resize', (_r, res) => json(res, 200, { ok: true }));
    expect(await client.startPty('sb1', { cols: 120, rows: 40, command: ['sh'] })).toBe('pty-1');
    expect(JSON.parse(last().body)).toEqual({ command: ['sh'], cols: 120, rows: 40 });
    expect(await client.resizePty('sb1', 'pty-1', 80, 24)).toEqual({ ok: true });
    expect(JSON.parse(last().body)).toEqual({ cols: 80, rows: 24 });
  });

  it('createPreview and revokePreviews', async () => {
    d.on('POST', S + '/previews', (_r, res) =>
      json(res, 200, { url: 'http://h/?t=1', token: '1', expires_at: 'z', container: 'session-main', port: 8000, listen: '127.0.0.1:1' }),
    );
    d.on('POST', '/kosa8/v1/previews/rotate', (_r, res) => json(res, 200, { ok: true, revoked: 'every preview link' }));
    const p = await client.createPreview('sb1', 8000, { session: 'main', expiresInS: 60 });
    expect(p.port).toBe(8000);
    expect(JSON.parse(last().body)).toEqual({ port: 8000, session: 'main', expires_in_s: 60 });
    expect((await client.revokePreviews()).ok).toBe(true);
  });

  it('setLifecycle sends only the given fields, 0 included', async () => {
    d.on('POST', S + '/lifecycle', (_r, res) => json(res, 200, sandbox('sb1', { lifecycle: { ttl_min: 60 } })));
    const s = await client.setLifecycle('sb1', { autoStopMin: 0, ttlMin: 60 });
    expect(s.lifecycle?.ttl_min).toBe(60);
    expect(JSON.parse(last().body)).toEqual({ auto_stop_min: 0, ttl_min: 60 });
  });

  it('createSandbox carries lifecycle and template fields', async () => {
    d.on('POST', '/kosa8/v1/sandboxes', (_r, res) => json(res, 201, { sandbox: sandbox('x'), boot_ms: 1 }));
    await client.createSandbox({ name: 'x', autoStopMin: 15, ttlMin: 60, ephemeral: true, template: 'py' });
    expect(JSON.parse(last().body)).toEqual({ name: 'x', auto_stop_min: 15, ttl_min: 60, ephemeral: true, template: 'py' });
    await client.createSandbox({ name: 'y', autoDeleteMin: 5 });
    expect(JSON.parse(last().body)).toEqual({ name: 'y', auto_delete_min: 5 });
  });

  it('the sandbox handle binds the toolbox', async () => {
    d.on('POST', S + '/code', (_r, res) => json(res, 200, { exit: 0, stdout: '2\n', stderr: '' }));
    d.on('GET', S + '/files', (_r, res) => json(res, 200, { files: [] }));
    const sb = client.sandbox('sb1');
    expect((await sb.runCode('print(1+1)')).stdout).toBe('2\n');
    expect(await sb.listFiles()).toEqual([]);
  });
});

describe('templates', () => {
  it('lists and deletes', async () => {
    d.on('GET', '/kosa8/v1/templates', (_r, res) => json(res, 200, [{ name: 'py', image: 'kosa8-template/py:latest', size_bytes: 9, created: 'z' }]));
    d.on('DELETE', '/kosa8/v1/templates/py', (_r, res) => json(res, 200, { deleted: 'py' }));
    expect((await client.listTemplates())[0]!.name).toBe('py');
    expect(await client.deleteTemplate('py')).toEqual({ deleted: 'py' });
  });

  it('build streams output, sends the query and honours .dockerignore', async () => {
    const dir = ctxDir({
      Dockerfile: 'FROM alpine\n',
      '.dockerignore': '# comment\nsecret/\n\nnode_modules\n',
      'secret/k': 'x',
      'node_modules/a/b.js': 'x',
      'app.py': 'print(1)',
      'src/lib/m.py': 'm',
      [`deep/${'d'.repeat(120)}/f.txt`]: 'long',
    });
    d.on('POST', '/kosa8/v1/templates', (_r, res) =>
      frames(res, [
        { stream: 'status', data: 'step 1\n' },
        { stream: 'stdout', data: 'ok\n' },
        { done: true, ok: true, image: 'kosa8-template/py:latest' },
      ]),
    );
    const seen: string[] = [];
    const out = await client.buildTemplate('py', dir, {
      buildArgs: { V: '1', W: 'a b' },
      egress: { allow: ['pypi.org'] },
      replace: true,
      onOutput: (c, s) => seen.push(`${s}:${c.toString()}`),
    });
    expect(out.image).toBe('kosa8-template/py:latest');
    expect(seen).toEqual(['status:step 1\n', 'stdout:ok\n']);
    const q = query(last());
    expect(q.get('name')).toBe('py');
    expect(q.get('dockerfile')).toBe('Dockerfile');
    expect(q.getAll('buildarg')).toEqual(['V=1', 'W=a b']);
    expect(q.get('egress')).toBe('allow:pypi.org');
    expect(q.get('replace')).toBe('1');
    expect(last().headers['content-type']).toBe('application/octet-stream');
    const names = untar(last().raw);
    expect(names.get('app.py')).toBe('print(1)');
    expect(names.get('src/lib/m.py')).toBe('m');
    expect(names.has('src/')).toBe(true);
    expect(names.get(`deep/${'d'.repeat(120)}/f.txt`)).toBe('long');
    expect([...names.keys()].filter((n) => n.startsWith('secret') || n.startsWith('node_modules'))).toEqual([]);
  });

  it('a done frame with an error throws', async () => {
    const dir = ctxDir({ Dockerfile: 'FROM alpine\n' });
    d.on('POST', '/kosa8/v1/templates', (_r, res) => frames(res, [{ stream: 'stdout', data: 'x' }, { done: true, error: 'RUN failed' }]));
    const err = await client.buildTemplate('py', dir).catch((e) => e);
    expect(err).toBeInstanceOf(Kosa8StreamError);
    expect(err.message).toBe('RUN failed');
    expect(err.stdout).toBe('x');
    expect(query(last()).has('replace')).toBe(false);
  });

  it('a missing Dockerfile fails before anything is sent', async () => {
    const dir = ctxDir({ 'a.txt': 'x' });
    await expect(client.buildTemplate('py', dir)).rejects.toThrow(/no Dockerfile/);
    expect(d.requests.length).toBe(0);
    await expect(tarContext(dir, 'Other')).rejects.toThrow(/no Other/);
  });
});

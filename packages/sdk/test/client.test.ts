import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FileCheckpointStore,
  Kosa8ApprovalRequiredError,
  Kosa8BadRequestError,
  Kosa8Client,
  Kosa8ConflictError,
  Kosa8ConnectionError,
  Kosa8Error,
  Kosa8NotFoundError,
  Kosa8PolicyError,
  Kosa8StreamError,
  MemoryCheckpointStore,
  resolveEndpoint,
  Transport,
} from '../src/index.js';
import { MockDaemon, frames, json, sandbox } from './mock-daemon.js';

let d: MockDaemon;
let client: Kosa8Client;

beforeEach(async () => {
  d = new MockDaemon();
  await d.start();
  client = new Kosa8Client({ socketPath: d.socketPath, env: {}, checkpointStore: new MemoryCheckpointStore() });
});
afterEach(async () => {
  await d.stop();
});

describe('status', () => {
  it('reads health over the unix socket and tags the actor', async () => {
    d.on('GET', '/kosa8/v1/health', (_r, res) =>
      json(res, 200, { status: 'ok', version: '0.9.10', commit: 'abc', go: 'go1.25', uptime_seconds: 3, phase: '0-foundations' }),
    );
    expect(await client.version()).toBe('0.9.10');
    expect(d.requests[0]!.headers['x-kosa8-actor']).toBe('tool');
    expect(d.requests[0]!.headers['x-kosa8-approval']).toBeUndefined();
  });

  it('reports an unreachable daemon as a connection error', async () => {
    const c = new Kosa8Client({ socketPath: path.join(os.tmpdir(), 'nope-k8.sock'), env: {} });
    const err = await c.health().catch((e) => e);
    expect(err).toBeInstanceOf(Kosa8ConnectionError);
    expect(err.message).toMatch(/daemon running|wsl setup/);
  });
});

describe('sandboxes', () => {
  it('maps create options onto the daemon fields', async () => {
    d.on('POST', '/kosa8/v1/sandboxes', (r, res) =>
      json(res, 201, { sandbox: sandbox(JSON.parse(r.body).name, { egress: JSON.parse(r.body).egress }), boot_ms: 412 }),
    );
    const out = await client.createSandbox({
      name: 'demo',
      cpus: 2,
      memMb: 2048,
      diskGb: 8,
      egressAllow: ['api.anthropic.com', '*.npmjs.org'],
      approval: 'req-1',
    });
    expect(out.sandbox.name).toBe('demo');
    expect(out.boot_ms).toBe(412);
    const req = d.find('POST', '/kosa8/v1/sandboxes')[0]!;
    expect(JSON.parse(req.body)).toEqual({
      name: 'demo',
      cpus: 2,
      mem_mb: 2048,
      disk_gb: 8,
      egress: 'allow:api.anthropic.com,*.npmjs.org',
    });
    expect(req.headers['x-kosa8-approval']).toBe('req-1');
  });

  it('accepts the daemon egress strings and { allow }', async () => {
    d.on('POST', '/kosa8/v1/sandboxes', (_r, res) => json(res, 201, { sandbox: sandbox('x'), boot_ms: 1 }));
    await client.createSandbox({ egress: 'deny' });
    await client.createSandbox({ egress: { allow: ['10.0.0.0/8'] } });
    await client.createSandbox({});
    const bodies = d.find('POST', '/kosa8/v1/sandboxes').map((r) => JSON.parse(r.body));
    expect(bodies[0].egress).toBe('deny');
    expect(bodies[1].egress).toBe('allow:10.0.0.0/8');
    expect(bodies[2].egress).toBeUndefined();
    await expect(client.createSandbox({ egress: { allow: [] } })).rejects.toBeInstanceOf(Kosa8Error);
    await expect(client.createSandbox({ egress: 'any', egressAllow: ['a.com'] })).rejects.toThrow(/egressAllow/);
  });

  it('lists, finds, starts, stops and deletes', async () => {
    d.on('GET', '/kosa8/v1/sandboxes', (_r, res) => json(res, 200, [sandbox('a'), sandbox('b')]));
    d.on('POST', '/kosa8/v1/sandboxes/{id}/up', (_r, res) => json(res, 200, { sandbox: sandbox('a'), boot_ms: 9 }));
    d.on('POST', '/kosa8/v1/sandboxes/{id}/down', (_r, res) => json(res, 200, { ok: true, already_stopped: true }));
    d.on('DELETE', '/kosa8/v1/sandboxes/{id}', (_r, res) => json(res, 200, { ok: true }));
    expect((await client.listSandboxes()).map((s) => s.name)).toEqual(['a', 'b']);
    expect((await client.getSandbox('b'))?.id).toBe('b');
    expect(await client.getSandbox('zzz')).toBeUndefined();
    expect((await client.startSandbox('a')).boot_ms).toBe(9);
    expect((await client.stopSandbox('a')).already_stopped).toBe(true);
    const del = await client.deleteSandbox('a', { wipe: true });
    expect(del.ok).toBe(true);
    expect(d.find('DELETE', '/kosa8/v1/sandboxes/a')[0]!.url).toBe('/kosa8/v1/sandboxes/a?wipe=1');
  });

  it('pulls into a sandbox and into the host engine', async () => {
    d.on('POST', '/kosa8/v1/sandboxes/{id}/pull', (r, res) => json(res, 200, { ok: true, image: JSON.parse(r.body).ref }));
    d.on('POST', '/kosa8/v1/pull', (r, res) => json(res, 200, { ok: true, image: JSON.parse(r.body).ref }));
    expect((await client.pullIntoSandbox('a', 'alpine:latest')).image).toBe('alpine:latest');
    expect((await client.pull('busybox')).image).toBe('busybox');
  });
});

describe('errors carry the daemon message', () => {
  it('turns a signed-approval refusal into Kosa8ApprovalRequiredError', async () => {
    const refusal = {
      route: 'POST /kosa8/v1/sandboxes/{id}/fork',
      action: { kind: 'fork', target: 'web' },
      description: 'fork web',
      class: 'contained',
      policy: 'acme',
      policy_digest: 'sha256:x',
      requirement: { policy: 'acme', rules: [] },
      why: 'no approval was presented',
      signers: ['alice'],
      request_command: 'kosa8 approve request fork web',
    };
    d.on('POST', '/kosa8/v1/sandboxes/{id}/fork', (_r, res) =>
      json(res, 403, { error: '1 signed approval(s) for fork: `fork web` needs signed approval', remediation: 'ask alice', message: 'x', approval: refusal }),
    );
    const err = await client.fork('web', { n: 2 }).catch((e) => e);
    expect(err).toBeInstanceOf(Kosa8ApprovalRequiredError);
    expect(err).toBeInstanceOf(Kosa8PolicyError);
    expect(err.approval.why).toBe('no approval was presented');
    expect(err.approval.signers).toEqual(['alice']);
    expect(err.message).toBe('1 signed approval(s) for fork: `fork web` needs signed approval (ask alice)');
    expect(err.status).toBe(403);
  });

  it('maps statuses to typed errors', async () => {
    d.on('POST', '/kosa8/v1/sandboxes/{id}/up', (_r, res) =>
      json(res, 403, { error: 'egress any is above the label cap', remediation: 'see `kosa8 label ls`' }),
    );
    d.on('POST', '/kosa8/v1/sandboxes/{id}/exec', (_r, res) =>
      json(res, 409, { error: 'sandbox is not running', remediation: 'start it with `kosa8 sandbox up web`' }),
    );
    d.on('DELETE', '/kosa8/v1/snapshots/{id}', (_r, res) => json(res, 404, { error: 'no such snapshot: s1', remediation: '' }));
    d.on('POST', '/kosa8/v1/sandboxes', (_r, res) =>
      json(res, 400, { error: 'egress policy "nope": want any, deny, fakenet, or allow:HOST[,HOST...]', remediation: '' }),
    );
    const policy = await client.startSandbox('web').catch((e) => e);
    expect(policy).toBeInstanceOf(Kosa8PolicyError);
    expect(policy).not.toBeInstanceOf(Kosa8ApprovalRequiredError);
    expect(policy.remediation).toBe('see `kosa8 label ls`');
    const conflict = await client.exec('web', 'c1', ['true']).catch((e) => e);
    expect(conflict).toBeInstanceOf(Kosa8ConflictError);
    expect(conflict.daemonMessage).toBe('sandbox is not running');
    expect(await client.deleteSnapshot('s1').catch((e) => e)).toBeInstanceOf(Kosa8NotFoundError);
    const bad = await client.createSandbox({ egress: 'allow:x' }).catch((e) => e);
    expect(bad).toBeInstanceOf(Kosa8BadRequestError);
    expect(bad.message).toMatch(/want any, deny, fakenet/);
  });
});

describe('run and exec', () => {
  it('collects stdout, stderr and the exit code from frames', async () => {
    d.on('POST', '/kosa8/v1/sandboxes/{id}/exec', (_r, res) =>
      frames(res, [
        { stream: 'stdout', data: 'hel' },
        { stream: 'stderr', data: 'warn\n' },
        { stream: 'stdout', data: 'lo\n' },
        { done: true, ok: true, exit: 3 },
      ]),
    );
    const seen: string[] = [];
    const out = await client.exec('web', 'c1', ['sh', '-c', 'x'], { onStdout: (c) => seen.push(c.toString()) });
    expect(out).toMatchObject({ exitCode: 3, stdout: 'hello\n', stderr: 'warn\n' });
    expect(seen).toEqual(['hel', 'lo\n']);
    expect(JSON.parse(d.requests[0]!.body)).toEqual({ container: 'c1', args: ['sh', '-c', 'x'] });
  });

  it('treats a missing exit as 0 and keeps binary output intact', async () => {
    const bin = Buffer.from([0, 255, 10, 13, 128]);
    d.on('POST', '/kosa8/v1/sandboxes/{id}/run', (_r, res) =>
      frames(res, [{ stream: 'status', data: 'pulling\n' }, { stream: 'stdout', data: bin }, { done: true, ok: true }]),
    );
    const out = await client.run('web', 'alpine', ['cat', '/x'], { env: { A: '1' } });
    expect(out.exitCode).toBe(0);
    expect(Buffer.compare(out.stdoutBytes, bin)).toBe(0);
    expect(JSON.parse(d.requests[0]!.body)).toEqual({ image: 'alpine', args: ['cat', '/x'], env: ['A=1'] });
  });

  it('throws Kosa8StreamError on an error frame, keeping partial output', async () => {
    d.on('POST', '/kosa8/v1/sandboxes/{id}/run', (_r, res) =>
      frames(res, [{ stream: 'stdout', data: 'partial' }, { done: true, error: 'image not found: nope' }]),
    );
    const err = await client.run('web', 'nope').catch((e) => e);
    expect(err).toBeInstanceOf(Kosa8StreamError);
    expect(err.message).toBe('image not found: nope');
    expect(err.stdout).toBe('partial');
  });

  it('starts detached and interactive containers, and streams stdin', async () => {
    d.on('POST', '/kosa8/v1/sandboxes/{id}/start', (_r, res) => json(res, 200, { ok: true, id: 'c-9' }));
    d.on('POST', '/kosa8/v1/sandboxes/{id}/start-interactive', (_r, res) => json(res, 200, { ok: true, id: 'c-10' }));
    d.on('POST', '/kosa8/v1/sandboxes/{id}/containers/{cid}/stdin', (_r, res) => json(res, 200, { ok: true }));
    expect(await client.startContainer('web', 'alpine', ['sleep', '9'])).toBe('c-9');
    expect(await client.startInteractive('web', 'alpine', ['cat'], { tty: false })).toBe('c-10');
    async function* chunks() {
      yield 'a';
      yield Buffer.from('b');
    }
    await client.writeStdin('web', 'c-10', chunks());
    const stdin = d.find('POST', '/kosa8/v1/sandboxes/web/containers/c-10/stdin')[0]!;
    expect(stdin.body).toBe('ab');
    expect(stdin.headers['content-type']).toBe('application/octet-stream');
  });
});

describe('snapshots, fork, checkpoints, explore', () => {
  function withSnapshots() {
    const snaps = new Map<string, { id: string; sandbox: string }>();
    let restores = 0;
    d.on('POST', '/kosa8/v1/sandboxes/{id}/snapshot', (r, res) => {
      const name = r.url.split('/')[4]!;
      const id = JSON.parse(r.body || '{}').id ?? `${name}-snap`;
      snaps.set(id, { id, sandbox: name });
      json(res, 200, { snapshot: { id, sandbox: name, created: new Date().toISOString() }, snapshot_ms: 700 });
    });
    d.on('GET', '/kosa8/v1/snapshots', (_r, res) => json(res, 200, [...snaps.values()]));
    d.on('DELETE', '/kosa8/v1/snapshots/{id}', (r, res) => {
      const id = decodeURIComponent(r.url.split('/')[4]!.split('?')[0]!);
      snaps.delete(id);
      json(res, 200, { ok: true, removed: id, encrypted: false });
    });
    d.on('DELETE', '/kosa8/v1/sandboxes/{id}', (_r, res) => json(res, 200, { ok: true }));
    d.on('POST', '/kosa8/v1/snapshots/{id}/restore', (r, res) => {
      restores++;
      json(res, 200, { sandbox: sandbox(JSON.parse(r.body).name), restore_ms: 500 });
    });
    return { snaps, restores: () => restores };
  }

  it('checkpoints with <sandbox>-ckpt-<n> ids and rewinds by delete + restore under the same name', async () => {
    const { snaps } = withSnapshots();
    const a = await client.checkpoint('web', { label: 'before migration' });
    const b = await client.checkpoint('web');
    const c = await client.checkpoint('web', { label: 'after' });
    expect([a.checkpoint.id, b.checkpoint.id, c.checkpoint.id]).toEqual(['web-ckpt-1', 'web-ckpt-2', 'web-ckpt-3']);
    expect(JSON.parse(d.find('POST', '/kosa8/v1/sandboxes/web/snapshot')[0]!.body)).toEqual({ id: 'web-ckpt-1' });
    expect((await client.listCheckpoints('web')).map((x) => x.label)).toEqual(['before migration', '', 'after']);

    const rw = await client.rewind('web', { to: 'BEFORE MIGRATION' });
    expect(rw.checkpoint.id).toBe('web-ckpt-1');
    expect(rw.dropped).toEqual(['web-ckpt-2', 'web-ckpt-3']);
    expect(rw.sandbox.name).toBe('web');
    const order = d.requests.map((r) => `${r.method} ${r.url}`).slice(-4);
    expect(order).toEqual([
      'DELETE /kosa8/v1/sandboxes/web',
      'POST /kosa8/v1/snapshots/web-ckpt-1/restore',
      'DELETE /kosa8/v1/snapshots/web-ckpt-2',
      'DELETE /kosa8/v1/snapshots/web-ckpt-3',
    ]);
    expect(JSON.parse(d.find('POST', '/kosa8/v1/snapshots/web-ckpt-1/restore')[0]!.body)).toEqual({ name: 'web' });
    expect([...snaps.keys()]).toEqual(['web-ckpt-1']);
    expect((await client.listCheckpoints('web')).map((x) => x.id)).toEqual(['web-ckpt-1']);
  });

  it('rewinds to the latest by default and explains when there is none', async () => {
    withSnapshots();
    await expect(client.rewind('web')).rejects.toThrow(/no checkpoints for "web"/);
    await client.checkpoint('web');
    await client.checkpoint('web');
    expect((await client.rewind('web')).checkpoint.id).toBe('web-ckpt-2');
  });

  it('evicts the oldest checkpoint past 10, after the new one exists', async () => {
    const { snaps } = withSnapshots();
    for (let i = 0; i < 11; i++) await client.checkpoint('web');
    const list = await client.listCheckpoints('web');
    expect(list).toHaveLength(10);
    expect(list[0]!.id).toBe('web-ckpt-2');
    expect(list[9]!.id).toBe('web-ckpt-11');
    expect(snaps.has('web-ckpt-1')).toBe(false);
  });

  it('forks with n and prefix', async () => {
    d.on('POST', '/kosa8/v1/sandboxes/{id}/fork', (r, res) => {
      const { n, prefix } = JSON.parse(r.body);
      json(res, 200, {
        forks: Array.from({ length: n }, (_, i) => sandbox(`${prefix}${i + 1}`, { parent: 'web' })),
        snapshot: 'eph-1',
        fork_ms: 300,
        count: n,
      });
    });
    const out = await client.fork('web', { n: 2, prefix: 'try-' });
    expect(out.forks.map((f) => f.name)).toEqual(['try-1', 'try-2']);
    expect(JSON.parse(d.requests[0]!.body)).toEqual({ n: 2, prefix: 'try-' });
    await client.fork('web');
    expect(JSON.parse(d.requests[1]!.body)).toEqual({ n: 1 });
  });

  it('explores: pull, fork per variant, run each, keep the fastest success, delete the rest', async () => {
    d.on('POST', '/kosa8/v1/sandboxes/{id}/pull', (_r, res) => json(res, 200, { ok: true, image: 'alpine:latest' }));
    d.on('POST', '/kosa8/v1/sandboxes/{id}/fork', (r, res) => {
      const { n, prefix } = JSON.parse(r.body);
      json(res, 200, { forks: Array.from({ length: n }, (_, i) => sandbox(`${prefix}${i + 1}`)), snapshot: 'e', fork_ms: 1, count: n });
    });
    d.on('POST', '/kosa8/v1/sandboxes/{id}/run', async (r, res) => {
      const name = r.url.split('/')[4]!;
      const variant = JSON.parse(r.body).args[2];
      if (variant === 'false') return frames(res, [{ done: true, ok: true, exit: 1 }]);
      if (variant === 'slow') await new Promise((x) => setTimeout(x, 60));
      frames(res, [{ stream: 'stdout', data: `${name}\n` }, { done: true, ok: true }]);
    });
    d.on('DELETE', '/kosa8/v1/sandboxes/{id}', (_r, res) => json(res, 200, { ok: true }));
    const out = await client.explore('web', { variants: ['slow', 'fast', 'false'], prefix: 'ex-' });
    expect(out.winner).toBe('ex-2');
    expect(out.removed).toBe(2);
    expect(out.branches.map((b) => [b.name, b.exit])).toEqual([
      ['ex-1', 0],
      ['ex-2', 0],
      ['ex-3', 1],
    ]);
    expect(out.branches[1]!.output).toBe('ex-2');
    expect(JSON.parse(d.find('POST', '/kosa8/v1/sandboxes/ex-1/run')[0]!.body)).toEqual({
      image: 'alpine:latest',
      args: ['sh', '-c', 'slow'],
    });
    expect(d.find('DELETE', '/kosa8/v1/sandboxes/').map((r) => r.url).sort()).toEqual([
      '/kosa8/v1/sandboxes/ex-1',
      '/kosa8/v1/sandboxes/ex-3',
    ]);
    await expect(client.explore('web', { variants: ['one'] })).rejects.toThrow(/at least two/);
  });

  it('restores and deletes snapshots with their options', async () => {
    withSnapshots();
    await client.restoreSnapshot('s1', { name: 'copy', allowTampered: true, label: 'secret' });
    expect(JSON.parse(d.requests[0]!.body)).toEqual({ name: 'copy', label: 'secret', allow_tampered: true });
    await client.deleteSnapshot('s1', { wipe: true, force: true });
    expect(d.requests[1]!.url).toBe('/kosa8/v1/snapshots/s1?wipe=1&force=1');
  });
});

describe('file checkpoint store', () => {
  it('reads and writes the same format as pkg/checkpoint', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'k8c-'));
    const file = path.join(dir, 'checkpoints.json');
    // As written by the Go tools.
    fs.writeFileSync(
      file,
      JSON.stringify({ web: [{ id: 'web-ckpt-4', sandbox: 'web', label: 'go', created: '2026-10-01T10:00:00.123456789Z' }] }),
    );
    const c = new Kosa8Client({ socketPath: d.socketPath, env: {}, checkpointStore: new FileCheckpointStore(file) });
    d.on('POST', '/kosa8/v1/sandboxes/{id}/snapshot', (r, res) =>
      json(res, 200, { snapshot: { id: JSON.parse(r.body).id, sandbox: 'web' }, snapshot_ms: 1 }),
    );
    const r = await c.checkpoint('web', { label: 'sdk' });
    expect(r.checkpoint.id).toBe('web-ckpt-5');
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(onDisk.web.map((x: { id: string; label: string }) => [x.id, x.label])).toEqual([
      ['web-ckpt-4', 'go'],
      ['web-ckpt-5', 'sdk'],
    ]);
    if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o600); // POSIX modes
    await expect(c.checkpoint('../etc')).rejects.toThrow(/invalid sandbox name/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('endpoint resolution (KOSA8_HOST rules of the CLI)', () => {
  it('defaults to the socket under $HOME/.kosa8', () => {
    const e = resolveEndpoint({ env: {}, workerFile: null });
    expect(e).toEqual({ kind: 'unix', socketPath: path.join(os.homedir(), '.kosa8', 'run', 'kosa8.sock') });
  });
  it('accepts tcp://, bare host:port and https://, sending KOSA8_TOKEN', () => {
    expect(resolveEndpoint({ env: { KOSA8_HOST: 'tcp://127.0.0.1:7777', KOSA8_TOKEN: 't' } })).toMatchObject({
      kind: 'tcp',
      token: 't',
    });
    const bare = resolveEndpoint({ env: { KOSA8_HOST: 'localhost:7777' } });
    expect(bare.kind === 'tcp' && bare.url.href).toBe('http://localhost:7777/');
    const tls = resolveEndpoint({ env: { KOSA8_HOST: 'HTTPS://worker.example.com' } });
    expect(tls.kind === 'tcp' && tls.url.protocol).toBe('https:');
  });
  it('refuses plain http to a non-loopback host unless insecure', () => {
    expect(() => resolveEndpoint({ env: { KOSA8_HOST: 'http://10.1.2.3:7777' } })).toThrow(/plain http/);
    expect(resolveEndpoint({ env: { KOSA8_HOST: 'http://10.1.2.3:7777', KOSA8_INSECURE: '1' } }).kind).toBe('tcp');
  });
  it('takes unix:// as a socket and rejects unknown schemes', () => {
    expect(resolveEndpoint({ env: { KOSA8_HOST: 'unix:///tmp/x.sock' } })).toEqual({ kind: 'unix', socketPath: '/tmp/x.sock' });
    expect(() => resolveEndpoint({ env: { KOSA8_HOST: 'ftp://x' } })).toThrow(/not supported/);
  });

  describe('the saved worker connection (kosa8 wsl setup / kosa8 worker join)', () => {
    let dir: string;
    let file: string;
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'k8w-'));
      file = path.join(dir, 'worker.json');
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
    const save = (w: unknown) => fs.writeFileSync(file, typeof w === 'string' ? w : JSON.stringify(w));

    it('is used when KOSA8_HOST is not set, with its token', () => {
      save({ host: 'http://127.0.0.1:7428', token: 'saved', via: 'wsl', distro: 'Ubuntu' });
      const e = resolveEndpoint({ env: {}, workerFile: file });
      expect(e.kind === 'tcp' && e.url.href).toBe('http://127.0.0.1:7428/');
      expect(e).toMatchObject({ token: 'saved' });
      expect(new Transport({ env: {}, workerFile: file }).target).toBe('http://127.0.0.1:7428');
    });
    it('loses to KOSA8_HOST, and its token never goes there', () => {
      save({ host: 'http://127.0.0.1:7428', token: 'saved' });
      const e = resolveEndpoint({ env: { KOSA8_HOST: 'https://w.example.com' }, workerFile: file });
      expect(e.kind === 'tcp' && e.url.host).toBe('w.example.com');
      expect(e).toMatchObject({ token: undefined });
    });
    it('is skipped for an explicit socket, a malformed file or a blank host', () => {
      save({ host: 'http://127.0.0.1:7428' });
      expect(resolveEndpoint({ env: {}, workerFile: file, socketPath: '/s.sock' })).toEqual({ kind: 'unix', socketPath: '/s.sock' });
      save('{not json');
      expect(resolveEndpoint({ env: {}, workerFile: file }).kind).toBe('unix');
      save({ host: '  ', token: 't' });
      expect(resolveEndpoint({ env: {}, workerFile: file }).kind).toBe('unix');
      expect(resolveEndpoint({ env: {}, workerFile: path.join(dir, 'missing.json') }).kind).toBe('unix');
    });
    it('allows plain http to a LAN worker only when it was paired with --insecure', () => {
      save({ host: '10.1.2.3:7428', token: 't' });
      expect(() => resolveEndpoint({ env: {}, workerFile: file })).toThrow(/plain http/);
      save({ host: '10.1.2.3:7428', token: 't', insecure: true });
      expect(resolveEndpoint({ env: {}, workerFile: file }).kind).toBe('tcp');
    });
    it('takes an explicit token over the saved one', () => {
      save({ host: 'https://w.example.com', token: 'saved' });
      expect(resolveEndpoint({ env: {}, workerFile: file, token: 'mine' })).toMatchObject({ token: 'mine' });
    });
  });
});

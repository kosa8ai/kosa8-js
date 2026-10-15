import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FileCheckpointStore, Kosa8Client, Kosa8ConflictError, Kosa8NotFoundError } from '@kosa8/sdk';

const expectVersion = process.env.KOSA8_EXPECT_VERSION ?? '0.9.10';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'k8it-'));
const kosa8 = new Kosa8Client({ checkpointStore: new FileCheckpointStore(path.join(tmp, 'checkpoints.json')) });
const name = `sdkit-${Date.now().toString(36)}`;
const made = new Set<string>([name]);
let container = '';

async function sh(cmd: string, sandbox = name, cid = container) {
  return kosa8.exec(sandbox, cid, ['sh', '-c', cmd]);
}

afterAll(async () => {
  for (const s of await kosa8.listSandboxes().catch(() => [])) {
    if (made.has(s.id) || s.id.startsWith(`${name}-`)) await kosa8.deleteSandbox(s.id).catch(() => undefined);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('@kosa8/sdk against a real daemon', () => {
  beforeAll(async () => {
    const h = await kosa8.health();
    expect(h.status).toBe('ok');
    expect(h.version.replace(/^v/, '')).toBe(expectVersion);
  });

  it('creates a sandbox with egress deny', async () => {
    const out = await kosa8.createSandbox({ name, egress: 'deny' });
    expect(out.sandbox.name).toBe(name);
    expect(out.sandbox.state).toBe('running');
    expect(out.sandbox.egress).toBe('deny');
    const listed = await kosa8.getSandbox(name);
    expect(listed?.id).toBe(name);
    const eg = await kosa8.sandboxEgress(name);
    expect(eg.policy).toMatch(/deny/);
  });

  it('pulls, runs and execs (stdout, stderr, exit code)', async () => {
    const pulled = await kosa8.pullIntoSandbox(name, 'alpine:latest');
    expect(pulled.ok).toBe(true);
    const run = await kosa8.run(name, 'alpine:latest', ['sh', '-c', 'echo out; echo err >&2; exit 3']);
    expect(run).toMatchObject({ exitCode: 3, stdout: 'out\n', stderr: 'err\n' });
    container = await kosa8.startContainer(name, 'alpine:latest', ['sh', '-c', 'while :; do sleep 3600; done']);
    expect(container).toBeTruthy();
    let r = await sh('echo hello; echo warn >&2');
    for (let i = 0; i < 20 && r.exitCode !== 0; i++) r = await sh('echo hello; echo warn >&2');
    expect(r).toMatchObject({ exitCode: 0, stdout: 'hello\n', stderr: 'warn\n' });
    expect((await sh('exit 42')).exitCode).toBe(42);
    const containers = await kosa8.sandboxContainers(name);
    expect(containers.some((c) => c.id === container)).toBe(true);
  });

  it('writes and reads a file', async () => {
    const w = await kosa8.exec(name, container, ['sh', '-c', 'mkdir -p /work && printf %s "$1" > /work/note.txt', 'sh', 'version one']);
    expect(w.exitCode).toBe(0);
    expect((await kosa8.exec(name, container, ['cat', '/work/note.txt'])).stdout).toBe('version one');
  });

  it('checkpoints and rewinds (file and container come back)', async () => {
    const cp = await kosa8.checkpoint(name, { label: 'before the change' });
    expect(cp.checkpoint.id).toBe(`${name}-ckpt-1`);
    expect(cp.snapshot.snapshot.id).toBe(`${name}-ckpt-1`);
    const cps = await kosa8.listCheckpoints(name);
    expect(cps.map((c) => c.label)).toEqual(['before the change']);
    expect((await kosa8.listSnapshots()).some((s) => s.id === `${name}-ckpt-1`)).toBe(true);

    await sh('printf %s "version two" > /work/note.txt');
    expect((await sh('cat /work/note.txt')).stdout).toBe('version two');

    const rw = await kosa8.rewind(name, { to: 'before the change' });
    expect(rw.sandbox.name).toBe(name);
    expect(rw.checkpoint.id).toBe(`${name}-ckpt-1`);
    let r = await sh('cat /work/note.txt').catch((e) => e);
    for (let i = 0; i < 20 && (r instanceof Error || r.exitCode !== 0); i++) {
      await new Promise((x) => setTimeout(x, 500));
      r = await sh('cat /work/note.txt').catch((e) => e);
    }
    expect(r.stdout).toBe('version one');
  });

  it('forks into 2 live copies', async () => {
    const out = await kosa8.fork(name, { n: 2, prefix: `${name}-f` });
    for (const f of out.forks) made.add(f.id);
    expect(out.count).toBe(2);
    expect(out.forks.map((f) => f.name)).toEqual([`${name}-f1`, `${name}-f2`]);
    // Each copy resumed with the parent's container and file.
    for (const f of out.forks) {
      let r = await sh('cat /work/note.txt', f.id).catch((e) => e);
      for (let i = 0; i < 20 && (r instanceof Error || r.exitCode !== 0); i++) {
        await new Promise((x) => setTimeout(x, 500));
        r = await sh('cat /work/note.txt', f.id).catch((e) => e);
      }
      expect(r.stdout).toBe('version one');
      expect(f.parent).toBeTruthy();
    }
    for (const f of out.forks) await kosa8.deleteSandbox(f.id);
  });

  it('explores 2 variants and keeps the one that worked', async () => {
    const out = await kosa8.explore(name, {
      variants: ['echo good', 'echo bad; exit 3'],
      prefix: `${name}-x`,
    });
    for (const b of out.branches) made.add(b.name);
    expect(out.branches).toHaveLength(2);
    expect(out.branches[0]).toMatchObject({ exit: 0, output: 'good' });
    expect(out.branches[1]!.exit).toBe(3);
    expect(out.winner).toBe(out.branches[0]!.name);
    expect(out.removed).toBe(1);
    const left = (await kosa8.listSandboxes()).map((s) => s.id);
    expect(left).toContain(out.winner);
    expect(left).not.toContain(out.branches[1]!.name);
    await kosa8.deleteSandbox(out.winner);
  });

  it('gives typed errors with the daemon message', async () => {
    const nf = await kosa8.exec(`${name}-nope`, 'x', ['true']).catch((e) => e);
    expect(nf).toBeInstanceOf(Kosa8NotFoundError);
    expect(nf.remediation).toMatch(/kosa8 sandbox ls/);
    await kosa8.stopSandbox(name);
    const stopped = await kosa8.exec(name, container, ['true']).catch((e) => e);
    expect(stopped).toBeInstanceOf(Kosa8ConflictError);
    expect(stopped.message).toMatch(/not running/);
    const up = await kosa8.startSandbox(name);
    expect(up.sandbox.state).toBe('running');
  });

  it('deletes the sandbox and its checkpoints', async () => {
    const del = await kosa8.deleteSandbox(name);
    expect(del.ok).toBe(true);
    expect(del.checkpoints_dropped).toBe(1);
    expect(await kosa8.getSandbox(name)).toBeUndefined();
    expect((await kosa8.listSnapshots()).some((s) => s.id === `${name}-ckpt-1`)).toBe(false);
  });
});

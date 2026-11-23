// Copyright (c) 2026 kosa8. Licensed under the MIT License; see LICENSE.

import { afterEach, describe, expect, it } from 'vitest';
import { APIError, Sandbox, Unsupported, setDefaultCloud } from '../src/compat/vercel.js';
import { fakeCloud } from './compat-fake.js';

afterEach(() => setDefaultCloud(undefined));

describe('vercel sandbox shim', () => {
  it('creates persistent with ports, timeout, vcpus, env, tags and network policy', async () => {
    const f = fakeCloud();
    setDefaultCloud(f.cloud);
    const sb = await Sandbox.create({
      runtime: 'python3.13', ports: [3000], timeout: 600_000, resources: { vcpus: 4 }, env: { A: '1' }, tags: { t: 'v' },
      networkPolicy: { allow: ['registry.npmjs.org'], subnets: { deny: ['10.0.0.0/8'] } },
    });
    expect(f.creates()[0]!.body).toMatchObject({
      template: 'python', persistent: true, size: '4x8', ttl_s: 600, env: { A: '1' }, labels: { t: 'v' },
      egress: { internet: false, allow: ['registry.npmjs.org'], deny: ['10.0.0.0/8'] },
    });
    expect(sb.domain(3000)).toBe('https://3000-abc.kosa8labs.com');
    expect(() => sb.domain(4000)).toThrow(APIError);
  });

  it('runCommand runs argv without a shell; output and exit code', async () => {
    const f = fakeCloud({ run: () => ['v22\n', '', 0] });
    setDefaultCloud(f.cloud);
    const sb = await Sandbox.create();
    const written: string[] = [];
    const r = await sb.runCommand({ cmd: 'node', args: ['--version'], cwd: 'app', stdout: { write: (c: string) => written.push(c) } });
    expect(r.exitCode).toBe(0);
    expect(await r.stdout()).toBe('v22\n');
    expect(written).toEqual(['v22\n']);
    const body = f.execs().at(-1)!.body;
    expect(body.stream).toBe(true);
    expect(body.cmd.slice(4)).toEqual(['/workspace/app', 'node', '--version']);
    const r2 = await sb.runCommand('ls', ['-la']);
    expect(f.execs().at(-1)!.body.cmd).toEqual(['ls', '-la']);
    expect(r2.cmdId).toBe('cmd_2');
  });

  it('a detached command is a background exec; wait and logs follow it', async () => {
    const f = fakeCloud({ bgPolls: ['a\n', 'b\n'] });
    setDefaultCloud(f.cloud);
    const sb = await Sandbox.create();
    const cmd = await sb.runCommand({ cmd: 'npm', args: ['run', 'dev'], detached: true });
    expect(f.execs().at(-1)!.body).toMatchObject({ background: true });
    const lines: string[] = [];
    for await (const l of cmd.logs()) lines.push(l.data);
    expect(lines.join('')).toBe('a\nb\n');
    expect((await cmd.wait()).exitCode).toBe(0);
  });

  it('writeFiles, readFileToBuffer, mkDir under /workspace; a missing file is null', async () => {
    const f = fakeCloud();
    setDefaultCloud(f.cloud);
    const sb = await Sandbox.create();
    await sb.writeFiles([{ path: 'src/a.js', content: Buffer.from('x=1') }]);
    expect(f.seen.some((s) => s.path.endsWith('/files/mkdir') && s.body.path === '/workspace/src')).toBe(true);
    expect((await sb.readFileToBuffer({ path: 'src/a.js' }))!.toString()).toBe('x=1');
    expect(await sb.readFileToBuffer({ path: 'nope' })).toBeNull();
    await sb.mkDir('out');
  });

  it('git source clones into /workspace', async () => {
    const f = fakeCloud();
    setDefaultCloud(f.cloud);
    await Sandbox.create({ source: { type: 'git', url: 'https://github.com/a/b.git', depth: 1 } });
    const script = f.execs()[0]!.body.cmd.at(-1) as string;
    expect(script).toContain("git clone -q --depth 1 'https://github.com/a/b.git'");
  });

  it('stop sleeps, delete deletes, extendTimeout and updateNetworkPolicy map to kosa8', async () => {
    const f = fakeCloud();
    setDefaultCloud(f.cloud);
    const sb = await Sandbox.create();
    await sb.updateNetworkPolicy('deny-all');
    expect(f.seen.at(-1)).toMatchObject({ method: 'PUT', body: { internet: false } });
    await sb.extendTimeout(60_000);
    expect(f.seen.at(-1)).toMatchObject({ method: 'PATCH' });
    await sb.stop();
    expect(f.seen.at(-1)!.path).toMatch(/\/sleep$/);
    const snap = await sb.snapshot();
    expect(snap.snapshotId).toBe('snap_1');
    await sb.delete();
    await expect(Sandbox.get({ sandboxId: 'sbx_1' })).rejects.toBeInstanceOf(APIError);
  });

  it('refuses what kosa8 cannot do', async () => {
    const f = fakeCloud();
    setDefaultCloud(f.cloud);
    await expect(Sandbox.create({ mounts: {} })).rejects.toBeInstanceOf(Unsupported);
    await expect(Sandbox.create({ networkPolicy: { allow: { 'api.x.com': [] } } })).rejects.toBeInstanceOf(Unsupported);
    await expect(Sandbox.create({ source: { type: 'snapshot', snapshotId: 'snp_vercel' } })).rejects.toBeInstanceOf(Unsupported);
    const sb = await Sandbox.create();
    await expect(sb.runCommand({ cmd: 'cat', stdin: true })).rejects.toBeInstanceOf(Unsupported);
    expect(() => sb.asUser()).toThrow(Unsupported);
    await expect(Sandbox.create({ token: 'vercel_abc' })).rejects.toThrow(/not a kosa8 key/);
  });
});

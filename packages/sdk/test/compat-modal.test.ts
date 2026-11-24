// Copyright (c) 2026 kosa8. Licensed under the MIT License; see LICENSE.

import { afterEach, describe, expect, it } from 'vitest';
import { App, ModalClient, NotFoundError, SandboxFilesystemNotFoundError, Unsupported, setDefaultCloud } from '../src/compat/modal.js';
import { fakeCloud } from './compat-fake.js';

afterEach(() => setDefaultCloud(undefined));

describe('modal shim', () => {
  it('creates from a registry image or a template key, labelled with its app', async () => {
    const f = fakeCloud();
    setDefaultCloud(f.cloud);
    const modal = new ModalClient();
    const app = await modal.apps.fromName('my-app', { createIfMissing: true });
    const sb = await modal.sandboxes.create(app, modal.images.fromRegistry('python:3.12-slim'), {
      timeoutMs: 600_000, env: { A: '1' }, tags: { t: 'v' }, outboundDomainAllowlist: ['pypi.org'],
    });
    expect(sb.sandboxId).toBe('sbx_1');
    expect(f.creates()[0]!.body).toMatchObject({
      image: 'python:3.12-slim', persistent: true, ttl_s: 600, env: { A: '1' },
      labels: { t: 'v', 'modal.app': 'my-app' }, egress: { internet: false, allow: ['pypi.org'] },
    });
    await modal.sandboxes.create(app, modal.images.fromRegistry('python'));
    expect(f.creates()[1]!.body).toMatchObject({ template: 'python', ttl_s: 300 });
  });

  it('exec streams stdout and stderr; wait gives the exit code', async () => {
    const f = fakeCloud({ run: () => ['out\n', 'err\n', 2] });
    setDefaultCloud(f.cloud);
    const modal = new ModalClient();
    const sb = await modal.sandboxes.create(await modal.apps.fromName('a'), modal.images.fromRegistry('python'), { workdir: '/app' });
    const p = await sb.exec(['python', '-c', 'x'], { timeoutMs: 120_000 });
    expect(await p.stdout.readText()).toBe('out\n');
    expect(await p.stderr.readText()).toBe('err\n');
    expect(await p.wait()).toBe(2);
    const body = f.execs().at(-1)!.body;
    expect(body).toMatchObject({ stream: true, timeout_s: 120 });
    expect(body.cmd.slice(4)).toEqual(['/app', 'python', '-c', 'x']);
  });

  it('binary mode yields bytes', async () => {
    const f = fakeCloud({ run: () => ['ab', '', 0] });
    setDefaultCloud(f.cloud);
    const modal = new ModalClient();
    const sb = await modal.sandboxes.create(await modal.apps.fromName('a'), modal.images.fromRegistry('python'));
    const p = await sb.exec(['cat'], { mode: 'binary' });
    expect(Array.from(await p.stdout.readBytes())).toEqual([97, 98]);
  });

  it('a command entrypoint runs in the background; wait and poll follow it', async () => {
    const f = fakeCloud();
    setDefaultCloud(f.cloud);
    const modal = new ModalClient();
    const sb = await modal.sandboxes.create(await modal.apps.fromName('a'), modal.images.fromRegistry('python'), { command: ['python', 'serve.py'] });
    expect(f.execs()[0]!.body).toMatchObject({ background: true, cmd: ['python', 'serve.py'] });
    expect(await sb.wait()).toBe(0);
  });

  it('tunnels are public previews of the declared ports', async () => {
    const f = fakeCloud();
    setDefaultCloud(f.cloud);
    const modal = new ModalClient();
    const sb = await modal.sandboxes.create(await modal.apps.fromName('a'), modal.images.fromRegistry('python'), { encryptedPorts: [8000] });
    const t = await sb.tunnels();
    expect(t[8000]!.url).toBe('https://8000-abc.kosa8labs.com');
    expect(f.seen.at(-1)!.body).toEqual({ port: 8000, public: true });
  });

  it('filesystem reads and writes under /workspace', async () => {
    const f = fakeCloud();
    setDefaultCloud(f.cloud);
    const modal = new ModalClient();
    const sb = await modal.sandboxes.create(await modal.apps.fromName('a'), modal.images.fromRegistry('python'));
    await sb.filesystem.writeText('hello', 'a.txt');
    expect(await sb.filesystem.readText('/workspace/a.txt')).toBe('hello');
    expect((await sb.filesystem.listFiles('.'))).toEqual([]); // "." is /workspace/. → nothing directly under that key
    expect((await sb.filesystem.listFiles('/workspace'))[0]).toMatchObject({ name: 'a.txt', type: 'file', mode: 0o644, permissions: '-rw-r--r--' });
    await expect(sb.filesystem.readText('nope')).rejects.toBeInstanceOf(SandboxFilesystemNotFoundError);
  });

  it('terminate deletes; fromId of a gone sandbox is NotFoundError', async () => {
    const f = fakeCloud();
    setDefaultCloud(f.cloud);
    const modal = new ModalClient();
    const sb = await modal.sandboxes.create(await modal.apps.fromName('a'), modal.images.fromRegistry('python'));
    expect(await sb.terminate({ wait: true })).toBe(137);
    await expect(modal.sandboxes.fromId('sbx_1')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('network policy, tags and snapshots map to kosa8 calls', async () => {
    const f = fakeCloud();
    setDefaultCloud(f.cloud);
    const modal = new ModalClient();
    const app = await modal.apps.fromName('a');
    const sb = await modal.sandboxes.create(app, modal.images.fromRegistry('python'));
    await sb.updateNetworkPolicy({ outboundCidrAllowlist: ['10.0.0.0/8'] });
    expect(f.seen.at(-1)).toMatchObject({ method: 'PUT', body: { internet: false, allow: ['10.0.0.0/8'] } });
    await sb.setTags({ k: 'v' });
    expect(f.seen.at(-1)!.body).toEqual({ labels: { k: 'v', 'modal.app': 'a' } });
    const img = await sb.snapshotFilesystem();
    expect(img.imageId).toBe('snap_1');
    await modal.sandboxes.create(app, img);
    expect(f.creates().at(-1)!.body.snapshot).toBe('snap_1');
  });

  it('the older App.lookup + app.createSandbox style works', async () => {
    const f = fakeCloud();
    setDefaultCloud(f.cloud);
    const app = await App.lookup('old', { createIfMissing: true });
    const sb = await app.createSandbox(await app.imageFromRegistry('node'));
    expect(sb.sandboxId).toBe('sbx_1');
    expect(f.creates()[0]!.body).toMatchObject({ template: 'node', labels: { 'modal.app': 'old' } });
  });

  it('refuses what kosa8 cannot do', async () => {
    const f = fakeCloud();
    setDefaultCloud(f.cloud);
    const modal = new ModalClient();
    const app = await modal.apps.fromName('a');
    const img = modal.images.fromRegistry('python');
    await expect(modal.sandboxes.create(app, img, { gpu: 'A100' })).rejects.toBeInstanceOf(Unsupported);
    await expect(modal.sandboxes.create(app, img, { volumes: { '/d': {} } })).rejects.toBeInstanceOf(Unsupported);
    expect(() => img.dockerfileCommands(['RUN x'])).toThrow(Unsupported);
    expect(() => modal.images.fromRegistry('x', {})).toThrow(Unsupported);
    const sb = await modal.sandboxes.create(app, img);
    await expect(sb.exec(['sh'], { pty: true })).rejects.toBeInstanceOf(Unsupported);
    const p = await sb.exec(['true']);
    expect(() => p.stdin).toThrow(Unsupported);
    expect(() => new ModalClient({ endpoint: 'https://api.modal.com' })).toThrow(/not a kosa8 address/);
  });
});

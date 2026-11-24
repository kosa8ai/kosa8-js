// Copyright (c) 2026 kosa8. Licensed under the MIT License; see LICENSE.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Daytona, DaytonaNotFoundError, Unsupported, setDefaultCloud } from '../src/compat/daytona.js';
import { fakeCloud } from './compat-fake.js';

afterEach(() => setDefaultCloud(undefined));

describe('daytona shim', () => {
  it('creates a persistent python sandbox with env, labels, auto-stop and network', async () => {
    const f = fakeCloud();
    setDefaultCloud(f.cloud);
    const d = new Daytona();
    const sb = await d.create({ envVars: { A: '1' }, labels: { team: 'x' }, autoStopInterval: 30, domainAllowList: 'pypi.org,github.com' });
    expect(sb.id).toBe('sbx_1');
    expect(f.creates()[0]!.body).toMatchObject({
      template: 'python', persistent: true, env: { A: '1' }, labels: { team: 'x' }, sleep_after_s: 1800,
      egress: { internet: false, allow: ['pypi.org', 'github.com'] },
    });
  });

  it('falls back to a plain sandbox when the plan has no persistent one, and warns', async () => {
    const f = fakeCloud({ refusePersistent: true });
    setDefaultCloud(f.cloud);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sb = await new Daytona().create({ language: 'typescript' });
    expect(sb.id).toBe('sbx_1');
    expect(f.creates().map((c) => c.body.persistent)).toEqual([true, undefined]);
    expect(f.creates()[1]!.body.template).toBe('node');
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('executeCommand runs through a shell in cwd and returns exitCode and result', async () => {
    const f = fakeCloud({ run: () => ['hi\n', 'warn\n', 3] });
    setDefaultCloud(f.cloud);
    const sb = await new Daytona().create();
    const r = await sb.process.executeCommand('echo hi', 'app', { X: 'y' });
    expect(r).toEqual({ exitCode: 3, result: 'hi\nwarn\n', artifacts: { stdout: 'hi\nwarn\n' } });
    const e = f.execs().at(-1)!.body;
    expect(e.cmd.slice(0, 5)).toEqual(['sh', '-c', 'cd "$1" || exit 1; shift; exec "$@"', 'sh', '/workspace/app']);
    expect(e.env).toEqual(['X=y']);
  });

  it('a long timeout streams instead of the 90 s buffered exec', async () => {
    const f = fakeCloud();
    setDefaultCloud(f.cloud);
    const sb = await new Daytona().create();
    await sb.process.executeCommand('make', undefined, undefined, 600);
    expect(f.execs().at(-1)!.body).toMatchObject({ stream: true, timeout_s: 600 });
  });

  it('codeRun runs python3 -c', async () => {
    const f = fakeCloud();
    setDefaultCloud(f.cloud);
    const sb = await new Daytona().create();
    await sb.process.codeRun('print(1)');
    expect(f.execs().at(-1)!.body.cmd).toEqual(['python3', '-c', 'print(1)']);
  });

  it('sessions keep cwd and exports through a state file', async () => {
    const f = fakeCloud();
    setDefaultCloud(f.cloud);
    const sb = await new Daytona().create();
    await sb.process.createSession('s1');
    const r = await sb.process.executeSessionCommand('s1', { command: 'cd /tmp' });
    expect(r.exitCode).toBe(0);
    const script = f.execs().at(-1)!.body.cmd.at(-1) as string;
    expect(script).toContain('/workspace/.kosa8-sessions/s1.cwd');
    expect(script).toContain('export -p >');
    const bg = await sb.process.executeSessionCommand('s1', { command: 'sleep 1', runAsync: true });
    expect(bg.cmdId).toMatch(/^bg_/);
    const chunks: string[] = [];
    await sb.process.getSessionCommandLogs('s1', bg.cmdId, (c) => chunks.push(c), () => {});
    expect(chunks.join('')).toBe('done\n');
    expect((await sb.process.getSessionCommand('s1', bg.cmdId)).exitCode).toBe(0);
  });

  it('fs upload, download, list, folders and delete under /workspace', async () => {
    const f = fakeCloud();
    setDefaultCloud(f.cloud);
    const sb = await new Daytona().create();
    await sb.fs.uploadFile(Buffer.from('abc'), 'data/a.txt');
    expect(f.files.has('/workspace/data/a.txt')).toBe(true);
    expect((await sb.fs.downloadFile('data/a.txt')).toString()).toBe('abc');
    const ls = await sb.fs.listFiles('data');
    expect(ls[0]).toMatchObject({ name: 'a.txt', isDir: false, size: 3, mode: '-rw-r--r--', permissions: '0644' });
    await sb.fs.createFolder('out', '755');
    await sb.fs.deleteFile('data/a.txt');
    expect(f.files.size).toBe(0);
    await expect(sb.fs.downloadFile('nope')).rejects.toBeInstanceOf(DaytonaNotFoundError);
  });

  it('preview links come from the previews API; public sandboxes get public links', async () => {
    const f = fakeCloud();
    setDefaultCloud(f.cloud);
    const sb = await new Daytona().create({ public: true });
    const p = await sb.getPreviewLink(3000);
    expect(p.url).toBe('https://3000-abc.kosa8labs.com/');
    expect(f.seen.at(-1)!.body).toEqual({ port: 3000, public: true });
    const signed = await sb.getSignedPreviewUrl(8080, 600);
    expect(signed).toMatchObject({ port: 8080, token: 'tok' });
  });

  it('network settings, labels, stop/start and delete map to kosa8 calls', async () => {
    const f = fakeCloud();
    setDefaultCloud(f.cloud);
    const sb = await new Daytona().create();
    await sb.updateNetworkSettings({ networkBlockAll: true });
    expect(f.seen.at(-1)).toMatchObject({ method: 'PUT', path: '/v1/sandboxes/sbx_1/egress', body: { internet: false } });
    await sb.setLabels({ a: 'b' });
    await sb.stop();
    expect(f.seen.some((s) => s.path.endsWith('/sleep'))).toBe(true);
    await sb.start();
    expect(f.seen.some((s) => s.path.endsWith('/wake'))).toBe(true);
    await sb.delete();
    await expect(new Daytona().get('sbx_1')).rejects.toBeInstanceOf(DaytonaNotFoundError);
  });

  it('refuses what kosa8 cannot do, naming the alternative', async () => {
    const f = fakeCloud();
    setDefaultCloud(f.cloud);
    const d = new Daytona();
    await expect(d.create({ volumes: [{}] })).rejects.toBeInstanceOf(Unsupported);
    await expect(d.create({ image: { build: true } })).rejects.toThrow(/registry\/name:tag/);
    await expect(d.create({ resources: { gpu: 1 } })).rejects.toBeInstanceOf(Unsupported);
    const sb = await d.create();
    expect(() => sb.git).toThrow(Unsupported);
    await expect(sb.process.createPty()).rejects.toBeInstanceOf(Unsupported);
    expect(() => new Daytona({ jwtToken: 'x' })).toThrow(Unsupported);
    expect(() => new Daytona({ apiUrl: 'https://app.daytona.io/api' })).toThrow(/not a kosa8 address/);
  });

  it('reads DAYTONA_API_KEY only when it holds a kosa8 key', () => {
    const old = { ...process.env };
    try {
      delete process.env.KOSA8_API_KEY;
      process.env.DAYTONA_API_KEY = 'dtn_abc';
      expect(() => new Daytona()).toThrow(/another provider's key/);
      process.env.DAYTONA_API_KEY = 'k8c_live_x';
      expect(() => new Daytona()).not.toThrow();
      expect(() => new Daytona({ apiKey: 'dtn_abc' })).toThrow(/not a kosa8 key/);
    } finally {
      process.env = old;
    }
  });
});

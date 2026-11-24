// Copyright (c) 2026 kosa8. Licensed under the MIT License; see LICENSE.

import { afterEach, describe, expect, it } from 'vitest';
import { CommandExitError, NotFoundError, Sandbox, setDefaultCloud } from '../src/compat/e2b.js';
import { fakeCloud } from './compat-fake.js';

afterEach(() => setDefaultCloud(undefined));

describe('e2b shim', () => {
  it('commands.run streams to onStdout; a callback that returns a value (process.stdout.write) type-checks', async () => {
    const f = fakeCloud({ run: () => ['hi\n', '', 0] });
    setDefaultCloud(f.cloud);
    const sbx = await Sandbox.create();
    const got: string[] = [];
    // process.stdout.write returns boolean: E2B's README pattern must compile.
    const r = await sbx.commands.run('echo hi', { onStdout: (d) => got.push(d), timeoutMs: 600_000 });
    expect(r).toEqual({ exitCode: 0, stdout: 'hi\n', stderr: '' });
    expect(got).toEqual(['hi\n']);
    expect(f.execs().at(-1)!.body).toMatchObject({ stream: true, timeout_s: 600 });
    const write: (d: string) => boolean = () => true;
    await sbx.commands.run('echo hi', { onStdout: write, onStderr: write });
  });

  it('a non-zero exit throws CommandExitError', async () => {
    const f = fakeCloud({ run: () => ['', 'bad\n', 2] });
    setDefaultCloud(f.cloud);
    const sbx = await Sandbox.create();
    const e = await sbx.commands.run('false').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(CommandExitError);
    expect((e as CommandExitError).exitCode).toBe(2);
  });

  it('files: write makes parents, read back, list gives E2B mode bits and permissions', async () => {
    const f = fakeCloud();
    setDefaultCloud(f.cloud);
    const sbx = await Sandbox.create();
    await sbx.files.write('data/a.txt', 'abc');
    expect(f.files.has('/workspace/data/a.txt')).toBe(true);
    expect(await sbx.files.read('data/a.txt')).toBe('abc');
    const ls = await sbx.files.list('data');
    expect(ls[0]).toMatchObject({ name: 'a.txt', path: '/workspace/data/a.txt', type: 'file', size: 3, mode: 0o644, permissions: '-rw-r--r--' });
    expect(await sbx.files.exists('data/a.txt')).toBe(true);
    expect(await sbx.files.exists('data/b.txt')).toBe(false);
    await expect(sbx.files.read('nope')).rejects.toBeInstanceOf(NotFoundError);
  });
});

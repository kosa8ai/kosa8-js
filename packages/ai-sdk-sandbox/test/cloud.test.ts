import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { HarnessV1SandboxTemplate } from '@ai-sdk/harness';
import { Kosa8Cloud, Kosa8ConflictError, Kosa8NotFoundError } from '@kosa8/sdk';
import { generateText, stepCountIs, tool } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createKosa8CloudSandbox,
  createKosa8CloudSandboxSession,
  createKosa8CloudSandboxSessionFromSandbox,
  resumeKosa8CloudSandboxSession,
  repoWorkingDirectory,
  sandboxNameForSession,
  toCloudEgress,
} from '../src/index.js';
import { FakeCloud, TEST_KEY } from './fake-cloud.js';

let fake: FakeCloud;
let cloud: Kosa8Cloud;

beforeEach(() => {
  fake = new FakeCloud();
  cloud = new Kosa8Cloud({ apiKey: TEST_KEY, env: {}, fetch: fake.fetch });
});
afterEach(() => fake.close());

const opts = () => ({ cloud, pollIntervalMs: 50 });

describe('createKosa8CloudSandboxSession', () => {
  it('creates a sandbox with the settings it was given and describes it', async () => {
    const s = await createKosa8CloudSandboxSession({
      ...opts(),
      sandboxId: 'agent-1',
      template: 'python',
      size: '2x4',
      ttlS: 600,
      sleepAfterS: 120,
      labels: { team: 'ml' },
      networkPolicy: { mode: 'custom', allowedHosts: ['pypi.org'], deniedCIDRs: ['169.254.169.254/32'] },
    });
    const post = fake.calls('POST', '/v1/sandboxes')[0]!;
    expect(post.body).toEqual({
      name: 'agent-1', template: 'python', size: '2x4', ttl_s: 600, sleep_after_s: 120,
      egress: { internet: false, allow: ['pypi.org'], deny: ['169.254.169.254/32'] },
    });
    expect(fake.calls('PUT', '/labels')).toHaveLength(1);
    expect(s.id).toBe('sbx_1');
    expect(s.sandboxId).toBe('sbx_1');
    expect(s.defaultWorkingDirectory).toBe('/workspace');
    expect(s.description).toMatch(/kosa8 Cloud sandbox sbx_1/);
    expect(s.description).toMatch(/outbound access only to pypi.org; never 169.254.169.254\/32/);
  });

  it('refuses a name a live sandbox already has, and reads the key from the environment only when no client is given', async () => {
    fake.addSandbox({ name: 'taken' });
    await expect(createKosa8CloudSandboxSession({ ...opts(), sandboxId: 'taken' })).rejects.toBeInstanceOf(Kosa8ConflictError);
    expect(fake.calls('POST', '/v1/sandboxes')).toHaveLength(0);
    await expect(createKosa8CloudSandboxSession({ apiKey: 'nope' })).rejects.toThrow(/k8c_live_/);
  });

  it('makes a custom working directory and runs setup commands; a failing setup deletes the sandbox', async () => {
    const wd = '/workspace/proj';
    const s = await createKosa8CloudSandboxSession({ ...opts(), workingDirectory: wd, setupCommands: ['echo ready > marker'] });
    expect(fs.readFileSync(path.join(fake.root, 'proj', 'marker'), 'utf8')).toBe('ready\n');
    expect((await s.run({ command: 'pwd' })).stdout).toBe('/workspace/proj\n');
    await expect(createKosa8CloudSandboxSession({ ...opts(), setupCommands: ['exit 3'] })).rejects.toThrow(/setupCommand failed \(exit 3\)/);
    expect(fake.sandboxes.get('sbx_2')!.state).toBe('deleted');
  });

  it('starts from a GitHub repo: sends repo and works in its checkout', async () => {
    const s = await createKosa8CloudSandboxSession({ ...opts(), repo: 'acme/api@main' });
    expect((fake.calls('POST', '/v1/sandboxes')[0]!.body as Record<string, unknown>).repo).toBe('acme/api@main');
    expect(s.defaultWorkingDirectory).toBe('/workspace/api');
    const t = await createKosa8CloudSandboxSession({ ...opts(), repo: { name: 'acme/web', path: '/workspace/w' } });
    expect((fake.calls('POST', '/v1/sandboxes')[1]!.body as Record<string, unknown>).repo).toEqual({ name: 'acme/web', path: '/workspace/w' });
    expect(t.defaultWorkingDirectory).toBe('/workspace/w');
    expect(repoWorkingDirectory({ name: 'acme/x' })).toBe('/workspace/x');
  });

  it('rejects networkPolicy with egress, and an already aborted signal before any request', async () => {
    await expect(
      createKosa8CloudSandboxSession({ ...opts(), networkPolicy: { mode: 'deny-all' }, egress: { internet: true } }),
    ).rejects.toThrow(/not both/);
    await expect(createKosa8CloudSandboxSession({ ...opts(), abortSignal: AbortSignal.abort() })).rejects.toThrow();
    expect(fake.seen).toHaveLength(0);
  });
});

describe('commands', () => {
  it('runs with stdout and stderr apart, the exit code, cwd and env (call env over session env)', async () => {
    const s = await createKosa8CloudSandboxSession({ ...opts(), env: { A: 'session', B: 'session' } });
    const r = await s.run({ command: 'pwd; echo "$A $B"; echo oops >&2; exit 7', env: { B: 'call' } });
    expect(r).toEqual({ exitCode: 7, stdout: '/workspace\nsession call\n', stderr: 'oops\n' });
    await s.run({ command: 'mkdir -p sub' });
    expect((await s.run({ command: 'pwd', workingDirectory: 'sub' })).stdout).toBe('/workspace/sub\n');
    const missing = await s.run({ command: 'true', workingDirectory: '/workspace/none' });
    expect(missing.exitCode).not.toBe(0);
    expect(missing.stderr).toMatch(/none/);
    await expect(s.run({ command: 'true', env: { 'BAD-NAME': '1' } })).rejects.toThrow(/invalid environment variable/);
  });

  it('starts every command as a background exec (not held to 90 s) and sends commandTimeoutS', async () => {
    const s = await createKosa8CloudSandboxSession({ ...opts(), commandTimeoutS: 600 });
    await s.run({ command: 'echo hi' });
    const start = fake.calls('POST', '/exec').find((c) => (c.body as { background?: boolean }).background)!;
    expect(start.body).toMatchObject({ background: true, timeout_s: 600, cmd: ['sh', '-c', expect.any(String), 'k8'] });
    expect((start.body as { env: string[] }).env).toContain('K8_CMD=echo hi');
    expect(fake.calls('GET', '/exec/bg_1').length).toBeGreaterThan(0);
  });

  it('streams output before the command exits', async () => {
    const s = await createKosa8CloudSandboxSession(opts());
    const p = await s.spawn({ command: 'echo first; sleep 1; echo second' });
    const reader = p.stdout.getReader();
    const t = Date.now();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe('first\n');
    expect(Date.now() - t).toBeLessThan(900);
    let rest = '';
    for (let r = await reader.read(); !r.done; r = await reader.read()) rest += new TextDecoder().decode(r.value);
    expect(rest).toBe('second\n');
    expect(await p.wait()).toEqual({ exitCode: 0 });
  });

  it('reads the rest of the output from its file when the status answer is truncated', async () => {
    fake.statusOutputCap = 1000;
    const s = await createKosa8CloudSandboxSession(opts());
    const r = await s.run({ command: 'seq 1 20000' });
    expect(r.stdout).toBe(Array.from({ length: 20000 }, (_, i) => `${i + 1}\n`).join(''));
  });

  it('stops the command on abort (wait rejects with the reason) and on kill()', async () => {
    const s = await createKosa8CloudSandboxSession(opts());
    const ctl = new AbortController();
    const p = await s.spawn({ command: 'sleep 30', abortSignal: ctl.signal });
    setTimeout(() => ctl.abort(new Error('gave up')), 200);
    await expect(p.wait()).rejects.toThrow('gave up');
    expect(fake.calls('POST', '/stop')).toHaveLength(1);
    await expect(s.run({ command: 'true', abortSignal: ctl.signal })).rejects.toThrow('gave up');

    const k = await s.spawn({ command: 'sleep 30' });
    await k.kill();
    await k.kill();
    expect(await k.wait()).toEqual({ exitCode: 143 });
    expect(fake.calls('POST', '/stop')).toHaveLength(2);
  });

  it('sends a command too large for one request as a staged file', async () => {
    const s = await createKosa8CloudSandboxSession(opts());
    const r = await s.run({ command: `echo ${'x'.repeat(70_000)} | wc -c` });
    expect(r.stdout.trim()).toBe('70001');
    const start = fake.calls('POST', '/exec').find((c) => (c.body as { background?: boolean }).background)!;
    expect((start.body as { env: string[] }).env.some((e) => e.startsWith('K8_CMDFILE=/workspace/.kosa8-run/cmd-'))).toBe(true);
    await new Promise((r) => setTimeout(r, 100));
    expect(fs.readdirSync(path.join(fake.root, '.kosa8-run')).filter((f) => f.startsWith('cmd-'))).toEqual([]);
  });
});

describe('files', () => {
  const outside = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'k8out-')), 'deep', 'b.txt');

  for (const mode of ['files API', 'exec only'] as const) {
    describe(mode, () => {
      beforeEach(() => {
        fake.filesApi = mode === 'files API';
      });

      it('writes and reads text, making parent folders; missing is null; a directory throws', async () => {
        const s = (await createKosa8CloudSandboxSession(opts())).restricted();
        await s.writeTextFile({ path: 'notes/a.txt', content: 'line1\nline2\nline3\n' });
        expect(fs.readFileSync(path.join(fake.root, 'notes/a.txt'), 'utf8')).toBe('line1\nline2\nline3\n');
        expect(await s.readTextFile({ path: '/workspace/notes/a.txt' })).toBe('line1\nline2\nline3\n');
        expect(await s.readTextFile({ path: 'notes/a.txt', startLine: 2, endLine: 9 })).toBe('line2\nline3\n');
        expect(await s.readTextFile({ path: 'nope.txt' })).toBeNull();
        expect(await s.readFile({ path: 'nope.txt' })).toBeNull();
        await expect(s.readTextFile({ path: 'notes' })).rejects.toThrow(/directory/);
        await expect(s.writeTextFile({ path: 'notes', content: 'x' })).rejects.toThrow(/directory/);
        await s.writeTextFile({ path: 'empty.txt', content: '' });
        expect(await s.readTextFile({ path: 'empty.txt' })).toBe('');
      });

      it('reads and writes outside /workspace', async () => {
        const s = (await createKosa8CloudSandboxSession(opts())).restricted();
        const p = outside();
        await s.writeTextFile({ path: p, content: 'outside' });
        expect(fs.readFileSync(p, 'utf8')).toBe('outside');
        expect(await s.readTextFile({ path: p })).toBe('outside');
      });

      it('round-trips binary data and streams', async () => {
        const s = (await createKosa8CloudSandboxSession(opts())).restricted();
        const data = randomBytes(mode === 'files API' ? 9 * 1024 * 1024 + 17 : 200_000);
        await s.writeBinaryFile({ path: 'bin/blob', content: data });
        expect(Buffer.compare(fs.readFileSync(path.join(fake.root, 'bin/blob')), data)).toBe(0);
        const back = await s.readBinaryFile({ path: 'bin/blob' });
        expect(Buffer.compare(Buffer.from(back!), data)).toBe(0);
        await s.writeFile({
          path: 's.txt',
          content: new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode('one,'));
              c.enqueue(new TextEncoder().encode('two'));
              c.close();
            },
          }),
        });
        expect(await new Response((await s.readFile({ path: 's.txt' }))!).text()).toBe('one,two');
        const staged = fs.existsSync(path.join(fake.root, '.kosa8-run'))
          ? fs.readdirSync(path.join(fake.root, '.kosa8-run')).filter((f) => /^(up|dl)-/.test(f))
          : [];
        expect(staged).toEqual([]);
      });
    });
  }

  it('sends over-8 MiB files through the files API in parts', async () => {
    const s = await createKosa8CloudSandboxSession(opts());
    await s.writeBinaryFile({ path: 'big', content: randomBytes(8 * 1024 * 1024 + 1) });
    const puts = fake.calls('PUT', '/files').filter((c) => c.query.get('path')!.startsWith('/workspace/.kosa8-run/up-'));
    expect(puts.map((p) => (p.body as Uint8Array).byteLength)).toEqual([8 * 1024 * 1024, 1]);
    fake.seen.length = 0;
    await s.readBinaryFile({ path: 'big' });
    expect(fake.calls('GET', '/files').map((c) => c.query.get('path')!.replace(/dl-[0-9a-f]+/, 'dl-X'))).toEqual([
      '/workspace/.kosa8-run/dl-X.0',
      '/workspace/.kosa8-run/dl-X.1',
    ]);
  });

  it('asks a host without the files API only once', async () => {
    fake.filesApi = false;
    const s = await createKosa8CloudSandboxSession(opts());
    await s.writeTextFile({ path: 'a', content: 'x' });
    await s.readTextFile({ path: 'a' });
    expect(fake.seen.filter((c) => c.path.includes('/files')).length).toBe(1);
  });
});

describe('lifecycle, network and ports', () => {
  it('stop() puts it to sleep, resume wakes it by id or name, destroy() deletes it', async () => {
    const s = await createKosa8CloudSandboxSession({ ...opts(), sandboxId: 'keep' });
    await s.stop();
    await s.stop();
    expect(fake.calls('POST', '/sleep')).toHaveLength(1);
    expect(fake.sandboxes.get('sbx_1')!.state).toBe('sleeping');
    const r = await resumeKosa8CloudSandboxSession({ ...opts(), sandboxId: 'keep' });
    expect(r.id).toBe('sbx_1');
    expect(fake.calls('POST', '/wake')).toHaveLength(1);
    const again = await resumeKosa8CloudSandboxSession({ ...opts(), sandboxId: 'sbx_1' });
    expect(again.id).toBe('sbx_1');
    await r.destroy();
    expect(fake.sandboxes.get('sbx_1')!.state).toBe('deleted');
    await expect(resumeKosa8CloudSandboxSession({ ...opts(), sandboxId: 'sbx_1' })).rejects.toBeInstanceOf(Kosa8NotFoundError);
    await expect(resumeKosa8CloudSandboxSession({ ...opts(), sandboxId: 'keep' })).rejects.toBeInstanceOf(Kosa8NotFoundError);
  });

  it('a wrapped sandbox is left alone by stop() and destroy()', async () => {
    const id = fake.addSandbox();
    const s = await createKosa8CloudSandboxSessionFromSandbox({ ...opts(), sandbox: id });
    expect((await s.run({ command: 'echo ok' })).stdout).toBe('ok\n');
    await s.stop();
    await s.destroy();
    expect(fake.sandboxes.get(id)!.state).toBe('running');
  });

  it('setNetworkPolicy changes egress at once', async () => {
    const s = await createKosa8CloudSandboxSession(opts());
    await s.setNetworkPolicy({ mode: 'deny-all' });
    expect(fake.calls('PUT', '/egress')[0]!.body).toEqual({ internet: false, allow: [], deny: [] });
    expect(s.description).toMatch(/no network access/);
    expect(toCloudEgress({ mode: 'allow-all' })).toEqual({ internet: true });
    expect(toCloudEgress({ mode: 'custom', allowedCIDRs: ['10.0.0.0/8'] })).toEqual({ internet: false, allow: ['10.0.0.0/8'], deny: [] });
    expect(() => toCloudEgress({ mode: 'custom', allowedHosts: [' '] })).toThrow(/at least one/);
  });

  it('opens ports as private previews', async () => {
    const s = await createKosa8CloudSandboxSession(opts());
    expect((await s.getPortEndpoint({ port: 3000 })).url).toBe('https://3000-sbx_1.preview.test/?token=t3000');
    expect((await s.getPortEndpoint({ port: 3000, protocol: 'ws' })).url).toBe('wss://3000-sbx_1.preview.test/?token=t3000&fresh=1');
    await s.setPorts([8080]);
    expect(s.ports).toEqual([8080]);
    expect([...fake.previews.keys()]).toEqual([8080]);
  });

  it('restricted() exposes only the tool-safe surface', async () => {
    const s = await createKosa8CloudSandboxSession(opts());
    const r = s.restricted() as unknown as Record<string, unknown>;
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.keys(r).sort()).toEqual(
      ['description', 'readBinaryFile', 'readFile', 'readTextFile', 'run', 'spawn', 'writeBinaryFile', 'writeFile', 'writeTextFile'].sort(),
    );
    expect(r.stop).toBeUndefined();
    expect(r.sandbox).toBeUndefined();
  });
});

describe('templates and the provider shape', () => {
  it('an AI SDK template is prepared once, kept as a snapshot, and restored after', async () => {
    let prepared = 0;
    const template: HarnessV1SandboxTemplate = {
      identity: 'deps-v1',
      prepare: async ({ session }) => {
        prepared++;
        await session.run({ command: 'echo installed > deps' });
      },
    };
    const a = await createKosa8CloudSandboxSession({ ...opts(), template, cloudTemplate: 'node' });
    expect(prepared).toBe(1);
    expect(fake.calls('POST', '/snapshots')).toHaveLength(1);
    const b = await createKosa8CloudSandboxSession({ ...opts(), template, cloudTemplate: 'node' });
    expect(prepared).toBe(1);
    expect(fake.calls('POST', '/v1/sandboxes').at(-1)!.body).toEqual({ snapshot: 'snap_1' });
    expect(b.id).not.toBe(a.id);
  });

  it('createSession/resumeSession map a sessionId to one sandbox name', async () => {
    const p = createKosa8CloudSandbox(opts());
    expect(p.providerId).toBe('kosa8-cloud-sandbox');
    const s = await p.createSession!({ sessionId: 'Chat 42' });
    expect(fake.sandboxes.get(s.id)!.name).toBe(sandboxNameForSession('Chat 42'));
    expect((await p.resumeSession!({ sessionId: 'Chat 42' })).id).toBe(s.id);
  });
});

describe('AI SDK generateText', () => {
  it('runs a tool loop whose tools act through experimental_sandbox', async () => {
    const s = await createKosa8CloudSandboxSession(opts());
    const usage = {
      inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 1, text: 1, reasoning: undefined },
    };
    const call = (id: string, toolName: string, input: unknown) => ({
      content: [{ type: 'tool-call' as const, toolCallId: id, toolName, input: JSON.stringify(input) }],
      finishReason: { unified: 'tool-calls' as const, raw: undefined },
      usage,
      warnings: [],
    });
    const model = new MockLanguageModelV4({
      doGenerate: [
        call('1', 'write', { path: 'hello.txt', content: 'hello from the agent\n' }),
        call('2', 'shell', { command: 'cat hello.txt' }),
        { content: [{ type: 'text' as const, text: 'done' }], finishReason: { unified: 'stop' as const, raw: undefined }, usage, warnings: [] },
      ],
    });
    const result = await generateText({
      model,
      stopWhen: stepCountIs(5),
      prompt: `go\n\n${s.description}`,
      experimental_sandbox: s.restricted(),
      tools: {
        write: tool({
          inputSchema: z.object({ path: z.string(), content: z.string() }),
          execute: async ({ path: p, content }, { experimental_sandbox }) => {
            await experimental_sandbox!.writeTextFile({ path: p, content });
            return { written: p };
          },
        }),
        shell: tool({
          inputSchema: z.object({ command: z.string() }),
          execute: ({ command }, { experimental_sandbox, abortSignal }) => experimental_sandbox!.run({ command, abortSignal }),
        }),
      },
    });
    const shell = result.steps.flatMap((st) => st.toolResults).find((r) => r.toolName === 'shell');
    expect(shell?.output).toEqual({ exitCode: 0, stdout: 'hello from the agent\n', stderr: '' });
    expect(result.text).toBe('done');
  });
});

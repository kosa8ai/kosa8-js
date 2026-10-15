import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { HarnessCapabilityUnsupportedError } from '@ai-sdk/harness';
import { Kosa8Client, MemoryCheckpointStore } from '@kosa8/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createKosa8NetworkSandboxSession,
  createKosa8Sandbox,
  resumeKosa8NetworkSandboxSession,
  sandboxNameForSession,
  toKosa8Egress,
} from '../src/index.js';
import { MockDaemon, json } from '../../sdk/test/mock-daemon.js';

/**
 * The mock daemon runs exec requests as real processes on the host, so the
 * adapter's shell scripts (pid files, kill, base64 writes, reads) are
 * exercised for real. The "container" is the host, rooted at a temp dir.
 */
let d: MockDaemon;
let client: Kosa8Client;
let work: string;
let state: {
  sandboxes: Map<string, { id: string; name: string; state: string; egress?: string; created: string; cpus: number; mem_mb: number }>;
  snapshots: Set<string>;
  containers: Map<string, string[]>;
};

function addSandbox(name: string, egress?: string, st = 'running') {
  const s = { id: name, name, state: st, egress, created: new Date().toISOString(), cpus: 2, mem_mb: 1024 };
  state.sandboxes.set(name, s);
  return s;
}

beforeEach(async () => {
  d = new MockDaemon();
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'k8w-'));
  state = { sandboxes: new Map(), snapshots: new Set(), containers: new Map() };
  d.on('POST', '/kosa8/v1/sandboxes', (r, res) => {
    const b = JSON.parse(r.body);
    const s = addSandbox(b.name ?? `sbx${state.sandboxes.size + 1}`, b.egress);
    json(res, 201, { sandbox: s, boot_ms: 5 });
  });
  d.on('GET', '/kosa8/v1/sandboxes', (_r, res) => json(res, 200, [...state.sandboxes.values()]));
  d.on('POST', '/kosa8/v1/sandboxes/{id}/pull', (r, res) => json(res, 200, { ok: true, image: JSON.parse(r.body).ref }));
  d.on('POST', '/kosa8/v1/sandboxes/{id}/start', (r, res) => {
    const sb = r.url.split('/')[4]!;
    const id = `c-${state.containers.size + 1}`;
    state.containers.set(id, [sb]);
    json(res, 200, { ok: true, id });
  });
  d.on('GET', '/kosa8/v1/sandboxes/{id}/containers', (r, res) => {
    const sb = r.url.split('/')[4]!;
    json(
      res,
      200,
      [...state.containers.entries()].filter(([, v]) => v[0] === sb).map(([id]) => ({ id, image: 'alpine:latest', status: 'running' })),
    );
  });
  d.on('POST', '/kosa8/v1/sandboxes/{id}/exec', (r, res) => {
    const { args } = JSON.parse(r.body) as { container: string; args: string[] };
    // `test -e /.kosa8-ai-sdk` cannot pass on the host; answer it as the container would.
    if (args[0] === 'test' && args[2] === '/.kosa8-ai-sdk') {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.end(JSON.stringify({ done: true, ok: true }) + '\n');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    const p = spawn(args[0]!, args.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
    p.stdout.on('data', (b: Buffer) => res.write(JSON.stringify({ stream: 'stdout', data: b.toString('base64') }) + '\n'));
    p.stderr.on('data', (b: Buffer) => res.write(JSON.stringify({ stream: 'stderr', data: b.toString('base64') }) + '\n'));
    p.on('close', (code, sig) => {
      const exit = code ?? (sig ? 128 + (os.constants.signals[sig] ?? 0) : 0);
      res.end(JSON.stringify(exit ? { done: true, ok: true, exit } : { done: true, ok: true }) + '\n');
    });
  });
  d.on('POST', '/kosa8/v1/sandboxes/{id}/snapshot', (r, res) => {
    const id = JSON.parse(r.body).id;
    if (state.snapshots.has(id)) return json(res, 409, { error: `snapshot ${id} already exists`, remediation: '' });
    state.snapshots.add(id);
    json(res, 200, { snapshot: { id, sandbox: r.url.split('/')[4] }, snapshot_ms: 1 });
  });
  d.on('GET', '/kosa8/v1/snapshots', (_r, res) => json(res, 200, [...state.snapshots].map((id) => ({ id }))));
  d.on('DELETE', '/kosa8/v1/snapshots/{id}', (r, res) => {
    const id = decodeURIComponent(r.url.split('/')[4]!.split('?')[0]!);
    if (!state.snapshots.delete(id)) return json(res, 404, { error: `no such snapshot ${id}`, remediation: '' });
    json(res, 200, { ok: true, removed: id, encrypted: false });
  });
  d.on('POST', '/kosa8/v1/snapshots/{id}/restore', (r, res) => {
    const name = JSON.parse(r.body).name;
    const s = addSandbox(name);
    state.containers.set(`c-r-${name}`, [name]);
    json(res, 200, { sandbox: s, restore_ms: 1 });
  });
  d.on('POST', '/kosa8/v1/sandboxes/{id}/down', (r, res) => {
    const s = state.sandboxes.get(r.url.split('/')[4]!)!;
    s.state = 'stopped';
    for (const [id, v] of state.containers) if (v[0] === s.id) state.containers.delete(id);
    json(res, 200, { ok: true, sandbox: s });
  });
  d.on('DELETE', '/kosa8/v1/sandboxes/{id}', (r, res) => {
    const id = r.url.split('/')[4]!.split('?')[0]!;
    if (!state.sandboxes.delete(id)) return json(res, 404, { error: `no such sandbox: ${id}`, remediation: '' });
    json(res, 200, { ok: true });
  });
  await d.start();
  client = new Kosa8Client({ socketPath: d.socketPath, env: {}, checkpointStore: new MemoryCheckpointStore() });
});

afterEach(async () => {
  await d.stop();
  fs.rmSync(work, { recursive: true, force: true });
});

describe('network policy mapping', () => {
  it('maps the AI SDK policy onto kosa8 egress', () => {
    expect(toKosa8Egress({ mode: 'allow-all' })).toBe('any');
    expect(toKosa8Egress({ mode: 'deny-all' })).toBe('deny');
    expect(toKosa8Egress({ mode: 'custom', allowedHosts: ['api.anthropic.com'], allowedCIDRs: ['10.0.0.0/8'] })).toBe(
      'allow:api.anthropic.com,10.0.0.0/8',
    );
  });
  it('refuses deniedCIDRs honestly', () => {
    expect(() => toKosa8Egress({ mode: 'custom', allowedHosts: ['a.com'], deniedCIDRs: ['169.254.169.254/32'] })).toThrow(
      HarnessCapabilityUnsupportedError,
    );
  });
});

describe('createKosa8NetworkSandboxSession', () => {
  it('creates the sandbox with the mapped egress, pulls, starts the work container', async () => {
    const s = await createKosa8NetworkSandboxSession({
      client,
      sandboxId: 'agent-1',
      workingDirectory: work,
      networkPolicy: { mode: 'custom', allowedHosts: ['registry.npmjs.org'] },
    });
    expect(s.id).toBe('agent-1');
    expect(s.defaultWorkingDirectory).toBe(work);
    expect(JSON.parse(d.find('POST', '/kosa8/v1/sandboxes')[0]!.body)).toEqual({
      name: 'agent-1',
      egress: 'allow:registry.npmjs.org',
    });
    expect(JSON.parse(d.find('POST', '/kosa8/v1/sandboxes/agent-1/pull')[0]!.body)).toEqual({ ref: 'alpine:latest' });
    expect(s.description).toMatch(/outbound access only to registry.npmjs.org/);
  });

  it('runs commands with cwd and env, reporting non-zero exits without throwing', async () => {
    const s = (await createKosa8NetworkSandboxSession({ client, workingDirectory: work, env: { BASE: 'b' } })).restricted();
    fs.mkdirSync(path.join(work, 'sub'));
    const r = await s.run({ command: 'pwd; echo "$BASE-$X"; echo oops >&2; exit 7', workingDirectory: 'sub', env: { X: "it's" } });
    expect(r.exitCode).toBe(7);
    const [pwd, envLine] = r.stdout.trim().split('\n');
    expect(fs.realpathSync(pwd!)).toBe(fs.realpathSync(path.join(work, 'sub')));
    expect(envLine).toBe("b-it's");
    expect(r.stderr).toBe('oops\n');
  });

  it('writes and reads files (text, binary, ranges, streams, missing)', async () => {
    const s = (await createKosa8NetworkSandboxSession({ client, workingDirectory: work })).restricted();
    await s.writeTextFile({ path: 'a/b/hello.txt', content: 'one\ntwo\nthree\n' });
    expect(fs.readFileSync(path.join(work, 'a/b/hello.txt'), 'utf8')).toBe('one\ntwo\nthree\n');
    expect(await s.readTextFile({ path: 'a/b/hello.txt' })).toBe('one\ntwo\nthree\n');
    expect(await s.readTextFile({ path: 'a/b/hello.txt', startLine: 2, endLine: 2 })).toBe('two');
    const bin = new Uint8Array(300_000).map((_, i) => (i * 7) % 256);
    await s.writeBinaryFile({ path: `${work}/bin.dat`, content: bin });
    const back = await s.readBinaryFile({ path: 'bin.dat' });
    expect(Buffer.compare(Buffer.from(back!), Buffer.from(bin))).toBe(0);
    await s.writeFile({
      path: 'stream.txt',
      content: new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('str'));
          c.enqueue(new TextEncoder().encode('eam'));
          c.close();
        },
      }),
    });
    const rs = await s.readFile({ path: 'stream.txt' });
    expect(await new Response(rs!).text()).toBe('stream');
    expect(await s.readTextFile({ path: 'nope.txt' })).toBeNull();
    expect(await s.readFile({ path: 'nope.txt' })).toBeNull();
    await expect(s.readBinaryFile({ path: 'a' })).rejects.toThrow(/is a directory/);
  });

  it('spawns, streams output and kills', async () => {
    const s = (await createKosa8NetworkSandboxSession({ client, workingDirectory: work })).restricted();
    const p = await s.spawn({ command: 'echo started; sleep 30; echo never' });
    const reader = p.stdout.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe('started\n');
    const t0 = Date.now();
    await p.kill();
    const { exitCode } = await p.wait();
    expect(exitCode).not.toBe(0);
    expect(Date.now() - t0).toBeLessThan(10_000);
  });

  it('kills on abort and rejects wait with the reason', async () => {
    const s = (await createKosa8NetworkSandboxSession({ client, workingDirectory: work })).restricted();
    const ctl = new AbortController();
    const p = await s.spawn({ command: 'sleep 30', abortSignal: ctl.signal });
    setTimeout(() => ctl.abort(new Error('stop now')), 200);
    await expect(p.wait()).rejects.toThrow('stop now');
  });

  it('restricted() exposes only the tool-safe surface', async () => {
    const s = await createKosa8NetworkSandboxSession({ client, workingDirectory: work });
    const r = s.restricted() as unknown as Record<string, unknown>;
    expect(Object.keys(r).sort()).toEqual(
      ['description', 'readBinaryFile', 'readFile', 'readTextFile', 'run', 'spawn', 'writeBinaryFile', 'writeFile', 'writeTextFile'].sort(),
    );
    expect(r.stop).toBeUndefined();
    expect(r.setNetworkPolicy).toBeUndefined();
    expect(r.target).toBeUndefined();
    expect(Object.isFrozen(r)).toBe(true);
  });

  it('is honest about ports and live network policy changes', async () => {
    const s = await createKosa8NetworkSandboxSession({ client, workingDirectory: work, networkPolicy: { mode: 'deny-all' } });
    expect(s.ports).toEqual([]);
    await expect(s.getPortEndpoint({ port: 3000 })).rejects.toBeInstanceOf(HarnessCapabilityUnsupportedError);
    await expect(s.setPorts!([3000])).rejects.toBeInstanceOf(HarnessCapabilityUnsupportedError);
    await s.setNetworkPolicy!({ mode: 'deny-all' }); // already in force: no-op
    await expect(s.setNetworkPolicy!({ mode: 'allow-all' })).rejects.toThrow(/fixes a sandbox's egress policy/);
    expect((s as unknown as Record<string, unknown>).setRequestTransformations).toBeUndefined();
  });

  it('stop() snapshots and stops; resume restores under the same name; destroy() deletes', async () => {
    const s = await createKosa8NetworkSandboxSession({ client, sandboxId: 'keep', workingDirectory: work });
    await s.stop();
    expect(state.snapshots.has('keep-aisdk-resume')).toBe(true);
    expect(state.sandboxes.get('keep')!.state).toBe('stopped');
    const again = await resumeKosa8NetworkSandboxSession({ client, sandboxId: 'keep', workingDirectory: work });
    expect(again.id).toBe('keep');
    expect(again.containerId).toBe('c-r-keep');
    expect(state.snapshots.has('keep-aisdk-resume')).toBe(false);
    await again.destroy();
    expect(state.sandboxes.has('keep')).toBe(false);
    await expect(resumeKosa8NetworkSandboxSession({ client, sandboxId: 'keep' })).rejects.toThrow(/no kosa8 sandbox named "keep"/);
  });

  it('captures a template once and restores it afterwards', async () => {
    let prepared = 0;
    const template = {
      identity: 'claude-code@1',
      prepare: async ({ session }: { session: { run: (o: { command: string }) => PromiseLike<unknown> } }) => {
        prepared++;
        await session.run({ command: 'true' });
      },
    };
    const a = await createKosa8NetworkSandboxSession({ client, workingDirectory: work, template });
    const b = await createKosa8NetworkSandboxSession({ client, workingDirectory: work, template, sandboxId: 'from-tpl' });
    expect(prepared).toBe(1);
    expect([...state.snapshots].filter((x) => x.startsWith('aisdk-tpl-'))).toHaveLength(1);
    expect(b.id).toBe('from-tpl');
    expect(d.find('POST', '/kosa8/v1/snapshots/').length).toBe(1);
    expect(a.id).not.toBe(b.id);
  });

  it('deletes the sandbox when setup fails', async () => {
    await expect(
      createKosa8NetworkSandboxSession({ client, sandboxId: 'bad', workingDirectory: work, setupCommands: ['exit 3'] }),
    ).rejects.toThrow(/setupCommand failed \(exit 3\)/);
    expect(state.sandboxes.has('bad')).toBe(false);
  });
});

describe('createKosa8Sandbox (provider shape)', () => {
  it('names sandboxes from the sessionId and resumes them', async () => {
    const provider = createKosa8Sandbox({ client, workingDirectory: work });
    expect(provider.specificationVersion).toBe('harness-sandbox-v1');
    expect(provider.providerId).toBe('kosa8-sandbox');
    const s = await provider.createSession({ sessionId: 'Chat 42' });
    expect(s.id).toBe(sandboxNameForSession('Chat 42'));
    expect(s.id).toMatch(/^aisdk-chat-42-[0-9a-f]{10}$/);
    const r = await provider.resumeSession!({ sessionId: 'Chat 42' });
    expect(r.id).toBe(s.id);
    let hook = 0;
    await provider.createSession({ onFirstCreate: async () => void hook++ });
    expect(hook).toBe(1);
  });
});

describe('Vercel AI SDK 7 wiring (scripted model, no API key)', () => {
  it('runs generateText tools through the restricted session', async () => {
    const { runScriptedAgent } = await import('../../../examples/scripted-agent.js');
    const s = await createKosa8NetworkSandboxSession({ client, workingDirectory: work });
    const result = await runScriptedAgent(s.restricted());
    expect(result.text).toBe('Done: wrote notes/hello.txt and read it back.');
    const shell = result.steps.flatMap((st) => st.toolResults).find((r) => r.toolName === 'shell');
    const out = shell!.output as { exitCode: number; stdout: string };
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain('hello from the agent');
    expect(fs.readFileSync(path.join(work, 'notes/hello.txt'), 'utf8')).toBe('hello from the agent\n');
  });
});

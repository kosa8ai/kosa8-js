import { HarnessCapabilityUnsupportedError } from '@ai-sdk/harness';
import { afterAll, describe, expect, it } from 'vitest';
import { Kosa8Client, MemoryCheckpointStore } from '@kosa8/sdk';
import {
  createKosa8NetworkSandboxSession,
  resumeKosa8NetworkSandboxSession,
  type Kosa8NetworkSandboxSession,
} from '@kosa8/ai-sdk-sandbox';
import { runScriptedAgent } from '../examples/scripted-agent.js';

const client = new Kosa8Client({ checkpointStore: new MemoryCheckpointStore() });
const name = `aiit-${Date.now().toString(36)}`;
let session: Kosa8NetworkSandboxSession;

afterAll(async () => {
  await session?.destroy().catch(() => undefined);
  await client.deleteSandbox(name).catch(() => undefined);
  await client.deleteSnapshot(`${name}-aisdk-resume`).catch(() => undefined);
});

describe('@kosa8/ai-sdk-sandbox against a real daemon', () => {
  it('creates a session with a deny-all network policy', async () => {
    session = await createKosa8NetworkSandboxSession({ client, sandboxId: name, networkPolicy: { mode: 'deny-all' } });
    expect(session.id).toBe(name);
    expect(session.defaultWorkingDirectory).toBe('/workspace');
    expect((await client.getSandbox(name))?.egress).toBe('deny');
    expect(session.description).toMatch(/no network access/);
  });

  it('runs commands with cwd and env', async () => {
    const s = session.restricted();
    const r = await s.run({ command: 'pwd; echo "$GREETING"; echo e >&2; exit 5', env: { GREETING: 'hi there' } });
    expect(r).toEqual({ exitCode: 5, stdout: '/workspace\nhi there\n', stderr: 'e\n' });
  });

  it('writes and reads files, text and binary', async () => {
    const s = session.restricted();
    await s.writeTextFile({ path: 'dir/a.txt', content: 'line1\nline2\nline3\n' });
    expect(await s.readTextFile({ path: '/workspace/dir/a.txt' })).toBe('line1\nline2\nline3\n');
    expect(await s.readTextFile({ path: 'dir/a.txt', startLine: 2, endLine: 3 })).toBe('line2\nline3');
    const bin = new Uint8Array(200_000).map((_, i) => (i * 31) % 256);
    await s.writeBinaryFile({ path: 'blob.bin', content: bin });
    const back = await s.readBinaryFile({ path: 'blob.bin' });
    expect(Buffer.compare(Buffer.from(back!), Buffer.from(bin))).toBe(0);
    expect(await s.readFile({ path: 'missing.txt' })).toBeNull();
  });

  it('spawns, streams and kills', async () => {
    const s = session.restricted();
    const p = await s.spawn({ command: 'echo ready; sleep 300' });
    const reader = p.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('ready\n');
    await p.kill();
    const { exitCode } = await p.wait();
    expect(exitCode).not.toBe(0);
    expect((await s.run({ command: 'pgrep -f "slee[p] 300" || echo none' })).stdout.trim()).toBe('none');
  });

  it('refuses honestly what kosa8 cannot do', async () => {
    await session.setNetworkPolicy!({ mode: 'deny-all' });
    await expect(session.setNetworkPolicy!({ mode: 'allow-all' })).rejects.toBeInstanceOf(HarnessCapabilityUnsupportedError);
    await expect(session.getPortEndpoint({ port: 8080 })).rejects.toBeInstanceOf(HarnessCapabilityUnsupportedError);
  });

  it('runs a Vercel AI SDK 7 generateText loop (scripted model, no API key)', async () => {
    const result = await runScriptedAgent(session.restricted());
    expect(result.text).toBe('Done: wrote notes/hello.txt and read it back.');
    const shell = result.steps.flatMap((st) => st.toolResults).find((r) => r.toolName === 'shell');
    const out = shell!.output as { exitCode: number; stdout: string };
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toBe('21\nhello from the agent\nLinux\n');
  });

  it('stop() keeps the machine; resume brings back its files', async () => {
    await session.stop();
    expect((await client.getSandbox(name))?.state).toBe('stopped');
    session = await resumeKosa8NetworkSandboxSession({ client, sandboxId: name });
    expect(await session.restricted().readTextFile({ path: 'notes/hello.txt' })).toBe('hello from the agent\n');
  });

  it('destroy() deletes the sandbox', async () => {
    await session.destroy();
    expect(await client.getSandbox(name)).toBeUndefined();
  });
});

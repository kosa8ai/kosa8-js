/**
 * Live check of @kosa8/ai-sdk-sandbox against real kosa8 Cloud: it creates a
 * sandbox, runs the Experimental_SandboxSession contract against it (commands,
 * a command longer than the 90 s buffered-exec limit, abort and kill, files
 * small and over 8 MiB, inside and outside /workspace), drives an AI SDK
 * generateText tool loop with a scripted model, puts the sandbox to sleep,
 * resumes it, and deletes everything it made, also on failure.
 *
 *   KOSA8_API_KEY=k8c_live_... npx tsx examples/cloud-live-check.ts
 *
 * Set SKIP_LONG=1 to leave out the 95 s command.
 */
import { createHash, randomBytes } from 'node:crypto';
import { Kosa8Cloud } from '@kosa8/sdk';
import {
  createKosa8CloudSandboxSession,
  resumeKosa8CloudSandboxSession,
} from '@kosa8/ai-sdk-sandbox';
import { runScriptedAgent } from './scripted-agent.js';

const cloud = new Kosa8Cloud();
const name = `aisdk-live-${Date.now().toString(36)}`;
const made = new Set<string>();
let failures = 0;

function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` - ${detail}` : ''}`);
  if (!ok) failures++;
}

async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const t = Date.now();
  const v = await fn();
  return [v, Date.now() - t];
}

async function main(): Promise<void> {
  const [session, createMs] = await timed(() =>
    createKosa8CloudSandboxSession({ cloud, sandboxId: name, ttlS: 1800, env: { SESSION_VAR: 'from-session' } }),
  );
  made.add(session.id);
  console.log(`created ${session.id} (${name}) in ${createMs} ms`);
  console.log(session.description.split('\n').map((l) => `  | ${l}`).join('\n'));
  const s = session.restricted();

  // Commands
  const [hi, hiMs] = await timed(() => s.run({ command: 'echo hi && uname -a' }));
  console.log(`  echo hi && uname -a (${hiMs} ms):\n    ${hi.stdout.trim().split('\n').join('\n    ')}`);
  check('run: echo hi && uname -a', hi.exitCode === 0 && hi.stdout.startsWith('hi\nLinux '));
  const mixed = await s.run({ command: 'pwd; echo "$SESSION_VAR $CALL_VAR"; echo oops >&2; exit 7', env: { CALL_VAR: 'from-call' } });
  check(
    'run: cwd, env, stderr apart, exit code',
    mixed.exitCode === 7 && mixed.stdout === '/workspace\nfrom-session from-call\n' && mixed.stderr === 'oops\n',
    JSON.stringify(mixed),
  );
  const sub = await s.run({ command: 'mkdir -p sub && cd sub && pwd' });
  const inSub = await s.run({ command: 'pwd', workingDirectory: 'sub' });
  check('run: relative workingDirectory', sub.exitCode === 0 && inSub.stdout === '/workspace/sub\n', inSub.stdout.trim());
  const big = await s.run({ command: `echo ${'x'.repeat(70_000)} | wc -c` });
  check('run: a 70 KB command (staged as a file)', big.stdout.trim() === '70001', big.stdout.trim() || big.stderr);
  const lots = await s.run({ command: 'seq 1 200000' });
  check('run: 1.3 MB of stdout', lots.stdout.length === 1_288_895 && lots.stdout.endsWith('200000\n'), `${lots.stdout.length} chars`);

  // Streaming spawn
  const p = await s.spawn({ command: 'for i in 1 2 3; do echo line$i; sleep 1; done' });
  const reader = p.stdout.getReader();
  const firstAt = Date.now();
  const first = await reader.read();
  const firstMs = Date.now() - firstAt;
  let rest = '';
  for (let r = await reader.read(); !r.done; r = await reader.read()) rest += new TextDecoder().decode(r.value);
  const pw = await p.wait();
  check(
    'spawn: stdout streams before exit',
    new TextDecoder().decode(first.value).startsWith('line1') && firstMs < 2500 && pw.exitCode === 0 && rest.includes('line3'),
    `first chunk after ${firstMs} ms`,
  );

  // Longer than a buffered exec may run
  if (!process.env.SKIP_LONG) {
    const [long, longMs] = await timed(() => s.run({ command: 'sleep 95; echo done' }));
    check('run: sleep 95; echo done (past the 90 s buffered-exec limit)', long.exitCode === 0 && long.stdout === 'done\n', `${(longMs / 1000).toFixed(1)} s`);
  }

  // Abort and kill
  const ctl = new AbortController();
  const ab = await s.spawn({ command: 'i=0; while :; do i=$((i+1)); echo $i > /workspace/beat; sleep 1; done', abortSignal: ctl.signal });
  await new Promise((r) => setTimeout(r, 2500));
  ctl.abort(new Error('caller gave up'));
  const abErr = await ab.wait().then(() => null, (e: Error) => e);
  const b1 = (await s.readTextFile({ path: 'beat' }))?.trim();
  await new Promise((r) => setTimeout(r, 2500));
  const b2 = (await s.readTextFile({ path: 'beat' }))?.trim();
  check('spawn: abortSignal stops the command; wait() rejects with the reason', abErr?.message === 'caller gave up' && b1 === b2, `beat ${b1} -> ${b2}`);
  const k = await s.spawn({ command: 'sleep 300' });
  const [, killMs] = await timed(() => k.kill());
  const kw = await k.wait();
  check('spawn: kill() ends it', kw.exitCode === 143 || kw.exitCode === 137, `exit ${kw.exitCode} in ${killMs} ms`);

  // Files
  await s.writeTextFile({ path: 'notes/a.txt', content: 'line1\nline2\nline3\n' });
  check('files: write + read text (nested, relative)', (await s.readTextFile({ path: '/workspace/notes/a.txt' })) === 'line1\nline2\nline3\n');
  check('files: line range', (await s.readTextFile({ path: 'notes/a.txt', startLine: 2, endLine: 3 })) === 'line2\nline3');
  check('files: missing file reads as null', (await s.readTextFile({ path: 'nope.txt' })) === null);
  check('files: a directory throws', await s.readTextFile({ path: 'notes' }).then(() => false, () => true));
  await s.writeTextFile({ path: '/tmp/outside/b.txt', content: 'outside /workspace' });
  check('files: outside /workspace', (await s.readTextFile({ path: '/tmp/outside/b.txt' })) === 'outside /workspace');
  const blob = randomBytes(9 * 1024 * 1024 + 123);
  const [, upMs] = await timed(() => s.writeBinaryFile({ path: 'big.bin', content: blob }));
  const [back, downMs] = await timed(() => s.readBinaryFile({ path: 'big.bin' }));
  const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
  const shaIn = await s.run({ command: 'sha256sum big.bin | cut -d" " -f1' });
  check(
    'files: 9 MiB binary round trip (over the 8 MiB files-API limit)',
    back !== null && sha(back) === sha(blob) && shaIn.stdout.trim() === sha(blob),
    `up ${upMs} ms, down ${downMs} ms`,
  );
  await s.writeFile({
    path: 'streamed.txt',
    content: new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('one,'));
        c.enqueue(new TextEncoder().encode('two'));
        c.close();
      },
    }),
  });
  const rs = await s.readFile({ path: 'streamed.txt' });
  check('files: writeFile/readFile streams', rs !== null && (await new Response(rs).text()) === 'one,two');
  await s.writeTextFile({ path: 'empty.txt', content: '' });
  check('files: empty file', (await s.readTextFile({ path: 'empty.txt' })) === '');
  const left = await s.run({ command: 'ls -A /workspace/.kosa8-run | grep -e "^up-" -e "^dl-" -e "^cmd-"; true' });
  check('files: no staged parts left behind', left.stdout.trim() === '', left.stdout.trim().split('\n').join(' '));

  // AI SDK tool loop
  const result = await runScriptedAgent(s);
  const shell = result.steps.flatMap((st) => st.toolResults).find((r) => r.toolName === 'shell');
  const out = (shell?.output ?? {}) as { stdout?: string };
  check('generateText: scripted tool loop with experimental_sandbox', out.stdout?.includes('hello from the agent') === true && result.text.startsWith('Done'), JSON.stringify(out));

  // Network policy
  await session.setNetworkPolicy({ mode: 'deny-all' });
  const denied = await s.run({ command: 'wget -q -T 5 -O /dev/null https://example.com && echo reached || echo refused' });
  await session.setNetworkPolicy({ mode: 'allow-all' });
  const allowed = await s.run({ command: 'wget -q -T 10 -O /dev/null https://example.com && echo reached || echo refused' });
  check('setNetworkPolicy: deny-all then allow-all', denied.stdout.trim() === 'refused' && allowed.stdout.trim() === 'reached', `${denied.stdout.trim()} / ${allowed.stdout.trim()}`);

  // Sleep and resume
  await s.writeTextFile({ path: 'keep.txt', content: 'still here' });
  const [, stopMs] = await timed(() => session.stop());
  const slept = await cloud.sandboxes.get(session.id);
  check('stop(): the sandbox sleeps', slept.state === 'sleeping', `${slept.state} after ${stopMs} ms`);
  const [resumed, resumeMs] = await timed(() => resumeKosa8CloudSandboxSession({ cloud, sandboxId: name }));
  check('resume by name: wakes it, files kept', resumed.id === session.id && (await resumed.restricted().readTextFile({ path: 'keep.txt' })) === 'still here', `${resumeMs} ms`);
  await resumed.destroy();
  made.delete(session.id);
  const gone = await cloud.sandboxes.get(session.id).then((b) => b.state, () => 'not found');
  check('destroy(): deleted', gone === 'deleted' || gone === 'not found', gone);
}

async function cleanup(): Promise<void> {
  for (const id of made) {
    await cloud.sandboxes.get(id).then((b) => b.delete()).catch(() => undefined);
    console.log(`cleanup: deleted ${id}`);
  }
  const live = (await cloud.sandboxes.list()).filter((b) => b.info.name?.startsWith('aisdk-live-') && b.state !== 'deleted');
  for (const b of live) await b.delete().catch(() => undefined);
  const after = (await cloud.sandboxes.list()).filter((b) => b.info.name?.startsWith('aisdk-live-') && b.state !== 'deleted');
  check('GET /v1/sandboxes: none of ours remain', after.length === 0, after.map((b) => b.id).join(', ') || 'none');
}

main()
  .catch((err) => {
    failures++;
    console.error('FAIL', err);
  })
  .finally(async () => {
    await cleanup().catch((e) => console.error('cleanup failed', e));
    console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
    process.exit(failures ? 1 : 0);
  });


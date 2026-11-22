/**
 * Best-of-n with kosa8 Cloud fork: set a sandbox up once (here: the tests),
 * fork it n times, let an agent attempt the task in each copy in parallel,
 * grade every copy the same way and keep the best answer. Each fork starts
 * from the parent's exact state, and every sandbox is deleted at the end.
 *
 *   KOSA8_API_KEY=k8c_live_... AI_GATEWAY_API_KEY=... npx tsx best-of-n.ts
 *
 * Without AI_GATEWAY_API_KEY each attempt is a different scripted stand-in model.
 */
import { createKosa8CloudSandboxSession, createKosa8CloudSandboxSessionFromSandbox } from '@kosa8/ai-sdk-sandbox';
import { Kosa8Cloud } from '@kosa8/sdk';
import { generateText, stepCountIs } from 'ai';
import { noteModel, pickModel } from './model.js';
import { tools } from './tools.js';

const N = 3;
const TASK =
  'Write /workspace/median.mjs exporting median(xs) for an array of numbers (the mean of the two middle ' +
  'values for an even length; do not mutate the input). Tests are in median.test.mjs; run `node --test`.';

// Three stand-in attempts: one wrong for even lengths, one that sorts as strings, one right.
const ATTEMPTS = [
  'export const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];\n',
  'export function median(xs) {\n  const s = [...xs].sort();\n  const m = s.length >> 1;\n  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;\n}\n',
  'export function median(xs) {\n  const s = [...xs].sort((a, b) => a - b);\n  const m = s.length >> 1;\n  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;\n}\n',
];
const script = (code: string) => [
  { tool: 'writeFile', input: { path: 'median.mjs', content: code } },
  { tool: 'shell', input: { command: 'node --test --test-reporter=tap 2>&1 | grep -E "^# (pass|fail)"' } },
  { text: 'done' },
];

const TESTS = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { median } from './median.mjs';
test('odd', () => assert.equal(median([3, 1, 2]), 2));
test('even', () => assert.equal(median([4, 1, 3, 2]), 2.5));
test('numeric order', () => assert.equal(median([10, 9, 100]), 10));
test('pure', () => { const xs = [3, 1, 2]; median(xs); assert.deepEqual(xs, [3, 1, 2]); });
`;

noteModel();
const cloud = new Kosa8Cloud(); // reads KOSA8_API_KEY
const base = await createKosa8CloudSandboxSession({
  cloud,
  template: 'node',
  ttlS: 900,
  networkPolicy: { mode: 'deny-all' },
  labels: { example: 'best-of-n' },
});
console.log(`[base] ${base.id}`);

try {
  await base.restricted().writeTextFile({ path: 'median.test.mjs', content: TESTS });

  // One fork per attempt, all at once; forkMap deletes every child when its attempt ends.
  const results = await cloud.forkMap(
    base.sandbox,
    async (child, i) => {
      const session = await createKosa8CloudSandboxSessionFromSandbox({ cloud, sandbox: child });
      const sandbox = session.restricted();
      await generateText({
        model: pickModel(script(ATTEMPTS[i]!)),
        temperature: 1, // with a real model: n different tries at the same task
        stopWhen: stepCountIs(10),
        system: `You are a coding agent. Work only through your tools.\n\nSandbox:\n${sandbox.description}`,
        prompt: TASK,
        experimental_sandbox: sandbox,
        tools,
      });
      // Grade every attempt the same way, whatever the agent claimed.
      const tap = await sandbox.run({ command: 'node --test --test-reporter=tap 2>&1' });
      const passed = Number(/^# pass (\d+)/m.exec(tap.stdout)?.[1] ?? 0);
      return { passed, code: (await sandbox.readTextFile({ path: 'median.mjs' })) ?? '' };
    },
    Array.from({ length: N }, (_, i) => i),
    { concurrency: N, labels: { example: 'best-of-n' }, timeoutMs: 5 * 60_000 },
  );

  for (const r of results) {
    console.log(`[attempt ${r.item}] ${r.sandboxId}: ${r.ok ? `${r.value!.passed}/4 tests pass` : `failed (${r.failureClass})`} in ${r.ms} ms`);
  }
  const best = results.filter((r) => r.ok).sort((a, b) => b.value!.passed - a.value!.passed)[0];
  if (best) console.log(`[best] attempt ${best.item}, ${best.value!.passed}/4:\n${best.value!.code}`);
} finally {
  await base.destroy();
  console.log(`[base] ${base.id} deleted`);
}

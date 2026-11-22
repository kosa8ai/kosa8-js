/**
 * A Vercel AI SDK 7 coding agent whose shell and files live in a kosa8 Cloud
 * sandbox: it writes a function and its tests, runs them, fixes the bug the
 * tests find, and the sandbox is deleted at the end.
 *
 *   KOSA8_API_KEY=k8c_live_... AI_GATEWAY_API_KEY=... npx tsx agent.ts
 *
 * Without AI_GATEWAY_API_KEY a scripted stand-in model drives the same tools.
 */
import { createKosa8CloudSandboxSession } from '@kosa8/ai-sdk-sandbox';
import { generateText, stepCountIs } from 'ai';
import { noteModel, pickModel } from './model.js';
import { tools } from './tools.js';

const TASK =
  'In /workspace, write slugify.mjs exporting slugify(s): lower-case, ASCII letters and digits, ' +
  'words joined by single "-", no leading or trailing "-". Write slugify.test.mjs with node:test, ' +
  'run `node --test`, and fix the code until the tests pass. Reply with a one-line summary.';

// What the stand-in model does: a first try with a bug, the tests catch it, an edit fixes it.
const SCRIPT = [
  { tool: 'writeFile', input: { path: 'slugify.mjs', content: "export const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-');\n" } },
  {
    tool: 'writeFile',
    input: {
      path: 'slugify.test.mjs',
      content: [
        "import { test } from 'node:test';",
        "import assert from 'node:assert/strict';",
        "import { slugify } from './slugify.mjs';",
        "test('words', () => assert.equal(slugify('Hello, World'), 'hello-world'));",
        "test('edges', () => assert.equal(slugify('  --Agents in a microVM!-- '), 'agents-in-a-microvm'));",
        '',
      ].join('\n'),
    },
  },
  { tool: 'shell', input: { command: 'node --test --test-reporter=tap 2>&1 | grep -E "^# (pass|fail)"' } },
  { tool: 'editFile', input: { path: 'slugify.mjs', oldText: "'-');", newText: "'-').replace(/^-+|-+$/g, '');" } },
  { tool: 'shell', input: { command: 'node --test --test-reporter=tap 2>&1 | grep -E "^# (pass|fail)"; cat slugify.mjs' } },
  { text: 'slugify.mjs written; it trimmed edge dashes after the first test run failed, and both tests pass.' },
];

noteModel();

// Reads KOSA8_API_KEY. The node template has Node.js; this task needs no network, so none is allowed.
const session = await createKosa8CloudSandboxSession({
  template: 'node',
  ttlS: 900, // deleted in 15 minutes even if this process dies
  networkPolicy: { mode: 'deny-all' },
  labels: { example: 'vercel-ai-sdk' },
  commandTimeoutS: 120, // kosa8 Cloud stops any one command after 2 minutes
});
console.log(`[sandbox] ${session.id}`);

try {
  const sandbox = session.restricted(); // files, run and spawn only: tools cannot stop it or open its network
  const result = await generateText({
    model: pickModel(SCRIPT),
    stopWhen: stepCountIs(15),
    system: `You are a careful coding agent. Work only through your tools.\n\nSandbox:\n${sandbox.description}`,
    prompt: TASK,
    experimental_sandbox: sandbox,
    tools,
  });
  console.log(`[agent] ${result.text} (${result.steps.length} steps)`);
} finally {
  await session.destroy();
  console.log(`[sandbox] ${session.id} deleted`);
}

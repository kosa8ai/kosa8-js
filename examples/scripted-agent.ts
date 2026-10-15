/**
 * A Vercel AI SDK 7 agent loop whose tools run in a kosa8 sandbox, driven by
 * a scripted model (MockLanguageModelV4) so it needs no API key.
 *
 *   npx tsx examples/scripted-agent.ts
 *
 * Requires kosa8 installed with its daemon running.
 */
import { generateText, stepCountIs, tool, type Experimental_SandboxSession } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import { createKosa8NetworkSandboxSession } from '@kosa8/ai-sdk-sandbox';

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

function toolCall(id: string, toolName: string, input: unknown) {
  return {
    content: [{ type: 'tool-call' as const, toolCallId: id, toolName, input: JSON.stringify(input) }],
    finishReason: { unified: 'tool-calls' as const, raw: undefined },
    usage,
    warnings: [],
  };
}

/** The tools an agent would get: they act only through the sandbox they are handed. */
export const tools = {
  writeFile: tool({
    description: 'Write a text file in the sandbox.',
    inputSchema: z.object({ path: z.string(), content: z.string() }),
    execute: async ({ path, content }, { experimental_sandbox: sandbox, abortSignal }) => {
      if (!sandbox) throw new Error('no sandbox');
      await sandbox.writeTextFile({ path, content, abortSignal });
      return { written: path };
    },
  }),
  shell: tool({
    description: 'Run a shell command in the sandbox.',
    inputSchema: z.object({ command: z.string() }),
    execute: async ({ command }, { experimental_sandbox: sandbox, abortSignal }) => {
      if (!sandbox) throw new Error('no sandbox');
      return sandbox.run({ command, abortSignal });
    },
  }),
};

/** Run the scripted loop: write a file, run a command over it, answer. */
export async function runScriptedAgent(sandbox: Experimental_SandboxSession) {
  const model = new MockLanguageModelV4({
    doGenerate: [
      toolCall('call-1', 'writeFile', { path: 'notes/hello.txt', content: 'hello from the agent\n' }),
      toolCall('call-2', 'shell', { command: 'wc -c < notes/hello.txt; cat notes/hello.txt; uname -s' }),
      {
        content: [{ type: 'text' as const, text: 'Done: wrote notes/hello.txt and read it back.' }],
        finishReason: { unified: 'stop' as const, raw: undefined },
        usage,
        warnings: [],
      },
    ],
  });
  return generateText({
    model,
    tools,
    stopWhen: stepCountIs(5),
    prompt: `Write a note and check it.\n\nSandbox:\n${sandbox.description}`,
    experimental_sandbox: sandbox,
  });
}

async function main() {
  const session = await createKosa8NetworkSandboxSession({
    networkPolicy: { mode: 'deny-all' },
  });
  try {
    const result = await runScriptedAgent(session.restricted());
    for (const step of result.steps) {
      for (const r of step.toolResults) console.log(`${r.toolName} ->`, JSON.stringify(r.output));
    }
    console.log(result.text);
  } finally {
    await session.destroy();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

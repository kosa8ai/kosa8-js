/** Tools that act only through the sandbox the AI SDK hands them (`experimental_sandbox`). */
import { tool } from 'ai';
import { z } from 'zod';

export const tools = {
  shell: tool({
    description: 'Run a shell command in the sandbox (cwd /workspace). Returns stdout, stderr and exitCode.',
    inputSchema: z.object({ command: z.string() }),
    execute: async ({ command }, { experimental_sandbox: sandbox, abortSignal }) => {
      const r = await sandbox!.run({ command, abortSignal });
      console.log(`  $ ${command}\n${indent(r.stdout + r.stderr)}  [exit ${r.exitCode}]`);
      return r;
    },
  }),
  readFile: tool({
    description: 'Read a text file in the sandbox.',
    inputSchema: z.object({ path: z.string() }),
    execute: async ({ path }, { experimental_sandbox: sandbox, abortSignal }) =>
      (await sandbox!.readTextFile({ path, abortSignal })) ?? `no such file: ${path}`,
  }),
  writeFile: tool({
    description: 'Create or overwrite a text file in the sandbox.',
    inputSchema: z.object({ path: z.string(), content: z.string() }),
    execute: async ({ path, content }, { experimental_sandbox: sandbox, abortSignal }) => {
      await sandbox!.writeTextFile({ path, content, abortSignal });
      console.log(`  wrote ${path} (${content.length} chars)`);
      return { written: path };
    },
  }),
  editFile: tool({
    description: 'Replace one exact occurrence of oldText with newText in a sandbox file.',
    inputSchema: z.object({ path: z.string(), oldText: z.string(), newText: z.string() }),
    execute: async ({ path, oldText, newText }, { experimental_sandbox: sandbox, abortSignal }) => {
      const text = await sandbox!.readTextFile({ path, abortSignal });
      if (text === null) return { error: `no such file: ${path}` };
      if (text.split(oldText).length !== 2) return { error: 'oldText must occur exactly once' };
      await sandbox!.writeTextFile({ path, content: text.replace(oldText, () => newText), abortSignal });
      console.log(`  edited ${path}`);
      return { edited: path };
    },
  }),
};

function indent(s: string): string {
  return s.trim() ? s.trimEnd().split('\n').map((l) => `    ${l}\n`).join('') : '';
}

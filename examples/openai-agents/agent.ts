/**
 * An OpenAI Agents SDK agent whose tools (run_command, read_file, write_file)
 * execute in a kosa8 Cloud sandbox: one sandbox per run, labelled, with
 * timeouts at every level, network closed except an allow-list, and deleted
 * in `finally`.
 *
 *   KOSA8_API_KEY=k8c_live_... OPENAI_API_KEY=sk-... npx tsx agent.ts
 *
 * Without OPENAI_API_KEY (or with KOSA8_EXAMPLE_FAKE_MODEL=1) a scripted
 * stand-in Model replays fixed tool calls, so the sandbox side runs for real.
 */
import { Agent, Runner, Usage, tool, type Model, type ModelRequest, type ModelResponse, type RunContext } from '@openai/agents';
import { Kosa8Cloud, type CloudSandbox } from '@kosa8/sdk';
import { z } from 'zod';

type Ctx = { box: CloudSandbox };
const box = (rc?: RunContext<Ctx>) => rc!.context.box;

// --- tools: each one acts only on the sandbox of the current run ---------------

const CommandArgs = z.object({ command: z.string() });
const PathArgs = z.object({ path: z.string() });
const WriteArgs = z.object({ path: z.string(), content: z.string() });

const runCommand = tool<typeof CommandArgs, Ctx>({
  name: 'run_command',
  description: 'Run a shell command in the sandbox (cwd /workspace). Returns exit code, stdout and stderr.',
  parameters: CommandArgs,
  timeoutMs: 100_000, // the Agents SDK gives up on the tool call after this
  execute: async ({ command }, rc) => {
    // kosa8 Cloud stops the command after timeoutS (a buffered exec runs at most 90 s).
    const r = await box(rc).exec(`cd /workspace && ${command}`, { timeoutS: 60 });
    console.log(`  $ ${command}\n${indent(r.stdout + r.stderr)}  [exit ${r.exitCode}]`);
    return JSON.stringify({ exitCode: r.exitCode, stdout: r.stdout.slice(-8000), stderr: r.stderr.slice(-4000) });
  },
});

const readFile = tool<typeof PathArgs, Ctx>({
  name: 'read_file',
  description: 'Read a text file in the sandbox (under /workspace).',
  parameters: PathArgs,
  timeoutMs: 30_000,
  execute: async ({ path }, rc) => {
    const text = await box(rc).files.readText(abs(path));
    console.log(`  read ${abs(path)} (${text.length} chars)`);
    return text;
  },
});

const writeFile = tool<typeof WriteArgs, Ctx>({
  name: 'write_file',
  description: 'Create or overwrite a text file in the sandbox (under /workspace).',
  parameters: WriteArgs,
  timeoutMs: 30_000,
  execute: async ({ path, content }, rc) => {
    await box(rc).files.write(abs(path), content);
    console.log(`  wrote ${abs(path)} (${content.length} chars)`);
    return `wrote ${abs(path)}`;
  },
});

const agent = new Agent<Ctx>({
  name: 'Sandbox coder',
  instructions:
    'You are a coding agent with a Linux sandbox (Python 3, files under /workspace). ' +
    'Do the work with your tools, check it by running it, then answer in one short paragraph.',
  tools: [runCommand, readFile, writeFile],
});

// --- one sandbox per run ---------------------------------------------------------

const cloud = new Kosa8Cloud(); // reads KOSA8_API_KEY

export async function runInSandbox(task: string, runner: Runner): Promise<string | undefined> {
  const sandbox = await cloud.sandboxes.create({
    template: 'python',
    ttlS: 900, // deleted in 15 minutes even if this process dies
    labels: { example: 'openai-agents', run: `run-${Date.now().toString(36)}` },
    // Network closed by default; only these hosts are reachable (here: PyPI, for pip install).
    egress: { internet: false, allow: ['pypi.org', 'files.pythonhosted.org'] },
  });
  console.log(`[sandbox] ${sandbox.id} labels=${JSON.stringify(sandbox.info.labels ?? {})}`);
  try {
    const result = await runner.run(agent, task, { context: { box: sandbox }, maxTurns: 12 });
    return result.finalOutput;
  } finally {
    await sandbox.delete();
    console.log(`[sandbox] ${sandbox.id} deleted`);
  }
}

// --- a scripted stand-in model, used when there is no OpenAI key ------------------

type Step = { call: string; args: Record<string, unknown> } | { say: string };

/** Replays `steps`, one per model call (one run per instance). A real model would read `request.input`. */
class ScriptedModel implements Model {
  private turn = 0;
  constructor(private readonly steps: Step[]) {}

  async getResponse(_request: ModelRequest): Promise<ModelResponse> {
    const step = this.steps[Math.min(this.turn, this.steps.length - 1)]!;
    const n = this.turn++;
    return {
      usage: new Usage(),
      output: [
        'call' in step
          ? { type: 'function_call', callId: `call_${n}`, name: step.call, arguments: JSON.stringify(step.args), status: 'completed' }
          : { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: step.say }] },
      ],
    };
  }

  async *getStreamedResponse(): AsyncIterable<never> {
    throw new Error('the scripted model does not stream');
  }
}

const SCRIPT: Step[] = [
  {
    call: 'write_file',
    args: {
      path: 'wordfreq.py',
      content: [
        'import collections, re, sys',
        '',
        'def top_words(text, n=3):',
        '    words = re.findall(r"[a-z\']+", text.lower())',
        '    return collections.Counter(words).most_common(n)',
        '',
        'if __name__ == "__main__":',
        '    assert top_words("a b a c a b") == [("a", 3), ("b", 2), ("c", 1)]',
        '    print(top_words(sys.stdin.read()))',
        '',
      ].join('\n'),
    },
  },
  { call: 'run_command', args: { command: 'echo "the cat and the hat and the bat" | python3 wordfreq.py && uname -sm' } },
  { call: 'read_file', args: { path: 'wordfreq.py' } },
  {
    call: 'run_command',
    args: {
      command:
        'for u in https://pypi.org/simple/ https://example.com/; do python3 -c "import sys,urllib.request as r; r.urlopen(sys.argv[1], timeout=5); print(\'reachable\', sys.argv[1])" $u 2>/dev/null || echo "blocked   $u"; done',
    },
  },
  { say: 'wordfreq.py counts words; its self-test passed and the top three were the(3), and(2), cat(1). PyPI is reachable and everything else is blocked.' },
];

// --- main ----------------------------------------------------------------------

const fake = process.env.KOSA8_EXAMPLE_FAKE_MODEL === '1' || !process.env.OPENAI_API_KEY;
console.log(
  fake
    ? '[model] no OPENAI_API_KEY (or KOSA8_EXAMPLE_FAKE_MODEL=1): a scripted stand-in model drives the tools; the sandbox is real'
    : '[model] OpenAI (the Agents SDK default model, or OPENAI_DEFAULT_MODEL)',
);
const scripted = new ScriptedModel(SCRIPT);
const runner = fake
  ? new Runner({ modelProvider: { getModel: () => scripted }, tracingDisabled: true })
  : new Runner();

const answer = await runInSandbox(
  'Write wordfreq.py with top_words(text, n=3) returning the n most common words and a self-test, run it on ' +
    '"the cat and the hat and the bat", then check which of https://pypi.org and https://example.com the sandbox can reach.',
  runner,
);
console.log(`[agent] ${answer}`);

function abs(p: string): string {
  return p.startsWith('/') ? p : `/workspace/${p}`;
}
function indent(s: string): string {
  return s.trim() ? s.trimEnd().split('\n').map((l) => `    ${l}\n`).join('') : '';
}

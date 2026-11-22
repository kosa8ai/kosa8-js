/**
 * The model the examples use: a real one through the Vercel AI Gateway when
 * AI_GATEWAY_API_KEY is set, otherwise (or with KOSA8_EXAMPLE_FAKE_MODEL=1)
 * a scripted stand-in that replays fixed tool calls, so the sandbox side runs
 * for real with no model key.
 */
import type { LanguageModel } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';

type Step = { tool: string; input: unknown } | { text: string };

const usage = {
  inputTokens: { total: 0, noCache: 0, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 0, text: 0, reasoning: undefined },
};

export function useFakeModel(): boolean {
  return process.env.KOSA8_EXAMPLE_FAKE_MODEL === '1' || !process.env.AI_GATEWAY_API_KEY;
}

/** `script` is what the stand-in model does, one step per model call. */
export function pickModel(script: Step[]): LanguageModel {
  if (!useFakeModel()) return process.env.KOSA8_EXAMPLE_MODEL ?? 'anthropic/claude-sonnet-4.5';
  return new MockLanguageModelV4({
    doGenerate: script.map((step, i) =>
      'text' in step
        ? { content: [{ type: 'text' as const, text: step.text }], finishReason: { unified: 'stop' as const, raw: undefined }, usage, warnings: [] }
        : {
            content: [{ type: 'tool-call' as const, toolCallId: `call-${i}`, toolName: step.tool, input: JSON.stringify(step.input) }],
            finishReason: { unified: 'tool-calls' as const, raw: undefined },
            usage,
            warnings: [],
          },
    ),
  });
}

export function noteModel(): void {
  console.log(
    useFakeModel()
      ? '[model] no AI_GATEWAY_API_KEY (or KOSA8_EXAMPLE_FAKE_MODEL=1): a scripted stand-in model drives the tools; the sandbox is real'
      : `[model] ${process.env.KOSA8_EXAMPLE_MODEL ?? 'anthropic/claude-sonnet-4.5'} via the AI Gateway`,
  );
}

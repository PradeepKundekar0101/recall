import { env, has, llmKey } from "../env.js";
import { log } from "../log.js";
import { anthropicProvider } from "./llm/anthropic.js";
import { openaiProvider } from "./llm/openai.js";
import { geminiProvider } from "./llm/gemini.js";
import type { ChatMessage, LlmProviderApi, ToolSchema } from "./llm/types.js";

export type { ChatMessage, ToolSchema } from "./llm/types.js";
export { SentenceSplitter } from "./llm/types.js";

/**
 * Provider switch, plus the latency record the rehearsal checklist asserts on.
 */

const PROVIDERS: Record<string, LlmProviderApi> = {
  anthropic: anthropicProvider,
  openai: openaiProvider,
  gemini: geminiProvider,
};

function provider(): LlmProviderApi {
  if (!has.llm()) {
    throw new Error(`no API key for LLM_PROVIDER=${env.llmProvider} - cannot reach the model`);
  }
  const chosen = PROVIDERS[env.llmProvider];
  if (!chosen) throw new Error(`unknown LLM provider "${env.llmProvider}"`);
  void llmKey();
  return chosen;
}

/** Turn latencies, so the rehearsal checklist can assert a median under 800 ms. */
export const turnLatency: number[] = [];

export function latencyMedian(): number | null {
  if (!turnLatency.length) return null;
  const sorted = [...turnLatency].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

export function resetLatency(): void {
  turnLatency.length = 0;
}

export type ToolCallOptions<T> = {
  system: string;
  user: string;
  tool: ToolSchema;
  /** Returned when MOCK_VOICE=1, so the loop runs without a key. */
  mock: T;
  model?: string;
  maxTokens?: number;
};

export async function toolCall<T>(opts: ToolCallOptions<T>): Promise<{ value: T; ms: number }> {
  if (env.mockVoice) return { value: opts.mock, ms: 0 };

  const started = Date.now();
  try {
    const value = await provider().toolCall<T>({
      system: opts.system,
      user: opts.user,
      tool: opts.tool,
      model: opts.model ?? env.dialogueModel,
      // Classification-sized. A field patch is ~150 tokens out.
      maxTokens: opts.maxTokens ?? 512,
    });
    const ms = Date.now() - started;
    turnLatency.push(ms);
    return { value, ms };
  } catch (err) {
    log.error(`llm(${env.llmProvider}): ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
}

/**
 * Streams a spoken reply sentence by sentence.
 *
 * The caller hands each sentence to TTS as it completes rather than waiting for
 * the full turn, which is what keeps first-audio inside the budget on a long reply.
 * `signal` is the turn's abort signal: barge-in fires it and this stops mid-token.
 */
export async function* streamSentences(opts: {
  system: string;
  messages: ChatMessage[];
  model?: string;
  maxTokens?: number;
  signal?: AbortSignal;
}): AsyncGenerator<string> {
  if (env.mockVoice) {
    yield "Got it.";
    return;
  }
  yield* provider().streamSentences({
    system: opts.system,
    messages: opts.messages,
    model: opts.model ?? env.dialogueModel,
    maxTokens: opts.maxTokens ?? 256,
    signal: opts.signal,
  });
}

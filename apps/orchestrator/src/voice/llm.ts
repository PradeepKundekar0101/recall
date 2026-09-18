import Anthropic from "@anthropic-ai/sdk";
import { env, has } from "../env.js";
import { log } from "../log.js";

/**
 * The dialogue and classification model.
 *
 * Haiku 4.5 for both loops. On every customer turn the extractor and the escalation
 * classifier run in parallel, so the model choice is a latency decision before it is
 * a quality one - the budget is 250 ms to first token.
 *
 * Thinking is deliberately left off. Omitting the `thinking` parameter on Haiku 4.5
 * means no thinking, which is what a phone call needs; `output_config.effort` is not
 * accepted on this model at all, so it is absent rather than set low.
 *
 * Every structured call goes through a tool with `strict: true`, so the arguments
 * validate against the schema exactly and the engine never parses prose.
 */

let _client: Anthropic | null = null;

function client(): Anthropic {
  if (!has.llm()) throw new Error("LLM_API_KEY is not set - cannot reach the model");
  if (!_client) _client = new Anthropic({ apiKey: env.llmKey });
  return _client;
}

/** Turn latencies, so the rehearsal checklist can assert a median under 800 ms. */
export const turnLatency: number[] = [];

export function latencyMedian(): number | null {
  if (!turnLatency.length) return null;
  const sorted = [...turnLatency].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

export type ToolCallOptions<T> = {
  system: string;
  user: string;
  tool: Anthropic.Tool;
  /** Returned when MOCK_VOICE=1, so the loop runs without a key. */
  mock: T;
  model?: string;
  maxTokens?: number;
};

/**
 * One structured call, one tool result.
 *
 * Used by `engine/extract.ts` for the field patch and by `engine/escalation.ts` for
 * the per-turn classification. Both want a validated object and nothing else, so
 * the tool is declared strict and the response is read from the tool_use block
 * rather than from any text the model might also emit.
 */
export async function toolCall<T>(opts: ToolCallOptions<T>): Promise<{ value: T; ms: number }> {
  if (env.mockVoice) return { value: opts.mock, ms: 0 };

  const started = Date.now();
  try {
    const response = await client().messages.create({
      model: opts.model ?? env.dialogueModel,
      // Classification-sized. A field patch is ~150 tokens out.
      max_tokens: opts.maxTokens ?? 512,
      system: opts.system,
      tools: [{ ...opts.tool, strict: true }],
      tool_choice: { type: "tool", name: opts.tool.name },
      messages: [{ role: "user", content: opts.user }],
    });

    const block = response.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === opts.tool.name
    );
    if (!block) throw new Error(`model returned no ${opts.tool.name} tool call`);

    const ms = Date.now() - started;
    turnLatency.push(ms);
    return { value: block.input as T, ms };
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) {
      log.warn("llm: rate limited");
    } else if (err instanceof Anthropic.AuthenticationError) {
      log.error("llm: LLM_API_KEY rejected");
    } else if (err instanceof Anthropic.APIError) {
      log.error(`llm: API error ${err.status}: ${err.message}`);
    }
    throw err;
  }
}

/**
 * Streams a spoken reply sentence by sentence.
 *
 * The transport hands each sentence to TTS as it completes rather than waiting for
 * the full turn, which is what keeps first-audio inside the budget on a long reply.
 */
export async function* streamSentences(_opts: {
  system: string;
  messages: Anthropic.MessageParam[];
  model?: string;
}): AsyncGenerator<string> {
  if (env.mockVoice) {
    yield "Got it.";
    return;
  }
  // Build block P3: client().messages.stream(...), accumulate deltas, and yield on
  // sentence boundaries so TTS starts before the model has finished the turn.
  throw new Error("voice/llm.ts: sentence streaming not implemented yet (build block P3)");
}

import Anthropic from "@anthropic-ai/sdk";
import { env } from "../../env.js";
import { SentenceSplitter, type ChatMessage, type LlmProviderApi, type ToolSchema } from "./types.js";

/**
 * Claude Haiku 4.5.
 *
 * Thinking is left off by omitting the parameter, which on Haiku 4.5 means no
 * thinking - the right setting for a phone call. `output_config.effort` is not
 * accepted on this model at all, so it is absent rather than set low.
 */

let client: Anthropic | null = null;
function api(): Anthropic {
  if (!client) client = new Anthropic({ apiKey: env.anthropicKey });
  return client;
}

export const anthropicProvider: LlmProviderApi = {
  id: "anthropic",

  async toolCall<T>(opts: { system: string; user: string; tool: ToolSchema; model: string; maxTokens: number }) {
    const response = await api().messages.create({
      model: opts.model,
      max_tokens: opts.maxTokens,
      system: opts.system,
      tools: [
        {
          name: opts.tool.name,
          description: opts.tool.description,
          input_schema: opts.tool.parameters as Anthropic.Tool.InputSchema,
          // Guarantees the arguments validate against the schema exactly, so the
          // engine never parses prose out of a field patch.
          strict: true,
        },
      ],
      tool_choice: { type: "tool", name: opts.tool.name },
      messages: [{ role: "user", content: opts.user }],
    });

    const block = response.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === opts.tool.name
    );
    if (!block) throw new Error(`anthropic returned no ${opts.tool.name} tool call`);
    return block.input as T;
  },

  async *streamSentences(opts: {
    system: string;
    messages: ChatMessage[];
    model: string;
    maxTokens: number;
    signal?: AbortSignal;
  }) {
    const splitter = new SentenceSplitter();
    const stream = api().messages.stream(
      {
        model: opts.model,
        max_tokens: opts.maxTokens,
        system: opts.system,
        messages: opts.messages,
      },
      { signal: opts.signal }
    );

    for await (const event of stream) {
      if (opts.signal?.aborted) break;
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        for (const sentence of splitter.push(event.delta.text)) yield sentence;
      }
    }
    if (!opts.signal?.aborted) {
      const rest = splitter.flush();
      if (rest) yield rest;
    }
  },
};

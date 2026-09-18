import OpenAI from "openai";
import { env } from "../../env.js";
import { SentenceSplitter, type ChatMessage, type LlmProviderApi, type ToolSchema } from "./types.js";

/** GPT-4o-mini. Selected by LLM_PROVIDER=openai, or by being the only key set. */

let client: OpenAI | null = null;
function api(): OpenAI {
  if (!client) client = new OpenAI({ apiKey: env.openaiKey });
  return client;
}

export const openaiProvider: LlmProviderApi = {
  id: "openai",

  async toolCall<T>(opts: { system: string; user: string; tool: ToolSchema; model: string; maxTokens: number }) {
    const response = await api().chat.completions.create({
      model: opts.model,
      max_tokens: opts.maxTokens,
      messages: [
        { role: "system", content: opts.system },
        { role: "user", content: opts.user },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: opts.tool.name,
            description: opts.tool.description,
            parameters: opts.tool.parameters,
            // Structured Outputs: the arguments are schema-valid or the call fails.
            strict: true,
          },
        },
      ],
      tool_choice: { type: "function", function: { name: opts.tool.name } },
    });

    const call = response.choices[0]?.message?.tool_calls?.[0];
    if (!call || call.type !== "function") throw new Error(`openai returned no ${opts.tool.name} tool call`);
    // Always parse; never string-match a serialised argument blob.
    return JSON.parse(call.function.arguments) as T;
  },

  async *streamSentences(opts: {
    system: string;
    messages: ChatMessage[];
    model: string;
    maxTokens: number;
    signal?: AbortSignal;
  }) {
    const splitter = new SentenceSplitter();
    const stream = await api().chat.completions.create(
      {
        model: opts.model,
        max_tokens: opts.maxTokens,
        stream: true,
        messages: [
          { role: "system", content: opts.system },
          ...opts.messages.map((m) => ({ role: m.role, content: m.content }) as const),
        ],
      },
      { signal: opts.signal }
    );

    for await (const chunk of stream) {
      if (opts.signal?.aborted) break;
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) for (const sentence of splitter.push(delta)) yield sentence;
    }
    if (!opts.signal?.aborted) {
      const rest = splitter.flush();
      if (rest) yield rest;
    }
  },
};

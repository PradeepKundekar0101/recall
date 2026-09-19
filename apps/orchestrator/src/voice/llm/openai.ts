import OpenAI from "openai";
import { env } from "../../env.js";
import { SentenceSplitter, type ChatMessage, type LlmProviderApi, type ToolSchema } from "./types.js";
import { readOpenAiUsage } from "./usage.js";

/**
 * The OpenAI-compatible providers: OpenAI itself and OpenRouter.
 *
 * One implementation, two configurations. OpenRouter normalises the OpenAI chat
 * schema across every model it fronts, so the only differences that matter are the
 * base URL, the attribution headers, and whether `strict` tool calling can be
 * relied on.
 */

type CompatConfig = {
  id: string;
  apiKey: () => string;
  baseURL?: string;
  headers?: Record<string, string>;
  /**
   * Structured Outputs. OpenAI honours `strict: true` and guarantees the arguments
   * validate against the schema. OpenRouter passes it through to whichever model
   * is behind the id, and support there varies by provider - a model that does not
   * implement it can reject the request or quietly ignore it. So it is off for
   * OpenRouter, and the extractor's own validation is what holds the line.
   */
  strictTools: boolean;
};

function makeProvider(config: CompatConfig): LlmProviderApi {
  let client: OpenAI | null = null;
  const api = (): OpenAI => {
    if (!client) {
      client = new OpenAI({
        apiKey: config.apiKey(),
        ...(config.baseURL ? { baseURL: config.baseURL } : {}),
        ...(config.headers ? { defaultHeaders: config.headers } : {}),
      });
    }
    return client;
  };

  return {
    id: config.id,

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
              ...(config.strictTools ? { strict: true } : {}),
            },
          },
        ],
        tool_choice: { type: "function", function: { name: opts.tool.name } },
      });

      const call = response.choices[0]?.message?.tool_calls?.[0];
      if (!call || call.type !== "function") {
        throw new Error(`${config.id} returned no ${opts.tool.name} tool call`);
      }
      // Always parse; never string-match a serialised argument blob. Without
      // strict tools this can be malformed, so the throw is the useful outcome.
      let value: T;
      try {
        value = JSON.parse(call.function.arguments) as T;
      } catch {
        throw new Error(`${config.id} returned unparseable arguments for ${opts.tool.name}`);
      }
      return { value, usage: readOpenAiUsage(response, opts.model) };
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
}

export const openaiProvider = makeProvider({
  id: "openai",
  apiKey: () => env.openaiKey,
  strictTools: true,
});

/**
 * OpenRouter: one key, many models, at the cost of an extra network hop.
 *
 * That hop is the thing to watch here rather than a detail. The turn budget allows
 * 250 ms to first token, and a proxy in front of the model spends some of it
 * before the model has started. Worth measuring in rehearsal against a direct key
 * before committing to it for the demo.
 */
export const openrouterProvider = makeProvider({
  id: "openrouter",
  apiKey: () => env.openrouterKey,
  baseURL: "https://openrouter.ai/api/v1",
  headers: {
    "HTTP-Referer": "https://github.com/recall-voice-agent",
    "X-Title": "RECALL",
  },
  strictTools: false,
});

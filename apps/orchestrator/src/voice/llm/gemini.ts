import { GoogleGenAI, Type } from "@google/genai";
import { env } from "../../env.js";
import { SentenceSplitter, type ChatMessage, type LlmProviderApi, type ToolSchema } from "./types.js";
import { readGeminiUsage } from "./usage.js";

/**
 * Gemini 3.8 Flash. Wired, but deliberately never selected implicitly.
 *
 * Published time-to-first-token for this model at default thinking levels is an
 * order of magnitude outside the 250 ms budget this call loop is built around, and
 * it has been stalling upstream. `thinkingBudget: 0` turns reasoning off, which is
 * the only configuration worth measuring here - and measuring it in rehearsal is
 * the precondition for switching LLM_PROVIDER to gemini at all.
 */

let client: GoogleGenAI | null = null;
function api(): GoogleGenAI {
  if (!client) client = new GoogleGenAI({ apiKey: env.geminiKey });
  return client;
}

/** Reasoning off, on every call. */
const NO_THINKING = { thinkingConfig: { thinkingBudget: 0 } };

export const geminiProvider: LlmProviderApi = {
  id: "gemini",

  async toolCall<T>(opts: { system: string; user: string; tool: ToolSchema; model: string; maxTokens: number }) {
    const response = await api().models.generateContent({
      model: opts.model,
      contents: opts.user,
      config: {
        ...NO_THINKING,
        systemInstruction: opts.system,
        maxOutputTokens: opts.maxTokens,
        tools: [
          {
            functionDeclarations: [
              {
                name: opts.tool.name,
                description: opts.tool.description,
                parametersJsonSchema: opts.tool.parameters,
              },
            ],
          },
        ],
        toolConfig: {
          functionCallingConfig: { mode: "ANY" as never, allowedFunctionNames: [opts.tool.name] },
        },
      },
    });

    const call = response.functionCalls?.[0];
    if (!call?.args) throw new Error(`gemini returned no ${opts.tool.name} tool call`);
    return { value: call.args as T, usage: readGeminiUsage(response, opts.model) };
  },

  async *streamSentences(opts: {
    system: string;
    messages: ChatMessage[];
    model: string;
    maxTokens: number;
    signal?: AbortSignal;
  }) {
    const splitter = new SentenceSplitter();
    const stream = await api().models.generateContentStream({
      model: opts.model,
      contents: opts.messages.map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      })),
      config: { ...NO_THINKING, systemInstruction: opts.system, maxOutputTokens: opts.maxTokens },
    });

    for await (const chunk of stream) {
      if (opts.signal?.aborted) break;
      const delta = chunk.text;
      if (delta) for (const sentence of splitter.push(delta)) yield sentence;
    }
    if (!opts.signal?.aborted) {
      const rest = splitter.flush();
      if (rest) yield rest;
    }
  },
};

// Referenced so the import is not elided; the SDK's Type enum is the documented
// entry point for schema construction if the JSON-schema path ever regresses.
void Type;

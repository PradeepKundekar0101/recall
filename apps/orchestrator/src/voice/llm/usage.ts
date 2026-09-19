import type { TokenUsage } from "./types.js";

/**
 * Reading a token count off a provider response.
 *
 * Three vendors, three spellings, and every one of them can leave usage out
 * entirely - OpenRouter does it routinely depending on which model is behind
 * the id. A missing or half-present block returns null rather than zeros,
 * because the dashboard sums what it is given and a zero would quietly drag a
 * real total down.
 *
 * These take `unknown` on purpose. The SDK types do model usage, but the
 * runtime response is the thing being read here, and a vendor that ships a
 * field late should not crash a call.
 */

function pair(prompt: unknown, completion: unknown, model: string): TokenUsage | null {
  if (typeof prompt !== "number" || typeof completion !== "number") return null;
  if (!Number.isFinite(prompt) || !Number.isFinite(completion)) return null;
  return { prompt, completion, model };
}

function bag(raw: unknown, key: string): Record<string, unknown> | null {
  if (typeof raw !== "object" || raw === null) return null;
  const inner = (raw as Record<string, unknown>)[key];
  if (typeof inner !== "object" || inner === null) return null;
  return inner as Record<string, unknown>;
}

export function readOpenAiUsage(raw: unknown, model: string): TokenUsage | null {
  const usage = bag(raw, "usage");
  return usage ? pair(usage.prompt_tokens, usage.completion_tokens, model) : null;
}

export function readAnthropicUsage(raw: unknown, model: string): TokenUsage | null {
  const usage = bag(raw, "usage");
  return usage ? pair(usage.input_tokens, usage.output_tokens, model) : null;
}

export function readGeminiUsage(raw: unknown, model: string): TokenUsage | null {
  const usage = bag(raw, "usageMetadata");
  return usage ? pair(usage.promptTokenCount, usage.candidatesTokenCount, model) : null;
}

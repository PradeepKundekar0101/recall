/**
 * `pnpm usage:check` - reading a token count off each provider's response.
 *
 * Every provider spells usage differently and any of them can omit it entirely.
 * A missing usage block must produce null rather than zeros: zeros are a
 * measurement, null is an absence, and the dashboard sums the first and skips
 * the second. Milliseconds, no network.
 */
import { readAnthropicUsage, readGeminiUsage, readOpenAiUsage } from "./usage.js";

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "  ok " : "FAIL "} ${name}${ok || !detail ? "" : ` - ${detail}`}`);
  if (!ok) failed += 1;
}

// ---- OpenAI and OpenRouter share a shape
const openai = readOpenAiUsage({ usage: { prompt_tokens: 812, completion_tokens: 47 } }, "gpt-4o-mini");
check("openai reads prompt tokens", openai?.prompt === 812, String(openai?.prompt));
check("openai reads completion tokens", openai?.completion === 47, String(openai?.completion));
check("openai carries the model", openai?.model === "gpt-4o-mini", String(openai?.model));

check("openai with no usage block is null", readOpenAiUsage({}, "gpt-4o-mini") === null);
check("openai with a null response is null", readOpenAiUsage(null, "gpt-4o-mini") === null);
check(
  "openai with a partial usage block is null, not half a measurement",
  readOpenAiUsage({ usage: { prompt_tokens: 812 } }, "gpt-4o-mini") === null
);

// ---- Anthropic
const anthropic = readAnthropicUsage({ usage: { input_tokens: 900, output_tokens: 31 } }, "claude-haiku-4-5");
check("anthropic reads input tokens as prompt", anthropic?.prompt === 900, String(anthropic?.prompt));
check("anthropic reads output tokens as completion", anthropic?.completion === 31, String(anthropic?.completion));
check("anthropic with no usage block is null", readAnthropicUsage({}, "claude-haiku-4-5") === null);

// ---- Gemini
const gemini = readGeminiUsage(
  { usageMetadata: { promptTokenCount: 640, candidatesTokenCount: 22 } },
  "gemini-2.5-flash-lite"
);
check("gemini reads promptTokenCount", gemini?.prompt === 640, String(gemini?.prompt));
check("gemini reads candidatesTokenCount", gemini?.completion === 22, String(gemini?.completion));
check("gemini with no usageMetadata is null", readGeminiUsage({}, "gemini-2.5-flash-lite") === null);

console.log(failed ? `\n${failed} failed` : "\nall ok");
process.exit(failed ? 1 : 0);

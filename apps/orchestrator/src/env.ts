import { config as loadEnv } from "dotenv";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * pnpm runs each workspace package with its own cwd, so a bare `dotenv/config`
 * would only ever see apps/orchestrator/.env. Load the workspace root first, then
 * let a package-local .env override it for per-developer settings.
 */
const here = dirname(fileURLToPath(import.meta.url));
for (const path of [
  resolve(here, "../../../.env"), // workspace root
  resolve(here, "../.env"), // apps/orchestrator/.env
]) {
  if (existsSync(path)) loadEnv({ path, override: true });
}

function opt(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}
function num(name: string, fallback: number): number {
  const v = process.env[name];
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}
function flag(name: string, fallback = false): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return v === "1" || v === "true";
}
function list(name: string): string[] {
  return opt(name)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export const env = {
  port: num("PORT", 8080),

  twilioSid: opt("TWILIO_ACCOUNT_SID"),
  twilioToken: opt("TWILIO_AUTH_TOKEN"),
  twilioFrom: opt("TWILIO_FROM_NUMBER"),
  publicBaseUrl: opt("PUBLIC_BASE_URL").replace(/\/$/, ""),

  deepgramKey: opt("DEEPGRAM_API_KEY"),
  elevenLabsKey: opt("ELEVENLABS_API_KEY"),
  elevenLabsVoiceId: opt("ELEVENLABS_VOICE_ID"),
  llmKey: opt("LLM_API_KEY"),

  supabaseUrl: opt("SUPABASE_URL"),
  supabaseKey: opt("SUPABASE_SERVICE_ROLE_KEY"),

  /**
   * Haiku for both loops. The dialogue turn and the escalation classifier run in
   * parallel on every customer utterance, so the model choice is a latency
   * decision before it is a quality one - the budget is 250 ms to first token.
   */
  dialogueModel: opt("DIALOGUE_MODEL", "claude-haiku-4-5"),
  escalationModel: opt("ESCALATION_MODEL", "claude-haiku-4-5"),
  ttsModel: opt("TTS_MODEL", "eleven_flash_v2_5"),

  /** No vendor calls. STT/TTS/LLM run off fixtures so the loop boots dry. */
  mockVoice: flag("MOCK_VOICE", true),
  transport: (opt("TRANSPORT", "sim") === "pstn" ? "pstn" : "sim") as "pstn" | "sim",
  ignoreCallWindow: flag("IGNORE_CALL_WINDOW", false),

  sandboxUrl: opt("SANDBOX_URL", "http://localhost:4001").replace(/\/$/, ""),
  sandboxAuthHeader: opt("SANDBOX_AUTH_HEADER"),
  mockSandboxPort: num("MOCK_SANDBOX_PORT", 4001),

  /**
   * Guardrail 1, test data only. The dial path refuses any number not on this
   * list, so a synthetic lead carrying a real number cannot be rung by accident.
   */
  testNumbers: list("TEST_NUMBERS"),
  /** Second test phone that warm handoffs transfer to. */
  handoffNumber: opt("HANDOFF_NUMBER"),
};

export const has = {
  twilio: () => Boolean(env.twilioSid && env.twilioToken && env.twilioFrom && env.publicBaseUrl),
  deepgram: () => Boolean(env.deepgramKey),
  elevenLabs: () => Boolean(env.elevenLabsKey && env.elevenLabsVoiceId),
  llm: () => Boolean(env.llmKey),
  supabase: () => Boolean(env.supabaseUrl && env.supabaseKey),
  handoff: () => Boolean(env.handoffNumber),
};

/** Printed at boot so a missing key is obvious before, not during, the demo. */
export function bootReport(): string[] {
  const voice = env.mockVoice ? " (MOCK_VOICE=1, not used yet)" : "";
  return [
    `transport  ${env.transport}`,
    `deepgram   ${has.deepgram() ? "ok" : "MISSING - no STT"}${voice}`,
    `elevenlabs ${has.elevenLabs() ? "ok" : "MISSING - no TTS"}${voice}`,
    `llm        ${has.llm() ? "ok" : "MISSING - no dialogue or extraction"}${voice}`,
    `twilio     ${has.twilio() ? "ok" : "missing - PSTN disabled, sim transport still works"}`,
    `supabase   ${has.supabase() ? "ok" : "missing - running in memory only, nothing persists"}`,
    `handoff    ${has.handoff() ? `ok -> ${env.handoffNumber}` : "MISSING - warm transfer has nowhere to go"}`,
    `sandbox    ${env.sandboxUrl}`,
    `test nums  ${env.testNumbers.length ? env.testNumbers.join(", ") : "NONE - every dial will be refused"}`,
  ];
}

import { config as loadEnv } from "dotenv";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * pnpm runs each workspace package with its own cwd, so a bare `dotenv/config`
 * would only ever see apps/orchestrator/.env. Load the workspace root first, then
 * let a package-local .env override it for per-developer settings.
 *
 * Anything already in the real process environment outranks both files. Without
 * this, `MOCK_VOICE=0 pnpm dev:api` is silently ignored because .env says 1 - the
 * kind of thing that costs twenty minutes at 2am when you are certain you turned
 * mocking off.
 */
const here = dirname(fileURLToPath(import.meta.url));
const fromShell = { ...process.env };

for (const path of [
  resolve(here, "../../../.env"), // workspace root
  resolve(here, "../.env"), // apps/orchestrator/.env
]) {
  if (existsSync(path)) loadEnv({ path, override: true });
}

for (const [key, value] of Object.entries(fromShell)) {
  if (value !== undefined) process.env[key] = value;
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

export type SttProvider = "scribe" | "deepgram";
export type LlmProvider = "anthropic" | "openai" | "openrouter" | "gemini";
export type CallMode = "echo" | "journey";

/**
 * Picks the LLM provider. An explicit LLM_PROVIDER wins; otherwise whichever key
 * is configured does, in preference order.
 *
 * Gemini is never chosen implicitly. Its published time-to-first-token is an order
 * of magnitude outside this project's 250 ms budget at default thinking levels, so
 * it is opt-in and only after being measured in rehearsal.
 */
function pickLlm(): LlmProvider {
  const explicit = opt("LLM_PROVIDER").toLowerCase();
  if (explicit === "anthropic" || explicit === "openai" || explicit === "openrouter" || explicit === "gemini") {
    return explicit;
  }
  // A direct key is preferred over the gateway: OpenRouter adds a network hop in
  // front of the model, and the turn budget only allows 250 ms to first token.
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  if (process.env.OPENAI_API_KEY) return "openai";
  if (process.env.OPENROUTER_API_KEY) return "openrouter";
  if (process.env.GEMINI_API_KEY) return "gemini";
  return "anthropic";
}

const DEFAULT_MODEL: Record<LlmProvider, string> = {
  anthropic: "claude-haiku-4-5",
  openai: "gpt-4o-mini",
  // OpenRouter ids are org-prefixed. Haiku through the gateway is the same model
  // the direct provider serves, so the dialogue behaves identically either way.
  openrouter: "anthropic/claude-haiku-4.5",
  gemini: "gemini-3.8-flash",
};

const llmProvider = pickLlm();

export const env = {
  port: num("PORT", 8080),

  twilioSid: opt("TWILIO_ACCOUNT_SID"),
  twilioToken: opt("TWILIO_AUTH_TOKEN"),
  twilioFrom: opt("TWILIO_FROM_NUMBER"),
  publicBaseUrl: opt("PUBLIC_BASE_URL").replace(/\/$/, ""),

  /**
   * Scribe v2 Realtime is the build target. It takes Twilio's ulaw_8000 natively
   * and returns per-word logprobs, which is what the LOW CONF signal is defined on.
   * Deepgram stays wired as a fallback for the venue network.
   */
  sttProvider: (opt("STT_PROVIDER", "scribe") === "deepgram" ? "deepgram" : "scribe") as SttProvider,
  sttModel: opt("STT_MODEL", "scribe_v2_realtime"),
  deepgramKey: opt("DEEPGRAM_API_KEY"),
  deepgramModel: opt("DEEPGRAM_MODEL", "nova-3"),

  elevenLabsKey: opt("ELEVENLABS_API_KEY"),
  elevenLabsVoiceId: opt("ELEVENLABS_VOICE_ID"),
  ttsModel: opt("TTS_MODEL", "eleven_flash_v2_5"),
  prerenderDir: opt("PRERENDER_DIR", ".prerender"),

  llmProvider,
  anthropicKey: opt("ANTHROPIC_API_KEY"),
  openaiKey: opt("OPENAI_API_KEY"),
  openrouterKey: opt("OPENROUTER_API_KEY"),
  geminiKey: opt("GEMINI_API_KEY"),
  dialogueModel: opt("DIALOGUE_MODEL") || DEFAULT_MODEL[llmProvider],
  escalationModel: opt("ESCALATION_MODEL") || DEFAULT_MODEL[llmProvider],

  supabaseUrl: opt("SUPABASE_URL"),
  supabaseKey: opt("SUPABASE_SERVICE_ROLE_KEY"),

  /** echo repeats back what STT heard. It is tonight's infrastructure target. */
  callMode: (opt("CALL_MODE", "echo") === "journey" ? "journey" : "echo") as CallMode,

  /** No vendor calls. STT/TTS/LLM run off fixtures so the loop boots dry. */
  mockVoice: flag("MOCK_VOICE", true),
  transport: (opt("TRANSPORT", "sim") === "pstn" ? "pstn" : "sim") as "pstn" | "sim",
  ignoreCallWindow: flag("IGNORE_CALL_WINDOW", false),

  /**
   * If the model has not answered within this long, play a short pre-rendered
   * acknowledgement so the line is never silent while it thinks.
   */
  fillerAfterMs: num("FILLER_AFTER_MS", 400),

  /**
   * How long a committed transcript that stops mid-thought ("Uh, it's-") is
   * held for the rest of the sentence before being taken as the whole answer.
   * Scribe's VAD floor is half a second and people pause longer than that in
   * the middle of an address.
   */
  fragmentHoldMs: num("FRAGMENT_HOLD_MS", 2500),

  /**
   * How soon after a question becomes audible a person could be answering it.
   * An utterance that started before that is a late word to the previous line,
   * not an answer to this one. Covers the STT's partial latency plus a minimum
   * human reaction; the checks set it to zero because their line plays instantly.
   */
  answerReactionMs: num("ANSWER_REACTION_MS", 400),

  /** Silence on an open question: nudge, nudge again, then close as abandoned. */
  silenceNudgeMs: num("SILENCE_NUDGE_MS", 6000),
  silenceSecondNudgeMs: num("SILENCE_SECOND_NUDGE_MS", 12000),
  silenceAbandonMs: num("SILENCE_ABANDON_MS", 18000),

  /**
   * Where confirmed fields are saved. Defaults to the mock CRM the orchestrator
   * mounts on its own port, so a demo needs one process and no third-party
   * endpoint; point it anywhere else and nothing above this line changes.
   */
  // `||` rather than a fallback argument: `opt` reads an empty SANDBOX_URL as a
  // value, and blank is how .env says "use the one mounted here".
  sandboxUrl: (opt("SANDBOX_URL") || `http://localhost:${num("PORT", 8080)}/mock-crm`).replace(/\/$/, ""),
  sandboxAuthHeader: opt("SANDBOX_AUTH_HEADER"),
  /** Only used by `pnpm sandbox:mock`, which runs the same routes out of process. */
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
  stt: () => (env.sttProvider === "scribe" ? Boolean(env.elevenLabsKey) : Boolean(env.deepgramKey)),
  tts: () => Boolean(env.elevenLabsKey && env.elevenLabsVoiceId),
  llm: () => Boolean(llmKey()),
  supabase: () => Boolean(env.supabaseUrl && env.supabaseKey),
  handoff: () => Boolean(env.handoffNumber),
};

/** The key the active LLM provider needs. */
export function llmKey(): string {
  switch (env.llmProvider) {
    case "anthropic":
      return env.anthropicKey;
    case "openai":
      return env.openaiKey;
    case "openrouter":
      return env.openrouterKey;
    case "gemini":
      return env.geminiKey;
  }
}

/** Printed at boot so a missing key is obvious before, not during, the demo. */
export function bootReport(): string[] {
  const dry = env.mockVoice ? "  [MOCK_VOICE=1]" : "";
  return [
    `mode       ${env.callMode} over ${env.transport}${dry}`,
    `stt        ${env.sttProvider}/${env.sttModel} ${has.stt() ? "ok" : "MISSING KEY"}`,
    `tts        elevenlabs/${env.ttsModel} ${has.tts() ? "ok" : "MISSING KEY OR VOICE"}`,
    `llm        ${env.llmProvider}/${env.dialogueModel} ${has.llm() ? "ok" : "MISSING KEY"}`,
    `twilio     ${has.twilio() ? "ok" : "missing - PSTN disabled, sim transport still works"}`,
    `supabase   ${has.supabase() ? "ok" : "missing - running in memory only, nothing persists"}`,
    `handoff    ${has.handoff() ? `ok -> ${env.handoffNumber}` : "MISSING - warm transfer has nowhere to go"}`,
    `sandbox    ${env.sandboxUrl}`,
    `test nums  ${env.testNumbers.length ? env.testNumbers.join(", ") : "NONE - every dial will be refused"}`,
  ];
}

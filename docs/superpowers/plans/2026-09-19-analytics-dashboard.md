# Analytics Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an engineering analytics surface to RECALL that answers whether the voice agent is fast (turn latency against the 800 ms budget, and where the time inside a turn goes) and accurate (hands-free field rate, per-field re-asks, outcome mix).

**Architecture:** One new SSE event, `turn.timing`, is emitted once per agent reply and mirrored into `call_events` by the existing `recordEvent` write path, so there is no second source of truth. A new orchestrator module aggregates over that JSONB and over `calls`, split into a pure `aggregate.ts` and a database-facing `query.ts`, and serves the whole dashboard from one `GET /analytics` endpoint. The web console renders it at `/analytics` with hand-rolled inline SVG charts in the existing light design language.

**Tech Stack:** TypeScript, Node 20 (pinned), Express, Supabase (Postgres), Next.js 15 App Router, React 19. No new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-09-19-analytics-dashboard-design.md`

## Global Constraints

- Node 20 only. Do not upgrade. `package.json` pins `"node": ">=20 <21"`, because Node 22+ ships a global `WebSocket` that drops the options argument and strips auth headers off the Scribe and ElevenLabs sockets.
- No em dashes anywhere in code, comments, commit messages or UI copy. Use a plain hyphen.
- No new runtime dependency. Charts are hand-rolled inline SVG. A chart library is explicitly out of scope.
- The console stays light. Colours come only from the CSS variables already defined in `apps/web/app/globals.css`. `apps/web/DESIGN.md` rules out a dark canvas.
- Nothing may be added to the turn hot path that is awaited and was not already awaited. Measure inline with `Date.now()`, emit synchronously through `bus.emitEvent`, and leave the Supabase mirror as the un-awaited best-effort write it already is.
- Every Supabase write stays best-effort: log a warning and swallow. A database outage must never take a call down.
- Latency is reported as percentiles (p50, p90) with min and max, never as a bare average.
- Commit messages must not include a Co-Authored-By line.
- Package manager is `corepack pnpm`. Run checks from the repo root via the root `package.json` script aliases.

---

### Task 1: The `turn.timing` contract in `packages/shared`

The shared package is the reason the orchestrator and the console cannot drift.
This task adds the type and the event variant, and nothing else, so every later task compiles against a fixed contract.

**Files:**
- Modify: `packages/shared/src/call.ts` (append at end of file)
- Modify: `packages/shared/src/events.ts` (add a union member and an import)

**Interfaces:**
- Consumes: nothing.
- Produces: `TurnKind`, `TurnTiming` from `@recall/shared`; the `turn.timing` member of `CallEvent`.

- [ ] **Step 1: Add the `TurnTiming` type**

Append to `packages/shared/src/call.ts`:

```ts
/**
 * Which of three very different things a turn was.
 *
 * Without this split the timing chart is three overlapping distributions
 * pretending to be one, and the average across them is meaningless: a closed
 * field matched in code resolves in single-digit milliseconds, a pre-rendered
 * script line plays off disk with no synthesis, and a generated reply pays for
 * both a model round trip and a live TTS socket.
 */
export type TurnKind = "closed_field" | "cached_line" | "generated";

/**
 * One turn's measured stages, customer transcript in hand to agent audio on the
 * wire.
 *
 * Time zero is the committed transcript rather than end of speech. Scribe runs
 * with `include_timestamps` on, but word end times are not modelled by the
 * transcript type this codebase reads, so end of speech is not a boundary that
 * can be defended.
 *
 * `think_ms`, `wire_wait_ms` and `tts_ttfb_ms` tile the turn: on a turn that
 * completed every stage they sum to `first_audio_ms`. The two LLM numbers are
 * nested inside `think_ms` and are a breakdown of it, not a fourth slice.
 */
export type TurnTiming = {
  /** Transcript in hand to reply decided. Contains the model round trip, when there is one. */
  think_ms: number;
  /**
   * Request sent to first token. Only measurable on the streaming path; the
   * extraction call is not streamed, so this is null on those turns rather
   * than a copy of `llm_total_ms` dressed up as a first-token measurement.
   */
  llm_ttfb_ms: number | null;
  /** Request sent to last token. Null on a closed field, which never reaches the model. */
  llm_total_ms: number | null;
  /** Reply decided to wire free. The previous line was still playing. */
  wire_wait_ms: number;
  /** Text handed to TTS to first audio frame. Near zero for a pre-rendered line. */
  tts_ttfb_ms: number;
  /** Transcript to first audio. The number the 800 ms budget is set on. */
  first_audio_ms: number;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  /** The model that was actually called, not the configured default. Null when none was. */
  model: string | null;
  /** Characters handed to TTS, which is how ElevenLabs bills. */
  tts_chars: number;
  kind: TurnKind;
};
```

- [ ] **Step 2: Add the event variant**

In `packages/shared/src/events.ts`, add `TurnTiming` to the existing type import from `./call.js`:

```ts
import type {
  CallOutcome,
  CallStatus,
  EscalationSignal,
  FieldState,
  FieldValue,
  GuardrailId,
  HandoffPacket,
  Lead,
  TurnTiming,
} from "./call.js";
```

Then add this member to the `CallEvent` union, immediately after the `latency.turn` member:

```ts
  /**
   * One turn's stage split, emitted once per agent reply.
   *
   * Flattened rather than nested so the audit mirror can be aggregated with
   * `payload->>'first_audio_ms'` instead of a nested path.
   */
  | (Base & { type: "turn.timing" } & TurnTiming)
```

- [ ] **Step 3: Verify it typechecks**

Run: `corepack pnpm typecheck`
Expected: PASS. No existing code references the new member, so nothing else changes.

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/call.ts packages/shared/src/events.ts
git commit -m "Add the turn.timing contract"
```

---

### Task 2: Token usage out of the LLM providers

`toolCall` currently returns the validated object and throws away the usage block the provider already sent.
This task threads it out without changing any call site's behaviour.

**Files:**
- Modify: `apps/orchestrator/src/voice/llm/types.ts`
- Modify: `apps/orchestrator/src/voice/llm/openai.ts`
- Modify: `apps/orchestrator/src/voice/llm/anthropic.ts`
- Modify: `apps/orchestrator/src/voice/llm/gemini.ts`
- Modify: `apps/orchestrator/src/voice/llm.ts`
- Modify: `apps/orchestrator/src/engine/extract.ts:163-246`
- Create: `apps/orchestrator/src/voice/llm/usage.check.ts`
- Modify: `apps/orchestrator/package.json` (add the `usage:check` script)
- Modify: `package.json` (add the root alias)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  - `TokenUsage = { prompt: number; completion: number; model: string }` from `voice/llm/types.js`
  - `readOpenAiUsage(raw: unknown, model: string): TokenUsage | null` from `voice/llm/usage.js`
  - `readAnthropicUsage(raw: unknown, model: string): TokenUsage | null` from `voice/llm/usage.js`
  - `readGeminiUsage(raw: unknown, model: string): TokenUsage | null` from `voice/llm/usage.js`
  - `LlmProviderApi.toolCall` now resolves to `{ value: T; usage: TokenUsage | null }`
  - `toolCall` in `voice/llm.ts` now resolves to `{ value: T; ms: number; usage: TokenUsage | null }`
  - `extract` in `engine/extract.ts` now resolves with an extra `usage: TokenUsage | null` property

- [ ] **Step 1: Write the failing test**

Create `apps/orchestrator/src/voice/llm/usage.check.ts`:

```ts
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
```

- [ ] **Step 2: Wire the script and run it to verify it fails**

Add to `apps/orchestrator/package.json` scripts:

```json
    "usage:check": "tsx src/voice/llm/usage.check.ts",
```

Add to the root `package.json` scripts:

```json
    "usage:check": "pnpm --filter orchestrator usage:check",
```

Run: `corepack pnpm usage:check`
Expected: FAIL. The module `./usage.js` does not exist yet, so tsx exits with a resolution error.

- [ ] **Step 3: Write the usage readers**

Create `apps/orchestrator/src/voice/llm/usage.ts`:

```ts
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
```

- [ ] **Step 4: Add the `TokenUsage` type and widen the provider interface**

In `apps/orchestrator/src/voice/llm/types.ts`, add above `LlmProviderApi`:

```ts
/** What one model call cost, as the provider reported it. */
export type TokenUsage = { prompt: number; completion: number; model: string };
```

and change the `toolCall` signature on `LlmProviderApi` to:

```ts
  /** One structured call, one validated object back, plus what it cost. */
  toolCall<T>(opts: {
    system: string;
    user: string;
    tool: ToolSchema;
    model: string;
    maxTokens: number;
  }): Promise<{ value: T; usage: TokenUsage | null }>;
```

- [ ] **Step 5: Run the check to verify the readers pass**

Run: `corepack pnpm usage:check`
Expected: PASS, `all ok`. The provider implementations have not been updated yet, so `corepack pnpm typecheck` will still fail - that is the next step.

- [ ] **Step 6: Update the three providers**

In `apps/orchestrator/src/voice/llm/openai.ts`, import the reader and change the end of `toolCall` to return the pair. Replace the two `return`/`throw` lines at the end of the `toolCall` body:

```ts
import { readOpenAiUsage } from "./usage.js";
```

```ts
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
```

In `apps/orchestrator/src/voice/llm/anthropic.ts`:

```ts
import { readAnthropicUsage } from "./usage.js";
```

```ts
    if (!block) throw new Error(`anthropic returned no ${opts.tool.name} tool call`);
    return { value: block.input as T, usage: readAnthropicUsage(response, opts.model) };
```

In `apps/orchestrator/src/voice/llm/gemini.ts`, apply the same shape: import `readGeminiUsage`, keep whatever parsing the file already does, and return `{ value, usage: readGeminiUsage(response, opts.model) }` in place of the bare value. Read the file first and preserve its existing error paths exactly.

- [ ] **Step 7: Thread usage through `voice/llm.ts`**

In `apps/orchestrator/src/voice/llm.ts`, re-export the type and widen `toolCall`:

```ts
export type { ChatMessage, ToolSchema, TokenUsage } from "./llm/types.js";
```

```ts
export async function toolCall<T>(
  opts: ToolCallOptions<T>
): Promise<{ value: T; ms: number; usage: TokenUsage | null }> {
  if (env.mockVoice) return { value: opts.mock, ms: 0, usage: null };

  const started = Date.now();
  try {
    const { value, usage } = await provider().toolCall<T>({
      system: opts.system,
      user: opts.user,
      tool: opts.tool,
      model: opts.model ?? env.dialogueModel,
      // Classification-sized. A field patch is ~150 tokens out.
      maxTokens: opts.maxTokens ?? 512,
    });
    const ms = Date.now() - started;
    turnLatency.push(ms);
    return { value, ms, usage };
  } catch (err) {
    log.error(`llm(${env.llmProvider}): ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
}
```

Add `import type { TokenUsage } from "./llm/types.js";` to the file's imports.

- [ ] **Step 8: Thread usage through `extract()`**

In `apps/orchestrator/src/engine/extract.ts`, change the return type on line 169 and the destructure on line 172 and the return on line 246:

```ts
}): Promise<{
  accepted: AcceptedPatch[];
  rejected: RejectedPatch[];
  intent: Intent;
  ms: number;
  usage: TokenUsage | null;
}> {
```

```ts
  const { value, ms, usage } = await toolCall<ExtractionResult>({
```

```ts
  return { accepted, rejected, intent: value.intent ?? "unclear", ms, usage };
```

Add `TokenUsage` to the existing type import from `../voice/llm.js`.

- [ ] **Step 9: Run typecheck and the checks that touch this path**

Run: `corepack pnpm typecheck`
Expected: PASS.

Run: `corepack pnpm usage:check && corepack pnpm dialogue:check`
Expected: PASS both. `dialogue:check` runs against a fake line and mocked voice, so the new usage field is null throughout and no assertion changes.

- [ ] **Step 10: Commit**

```bash
git add apps/orchestrator/src/voice/llm apps/orchestrator/src/voice/llm.ts apps/orchestrator/src/engine/extract.ts apps/orchestrator/package.json package.json
git commit -m "Read the token count each provider already sends

Every provider reports usage and this code threw it away. Each spells it
differently and any of them can omit it, so a missing or half-present
block reads as null rather than zeros - the dashboard sums what it is
given, and a zero would quietly drag a real total down."
```

---

### Task 3: TTS cache and character count out of the transport

The dashboard has to separate a line that played off disk from one that was synthesised live, or the TTS numbers are meaningless.
`synthesize()` already knows which happened; this task surfaces it, following the same callback shape `onFirstAudio` already uses.

**Files:**
- Modify: `apps/orchestrator/src/voice/tts.ts:158` (the `synthesize` function and its options type)
- Modify: `apps/orchestrator/src/engine/transport.ts` (the `speak` signature on the `Transport` interface)
- Modify: `apps/orchestrator/src/transports/twilio.ts:351,367,385`
- Modify: `apps/orchestrator/src/transports/sim.ts:83`

**Interfaces:**
- Consumes: nothing.
- Produces: `AudioMeta = { cached: boolean; chars: number }`, exported from `engine/transport.js`; an `onAudioMeta?: (meta: AudioMeta) => void` option on `Transport.speak` and on `synthesize`.

- [ ] **Step 1: Add the meta type to the transport seam**

In `apps/orchestrator/src/engine/transport.ts`, add above the `Transport` interface:

```ts
/**
 * What the audio for one line cost to produce.
 *
 * `cached` is the difference between a pre-rendered script line read off disk
 * and a live ElevenLabs round trip. They differ by an order of magnitude, so
 * averaging them together produces a number that describes neither.
 */
export type AudioMeta = { cached: boolean; chars: number };
```

and change the `speak` signature on the interface to:

```ts
  speak(
    text: string,
    opts?: { onFirstAudio?: () => void; onAudioMeta?: (meta: AudioMeta) => void; interruptible?: boolean }
  ): Promise<SpeakResult>;
```

- [ ] **Step 2: Report the cache hit from `synthesize`**

In `apps/orchestrator/src/voice/tts.ts`, add `onMeta` to the `SpeakOptions` type (the type `synthesize` takes at line 158):

```ts
  /**
   * Fires once, as soon as it is known whether this line came off disk or cost
   * a round trip. Reported rather than returned so the return type stays a
   * Buffer for the callers that only want audio.
   */
  onMeta?: (meta: { cached: boolean; chars: number }) => void;
```

Inside `synthesize`, report a hit on each of the two cache paths and a miss before the live call. The existing body checks memory then disk then synthesises; add:

```ts
    const hit = memory.get(text);
    if (hit) {
      opts.onMeta?.({ cached: true, chars: text.length });
      return hit;
    }
```

```ts
    if (existsSync(path)) {
      opts.onMeta?.({ cached: true, chars: text.length });
      // ... existing disk read, unchanged
    }
```

and immediately before the live synthesis begins, after the `has.tts()` guard:

```ts
  opts.onMeta?.({ cached: false, chars: text.length });
```

Read the function body before editing and keep every existing line; these are three insertions, not a rewrite.

- [ ] **Step 3: Forward it from the Twilio transport**

In `apps/orchestrator/src/transports/twilio.ts`, widen the `speak` signature at line 351 and the private helper at 367 to carry `onAudioMeta`, and pass it into the `synthesize` call at line 385:

```ts
  async speak(
    text: string,
    opts: { onFirstAudio?: () => void; onAudioMeta?: (meta: AudioMeta) => void; interruptible?: boolean } = {}
  ): Promise<SpeakResult> {
```

```ts
      synthesize({ text: p, onMeta: opts.onAudioMeta }).catch((err) => {
```

Add `AudioMeta` to the existing type import from `../engine/transport.js`.

- [ ] **Step 4: Forward it from the sim transport**

In `apps/orchestrator/src/transports/sim.ts`, widen `speak` at line 83 and report a synthetic meta, because the sim never synthesises:

```ts
  async speak(
    text: string,
    opts: { onFirstAudio?: () => void; onAudioMeta?: (meta: AudioMeta) => void } = {}
  ): Promise<SpeakResult> {
```

and next to the existing `opts.onFirstAudio?.()` call at line 88:

```ts
    // The sim never touches ElevenLabs. Reported as cached so a simulated call
    // never contributes a zero to the live synthesis statistics.
    opts.onAudioMeta?.({ cached: true, chars: text.length });
    opts.onFirstAudio?.();
```

Add `AudioMeta` to the existing type import from `../engine/transport.js`.

- [ ] **Step 5: Run typecheck and the transport check**

Run: `corepack pnpm typecheck`
Expected: PASS.

Run: `corepack pnpm transport:check && corepack pnpm tts:check`
Expected: PASS both. Neither asserts on the new callback, and both exercise the paths that now call it.

- [ ] **Step 6: Commit**

```bash
git add apps/orchestrator/src/voice/tts.ts apps/orchestrator/src/engine/transport.ts apps/orchestrator/src/transports
git commit -m "Report whether a line was synthesised or read off disk

A pre-rendered line and a live ElevenLabs round trip differ by an order
of magnitude, so a TTS average across both describes neither."
```

---

### Task 4: Measure the turn in the dialogue engine

This is the task that fixes the defect: the journey engine has never emitted `latency.turn`, so the number the rehearsal checklist asserts on has not been recorded on a single real call.

**Files:**
- Create: `apps/orchestrator/src/engine/turn-clock.ts`
- Modify: `apps/orchestrator/src/engine/dialogue.ts` (hooks type, `handleTurn` at 254, `speak` at 973, `answer` at 307)
- Modify: `apps/orchestrator/src/calls.ts:138-160` (wire the new hook)
- Modify: `apps/orchestrator/src/engine/dialogue.check.ts` (add cases)

**Interfaces:**
- Consumes: `TurnTiming`, `TurnKind` (Task 1); `TokenUsage` (Task 2); `AudioMeta` (Task 3).
- Produces: `TurnClock` class from `engine/turn-clock.js` with members `t0`, `markDecided()`, `markWireFree()`, `markFirstAudio()`, `noteLlm(totalMs, usage)`, `noteAudio(meta)`, `markGenerated()`, `markClosedField()`, `finish(): TurnTiming | null`; a new `onTurnTiming: (timing: TurnTiming) => void` member on `DialogueEngine`'s hooks.

- [ ] **Step 1: Write the failing test**

Append to `apps/orchestrator/src/engine/dialogue.check.ts`, before the final summary lines. Match the file's existing `check(...)` helper and fake-transport harness - read the file first and reuse its setup rather than inventing a second one.

```ts
// ---- turn timing
{
  const timings: TurnTiming[] = [];
  const { engine, line } = harness({ onTurnTiming: (t) => timings.push(t) });
  await engine.start();
  timings.length = 0;

  await line.say("my name is Priya Sharma");
  await line.settle();

  check("one timing event per reply", timings.length === 1, `got ${timings.length}`);
  const t = timings[0] as TurnTiming;
  check(
    "the three tiling stages sum to first audio",
    t.think_ms + t.wire_wait_ms + t.tts_ttfb_ms === t.first_audio_ms,
    `${t.think_ms} + ${t.wire_wait_ms} + ${t.tts_ttfb_ms} != ${t.first_audio_ms}`
  );
  check("a mocked model reports no token count", t.prompt_tokens === null && t.completion_tokens === null);
  check("a sim line is not counted as live synthesis", t.kind === "cached_line", t.kind);
}

// ---- a cancelled turn emits nothing
{
  const timings: TurnTiming[] = [];
  const { engine, line } = harness({ onTurnTiming: (t) => timings.push(t) });
  await engine.start();
  timings.length = 0;

  await line.say("my name is Priya Sharma", { bargeInBeforeAudio: true });
  await line.settle();

  check("a turn cut before any audio emits no timing", timings.length === 0, `got ${timings.length}`);
}
```

Add `import type { TurnTiming } from "@recall/shared";` at the top of the check file.

- [ ] **Step 2: Run it to verify it fails**

Run: `corepack pnpm dialogue:check`
Expected: FAIL. `onTurnTiming` is not a hook the engine accepts, so the harness will not compile or the assertions will report zero events.

- [ ] **Step 3: Write the turn clock**

Create `apps/orchestrator/src/engine/turn-clock.ts`:

```ts
import type { TokenUsage } from "../voice/llm.js";
import type { AudioMeta } from "./transport.js";
import type { TurnKind, TurnTiming } from "@recall/shared";

/**
 * One turn's stopwatch.
 *
 * Deliberately a plain object of timestamps rather than anything that
 * subscribes or awaits: this sits on the hot path, and the whole cost of it is
 * six `Date.now()` calls and a few assignments. Nothing here may throw, because
 * a measurement failing must never end a call.
 *
 * Only the first spoken line of a turn is measured. A turn can speak more than
 * once - an answer, then the next question - and the number the budget is set
 * on is how long the customer waited for the agent to start talking, not how
 * long the whole exchange took.
 */
export class TurnClock {
  readonly t0 = Date.now();
  private decidedAt: number | null = null;
  private wireFreeAt: number | null = null;
  private firstAudioAt: number | null = null;
  private llmTotalMs: number | null = null;
  private llmTtfbMs: number | null = null;
  private usage: TokenUsage | null = null;
  private audio: AudioMeta | null = null;
  private generated = false;
  private closedField = false;

  /** The reply text is known. Called once; later lines in the same turn are ignored. */
  markDecided(): void {
    if (this.decidedAt === null) this.decidedAt = Date.now();
  }

  /** The wire is free and this line is about to go out. */
  markWireFree(): void {
    if (this.wireFreeAt === null) this.wireFreeAt = Date.now();
  }

  /** The first frame reached the wire. */
  markFirstAudio(): void {
    if (this.firstAudioAt === null) this.firstAudioAt = Date.now();
  }

  /** The extraction call came back. Not streamed, so there is no first-token moment. */
  noteLlm(totalMs: number, usage: TokenUsage | null): void {
    if (this.llmTotalMs === null) {
      this.llmTotalMs = totalMs;
      this.usage = usage;
    }
  }

  /** A streamed reply yielded its first sentence. This one is a real first token. */
  noteLlmFirstToken(ttfbMs: number): void {
    if (this.llmTtfbMs === null) this.llmTtfbMs = ttfbMs;
  }

  noteAudio(meta: AudioMeta): void {
    if (this.audio === null) this.audio = meta;
  }

  /** The reply came out of the model rather than a script. */
  markGenerated(): void {
    this.generated = true;
  }

  /** The answer was matched in code and never reached the model. */
  markClosedField(): void {
    this.closedField = true;
  }

  private kind(): TurnKind {
    if (this.closedField) return "closed_field";
    if (this.generated) return "generated";
    return this.audio?.cached ? "cached_line" : "generated";
  }

  /**
   * The finished measurement, or null when there is nothing honest to report.
   *
   * A turn cut by barge-in before any audio reached the wire has no first-audio
   * moment, and inventing one would put a fabricated sample into the very
   * percentile the budget is judged on.
   */
  finish(): TurnTiming | null {
    if (this.firstAudioAt === null || this.decidedAt === null || this.wireFreeAt === null) return null;
    const think = this.decidedAt - this.t0;
    const wireWait = this.wireFreeAt - this.decidedAt;
    const ttsTtfb = this.firstAudioAt - this.wireFreeAt;
    return {
      think_ms: think,
      llm_ttfb_ms: this.llmTtfbMs,
      llm_total_ms: this.llmTotalMs,
      wire_wait_ms: wireWait,
      tts_ttfb_ms: ttsTtfb,
      // Summed from the parts rather than measured again, so the identity the
      // checks assert on holds exactly rather than to within a millisecond.
      first_audio_ms: think + wireWait + ttsTtfb,
      prompt_tokens: this.usage?.prompt ?? null,
      completion_tokens: this.usage?.completion ?? null,
      model: this.usage?.model ?? null,
      tts_chars: this.audio?.chars ?? 0,
      kind: this.kind(),
    };
  }
}
```

- [ ] **Step 4: Wire the clock into the engine**

In `apps/orchestrator/src/engine/dialogue.ts`:

Add to the imports:

```ts
import { TurnClock } from "./turn-clock.js";
import type { AudioMeta } from "./transport.js";
import type { TurnTiming } from "@recall/shared";
```

Add to the hooks type the engine's constructor takes:

```ts
  /** One turn's measured stages. Not emitted for a turn that never reached the wire. */
  onTurnTiming: (timing: TurnTiming) => void;
```

Add a private field next to the existing `private turn: AbortController | null`:

```ts
  private clock: TurnClock | null = null;
```

At the top of `handleTurn` (line 254), immediately after the `if (this.finalised || this.detector.hasFired) return;` guard:

```ts
    this.clock = new TurnClock();
```

In the existing `finally` block at the end of `handleTurn`, emit and clear:

```ts
    } finally {
      const timing = this.clock?.finish() ?? null;
      this.clock = null;
      if (timing) this.hooks.onTurnTiming(timing);
      // ... whatever the existing finally body already does, kept verbatim
    }
```

In `speak` (line 973), stamp the three moments. Replace the verbatim branch's body:

```ts
        return await this.onTheWire(async () => {
          this.clock?.markWireFree();
          const line = this.state.say("agent", text, null);
          this.hooks.onAgentLine(text);
          const result = await this.transport.speak(text, {
            interruptible: opts.interruptible,
            onAudioMeta: (meta: AudioMeta) => this.clock?.noteAudio(meta),
            onFirstAudio: () => {
              this.clock?.markFirstAudio();
              opts.onFirstAudio?.();
            },
          });
          // The record keeps what was heard, not what was scripted.
          if (!result.completed) this.state.cut(line, result.heard);
          return result;
        });
```

and add, as the first statement inside `speak` after the `finalised` guard:

```ts
    this.clock?.markDecided();
```

For the generated branch, mark the kind and measure the first sentence:

```ts
      this.clock?.markGenerated();
      const generationStarted = Date.now();
      const spoken = await this.onTheWire(() => {
        this.clock?.markWireFree();
        return this.transport.speakStream(
          (async function* (self, source: AsyncIterable<string>) {
            let first = true;
            for await (const sentence of source) {
              if (first) {
                first = false;
                self.clock?.noteLlmFirstToken(Date.now() - generationStarted);
                self.clock?.markFirstAudio();
              }
              yield sentence;
            }
          })(
            this,
            streamSentences({
              system: voiceSystemPrompt(this.options.brief),
              messages: [{ role: "user", content: text }],
              signal: controller.signal,
            })
          ),
          controller.signal
        );
      });
```

In `answer` (line 307), record the extraction cost and the closed-field shortcut. Where the existing code destructures the result of `extract(...)`, add the usage note; where it takes the closed-field fast path without calling the model, mark it:

```ts
      const { accepted, rejected, intent, ms, usage } = await extract({ /* existing args, unchanged */ });
      this.clock?.noteLlm(ms, usage);
```

```ts
        // Matched in code, no model round trip. Marked so the dashboard can
        // keep these out of the model latency statistics entirely.
        this.clock?.markClosedField();
```

Read the surrounding code before editing and place the `markClosedField()` call on the branch that returns without awaiting `extract`.

- [ ] **Step 5: Wire the hook in `calls.ts`**

In `apps/orchestrator/src/calls.ts`, add to the `DialogueEngine` hooks object (after `onSection`):

```ts
          onTurnTiming: (timing) => {
            bus.emitEvent(callId, { type: "turn.timing", ...timing });
            // The journey engine has never emitted this. `first_audio_ms` is
            // exactly the number the rehearsal checklist asserts a median on,
            // and until now it was measured on echo calls only.
            bus.emitEvent(callId, {
              type: "latency.turn",
              ms: timing.first_audio_ms,
              utterance: "",
              over_budget: timing.first_audio_ms > 1000,
            });
          },
```

- [ ] **Step 6: Run the check to verify it passes**

Run: `corepack pnpm dialogue:check`
Expected: PASS, including the four new assertions.

Run: `corepack pnpm typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/orchestrator/src/engine apps/orchestrator/src/calls.ts
git commit -m "Measure the turn on journey calls

latency.turn was wired for EchoEngine only, so the number the rehearsal
checklist asserts a median on was never recorded on a real journey call.
The stage split makes that number a by-product: think, wire wait and TTS
time-to-first-byte tile the turn and sum to first audio.

A turn cut by barge-in before any audio reached the wire emits nothing.
Inventing a first-audio moment there would put a fabricated sample into
the percentile the budget is judged on."
```

---

### Task 5: Tell simulated calls apart from dialled ones

A sim-transport call with mocked voice returns TTS instantly and stamps every customer turn at 95% confidence.
Averaging those into latency statistics makes the agent look several times faster than it is.
That is the handoff document's "convincing transcript while nothing rang" failure, reappearing as a metrics lie.

**Files:**
- Create: `apps/orchestrator/sql/0002_add_simulated.sql`
- Modify: `apps/orchestrator/sql/schema.sql` (so a fresh install gets the column too)
- Modify: `apps/orchestrator/src/db/repo.ts` (`openCall`, `CallRow`, `CALL_COLUMNS`)
- Modify: `apps/orchestrator/src/calls.ts:73` (pass it through)
- Modify: `apps/orchestrator/src/api/routes.ts` (`summaryFromRow`)
- Modify: `packages/shared/src/call.ts` (`CallSummary`)

**Interfaces:**
- Consumes: nothing.
- Produces: `simulated: boolean` on `CallRow` in `db/repo.js` and on `CallSummary` in `@recall/shared`; an `openCall` option `simulated: boolean`.

- [ ] **Step 1: Write the migration**

Create `apps/orchestrator/sql/0002_add_simulated.sql`:

```sql
-- Tell a dialled call apart from a simulated one.
--
-- `test_run` cannot do this: it is written as a constant true on every row, so
-- it distinguishes nothing. What matters for analytics is whether a phone
-- actually rang. A sim-transport call with MOCK_VOICE=1 returns TTS instantly
-- and stamps every customer turn at 95% confidence, so averaging those into
-- latency statistics makes the agent look several times faster than it is.
--
-- Existing rows default to true. Every call written before this migration was
-- run predates any way of knowing, and counting an unknown as dialled would put
-- exactly the samples this column exists to exclude back into the numbers.
alter table calls add column if not exists simulated boolean not null default true;

create index if not exists calls_simulated_started_idx on calls (simulated, started_at desc);
```

Add the same column to `apps/orchestrator/sql/schema.sql` inside the `create table if not exists calls` block, after `test_run`:

```sql
  -- Whether a phone actually rang. See sql/0002_add_simulated.sql.
  simulated      boolean     not null default true
```

and the matching index next to the existing ones:

```sql
create index if not exists calls_simulated_started_idx on calls (simulated, started_at desc);
```

- [ ] **Step 2: Apply the migration**

Run the contents of `apps/orchestrator/sql/0002_add_simulated.sql` against the Supabase project in `SUPABASE_URL`, through the Supabase SQL editor.

Expected: `ALTER TABLE` and `CREATE INDEX` both succeed. Re-running it is a no-op because of `if not exists`.

- [ ] **Step 3: Write it on call open**

In `apps/orchestrator/src/db/repo.ts`, add the option and the column:

```ts
export async function openCall(opts: {
  callId: string;
  lead: Lead;
  journeyId: string;
  testRun: boolean;
  /** False only when a phone actually rang: pstn transport with real voice. */
  simulated: boolean;
}): Promise<void> {
```

```ts
  const { error } = await client.from("calls").insert({
    id: opts.callId,
    lead_id: opts.lead.id,
    phone: opts.lead.phone,
    journey_id: opts.journeyId,
    status: "queued" satisfies CallStatus,
    test_run: opts.testRun,
    simulated: opts.simulated,
  });
```

Add `simulated: boolean;` to the `CallRow` type and `simulated` to `CALL_COLUMNS`:

```ts
const CALL_COLUMNS =
  "id, lead_id, status, outcome, handoff_reason, started_at, ended_at, duration_s, fields_hands_free, fields_total, recording_url, test_run, simulated";
```

In `apps/orchestrator/src/calls.ts` at line 73, pass the same expression the `POST /calls` response already uses:

```ts
  await openCall({
    callId,
    lead,
    journeyId: journey.id,
    testRun: true,
    simulated: env.transport !== "pstn" || env.mockVoice,
  });
```

Ensure `env` is imported in `calls.ts`; if it is not, add `import { env } from "./env.js";`.

- [ ] **Step 4: Surface it on the summary**

In `packages/shared/src/call.ts`, add to `CallSummary` after `test_run`:

```ts
  /** False only when a phone actually rang. Analytics excludes simulated calls by default. */
  simulated: boolean;
```

In `apps/orchestrator/src/api/routes.ts`, set it in both builders. In `summaryFromEvents`, initialise `simulated: true` in the literal and set it from the hello event:

```ts
      case "call.hello":
        summary.lead_id = event.lead.id;
        summary.lead_name = event.lead.full_name;
        summary.test_run = event.test_run;
        summary.simulated = event.simulated ?? true;
        break;
```

In `summaryFromRow`, add `simulated: row.simulated,`.

- [ ] **Step 5: Verify**

Run: `corepack pnpm typecheck`
Expected: PASS.

Run: `corepack pnpm dev:api` in one shell, then in another:

```bash
curl -s localhost:8080/calls | head -c 400
```

Expected: each summary object carries a `simulated` field. Stop the orchestrator afterwards.

- [ ] **Step 6: Commit**

```bash
git add apps/orchestrator/sql apps/orchestrator/src/db/repo.ts apps/orchestrator/src/calls.ts apps/orchestrator/src/api/routes.ts packages/shared/src/call.ts
git commit -m "Record whether a phone actually rang

test_run is written as a constant true on every row, so it distinguishes
nothing. A sim call with mocked voice returns TTS instantly and scores
every turn at 95%, so averaging those into latency statistics makes the
agent look several times faster than it is. Existing rows default to
simulated, because a call written before this column existed cannot be
shown to have rung anything."
```

---

### Task 6: The pure aggregation module

This is where every number on the dashboard is actually computed.
It takes rows and returns the response body, touches no database, and is therefore the one part that can be tested exhaustively in milliseconds.
Write the checks first.

**Files:**
- Create: `apps/orchestrator/src/analytics/types.ts`
- Create: `apps/orchestrator/src/analytics/aggregate.ts`
- Create: `apps/orchestrator/src/analytics/aggregate.check.ts`
- Modify: `apps/orchestrator/package.json` and root `package.json` (the `analytics:check` script)

**Interfaces:**
- Consumes: `TurnTiming`, `TurnKind`, `CallOutcome`, `FieldState` from `@recall/shared`.
- Produces, all from `analytics/aggregate.js` and `analytics/types.js`:
  - `THIN_DATA_MIN_CALLS = 10`
  - `LATENCY_BUDGET_MS = 800`
  - `percentile(sorted: number[], p: number): number | null`
  - `summarise(values: number[]): Stats | null`
  - `buildAnalytics(input: AnalyticsInput): AnalyticsResponse`
  - types `Stats`, `TurnRow`, `CallLite`, `FieldEventRow`, `AnalyticsInput`, `AnalyticsResponse`

- [ ] **Step 1: Write the types**

Create `apps/orchestrator/src/analytics/types.ts`:

```ts
import type { CallOutcome, FieldState, TurnKind } from "@recall/shared";

/** A `turn.timing` payload as it comes back out of the audit trail. */
export type TurnRow = {
  call_id: string;
  at: string;
  think_ms: number;
  llm_ttfb_ms: number | null;
  llm_total_ms: number | null;
  wire_wait_ms: number;
  tts_ttfb_ms: number;
  first_audio_ms: number;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  model: string | null;
  tts_chars: number;
  kind: TurnKind;
};

/** Only the columns the dashboard reads. */
export type CallLite = {
  id: string;
  outcome: CallOutcome | null;
  handoff_reason: string | null;
  started_at: string;
  duration_s: number | null;
  fields_hands_free: number | null;
  fields_total: number | null;
  simulated: boolean;
};

/** A `field.update` payload, for the per-field accuracy table. */
export type FieldEventRow = {
  call_id: string;
  field: string;
  state: FieldState;
  confidence: number | null;
  attempts: number;
};

export type Stats = { p50: number; p90: number; min: number; max: number; n: number };

export type AnalyticsWindow = "24h" | "7d" | "30d" | "all";
export type AnalyticsSource = "dialled" | "all";

export type AnalyticsInput = {
  window: AnalyticsWindow;
  source: AnalyticsSource;
  from: string | null;
  to: string;
  calls: CallLite[];
  turns: TurnRow[];
  fieldEvents: FieldEventRow[];
};

export type TrendPoint = {
  day: string;
  calls: number;
  submitted: number;
  first_audio_p50: number | null;
};

export type FieldStat = {
  id: string;
  asked: number;
  captured_first_try: number;
  re_asks: number;
  mean_confidence: number | null;
  redacted: number;
};

export type AnalyticsResponse = {
  window: { window: AnalyticsWindow; source: AnalyticsSource; from: string | null; to: string };
  /** True when there is too little data for a trend to mean anything. */
  thin: boolean;
  thin_threshold: number;
  totals: {
    calls: number;
    dialled: number;
    simulated: number;
    by_outcome: Record<string, number>;
    by_handoff_reason: Record<string, number>;
  };
  accuracy: {
    hands_free_captured: number;
    hands_free_total: number;
    hands_free_rate: number | null;
    submitted_rate: number | null;
    median_duration_s: number | null;
  };
  latency: {
    budget_ms: number;
    turns: number;
    over_budget: number;
    first_audio: Stats | null;
    stages: { think: Stats | null; wire_wait: Stats | null; tts_ttfb: Stats | null };
    llm: { ttfb: Stats | null; total: Stats | null };
    by_kind: Record<TurnKind, Stats | null>;
    histogram: { from_ms: number; to_ms: number | null; count: number }[];
  };
  trend: TrendPoint[];
  fields: FieldStat[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    tts_chars: number;
    tts_chars_synthesised: number;
    by_model: Record<string, { prompt_tokens: number; completion_tokens: number; calls: number }>;
  };
};
```

- [ ] **Step 2: Write the failing checks**

Create `apps/orchestrator/src/analytics/aggregate.check.ts`:

```ts
/**
 * `pnpm analytics:check` - the arithmetic behind every number on the dashboard.
 *
 * Pure functions over fixture rows, so the whole thing runs in milliseconds
 * with no database. This is where the arithmetic errors hide: a percentile off
 * by one index, a null token count summed as a zero, or a simulated call quietly
 * dragging the latency median down.
 */
import { THIN_DATA_MIN_CALLS, buildAnalytics, percentile, summarise } from "./aggregate.js";
import type { CallLite, FieldEventRow, TurnRow } from "./types.js";

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "  ok " : "FAIL "} ${name}${ok || !detail ? "" : ` - ${detail}`}`);
  if (!ok) failed += 1;
}

// ---- percentiles
check("percentile of an empty set is null", percentile([], 50) === null);
check("p50 of one value is that value", percentile([7], 50) === 7);
check("p50 of 1..10 is 5", percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50) === 5, String(percentile([1,2,3,4,5,6,7,8,9,10], 50)));
check("p90 of 1..10 is 9", percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90) === 9, String(percentile([1,2,3,4,5,6,7,8,9,10], 90)));
check("p100 is the max", percentile([1, 2, 3], 100) === 3);

const stats = summarise([10, 20, 30, 40]);
check("summarise reports n", stats?.n === 4);
check("summarise reports min and max", stats?.min === 10 && stats?.max === 40);
check("summarise of nothing is null", summarise([]) === null);

// ---- fixtures
function turn(over: Partial<TurnRow> = {}): TurnRow {
  return {
    call_id: "c1",
    at: "2026-09-19T01:00:00.000Z",
    think_ms: 300,
    llm_ttfb_ms: null,
    llm_total_ms: 280,
    wire_wait_ms: 100,
    tts_ttfb_ms: 200,
    first_audio_ms: 600,
    prompt_tokens: 800,
    completion_tokens: 40,
    model: "gpt-4o-mini",
    tts_chars: 60,
    kind: "generated",
    ...over,
  };
}

function call(over: Partial<CallLite> = {}): CallLite {
  return {
    id: "c1",
    outcome: "submitted",
    handoff_reason: null,
    started_at: "2026-09-19T01:00:00.000Z",
    duration_s: 120,
    fields_hands_free: 11,
    fields_total: 15,
    simulated: false,
    ...over,
  };
}

function report(over: Partial<{ calls: CallLite[]; turns: TurnRow[]; fieldEvents: FieldEventRow[] }> = {}) {
  return buildAnalytics({
    window: "7d",
    source: "dialled",
    from: "2026-09-12T00:00:00.000Z",
    to: "2026-09-19T12:00:00.000Z",
    calls: over.calls ?? [call()],
    turns: over.turns ?? [turn()],
    fieldEvents: over.fieldEvents ?? [],
  });
}

// ---- the tiling identity
{
  const t = turn({ think_ms: 300, wire_wait_ms: 100, tts_ttfb_ms: 200, first_audio_ms: 600 });
  check("the three tiling stages sum to first audio", t.think_ms + t.wire_wait_ms + t.tts_ttfb_ms === t.first_audio_ms);
}

// ---- closed fields stay out of the model statistics
{
  const r = report({
    turns: [
      turn({ kind: "generated", llm_total_ms: 900 }),
      turn({ kind: "closed_field", llm_total_ms: null, llm_ttfb_ms: null, prompt_tokens: null, completion_tokens: null, model: null, first_audio_ms: 40, think_ms: 5, wire_wait_ms: 5, tts_ttfb_ms: 30 }),
    ],
  });
  check("llm stats count only turns that reached the model", r.latency.llm.total?.n === 1, String(r.latency.llm.total?.n));
  check("first-audio stats count every turn", r.latency.first_audio?.n === 2, String(r.latency.first_audio?.n));
  check("by_kind splits the two apart", r.latency.by_kind.closed_field?.n === 1 && r.latency.by_kind.generated?.n === 1);
}

// ---- cached lines stay out of the synthesis statistics
{
  const r = report({
    turns: [turn({ kind: "generated", tts_chars: 100 }), turn({ kind: "cached_line", tts_chars: 50 })],
  });
  check("tts_chars counts every line", r.usage.tts_chars === 150, String(r.usage.tts_chars));
  check("synthesised chars exclude cached lines", r.usage.tts_chars_synthesised === 100, String(r.usage.tts_chars_synthesised));
}

// ---- simulated calls are excluded from a dialled window
{
  const r = buildAnalytics({
    window: "7d",
    source: "dialled",
    from: "2026-09-12T00:00:00.000Z",
    to: "2026-09-19T12:00:00.000Z",
    calls: [call({ id: "real", simulated: false }), call({ id: "fake", simulated: true })],
    turns: [turn({ call_id: "real", first_audio_ms: 800 }), turn({ call_id: "fake", first_audio_ms: 10 })],
    fieldEvents: [],
  });
  check("a dialled window counts only dialled calls", r.totals.calls === 1, String(r.totals.calls));
  check("a dialled window drops simulated turns", r.latency.first_audio?.n === 1, String(r.latency.first_audio?.n));
  check("a simulated turn cannot drag the median down", r.latency.first_audio?.p50 === 800, String(r.latency.first_audio?.p50));
  check("the simulated count is still reported", r.totals.simulated === 1, String(r.totals.simulated));
}

// ---- null tokens do not poison the totals
{
  const r = report({
    turns: [
      turn({ prompt_tokens: 100, completion_tokens: 10 }),
      turn({ prompt_tokens: null, completion_tokens: null, model: null }),
    ],
  });
  check("null tokens are skipped, not summed as zero", r.usage.prompt_tokens === 100, String(r.usage.prompt_tokens));
  check("a turn with no model is not a model key", Object.keys(r.usage.by_model).length === 1, JSON.stringify(Object.keys(r.usage.by_model)));
}

// ---- thin data
{
  const thin = report({ calls: [call()] });
  check("one call is thin", thin.thin === true);
  check("the threshold is reported so the page can say it", thin.thin_threshold === THIN_DATA_MIN_CALLS);
  check("a thin window yields no trend", thin.trend.length === 0, `got ${thin.trend.length}`);

  const fat = report({
    calls: Array.from({ length: THIN_DATA_MIN_CALLS }, (_, i) => call({ id: `c${i}` })),
  });
  check("ten calls is not thin", fat.thin === false);
  check("a fat window yields a trend", fat.trend.length > 0);
}

// ---- accuracy
{
  const r = report({
    calls: [
      call({ id: "a", outcome: "submitted", fields_hands_free: 10, fields_total: 15, duration_s: 100 }),
      call({ id: "b", outcome: "handoff", handoff_reason: "CONFUSION", fields_hands_free: 5, fields_total: 15, duration_s: 200 }),
    ],
  });
  check("hands-free rate is over the summed totals", r.accuracy.hands_free_rate === 0.5, String(r.accuracy.hands_free_rate));
  check("submitted rate counts submitted over all", r.accuracy.submitted_rate === 0.5, String(r.accuracy.submitted_rate));
  check("median duration", r.accuracy.median_duration_s === 100, String(r.accuracy.median_duration_s));
  check("handoff reasons are counted", r.totals.by_handoff_reason.CONFUSION === 1);
  check("outcomes are counted", r.totals.by_outcome.submitted === 1 && r.totals.by_outcome.handoff === 1);
}

// ---- per-field accuracy
{
  const events: FieldEventRow[] = [
    { call_id: "a", field: "email", state: "asking", confidence: null, attempts: 0 },
    { call_id: "a", field: "email", state: "captured", confidence: 0.8, attempts: 0 },
    { call_id: "a", field: "email", state: "asking", confidence: null, attempts: 1 },
    { call_id: "a", field: "email", state: "confirmed", confidence: 0.9, attempts: 1 },
    { call_id: "b", field: "street", state: "asking", confidence: null, attempts: 0 },
    { call_id: "b", field: "street", state: "confirmed", confidence: 0.95, attempts: 0 },
  ];
  const r = report({ fieldEvents: events });
  const email = r.fields.find((f) => f.id === "email");
  const street = r.fields.find((f) => f.id === "street");
  check("a re-asked field records the re-ask", email?.re_asks === 1, String(email?.re_asks));
  check("a field asked once is captured first try", street?.captured_first_try === 1, String(street?.captured_first_try));
  check("mean confidence ignores the nulls", street?.mean_confidence === 0.95, String(street?.mean_confidence));
  check("fields are sorted worst first", r.fields[0]?.id === "email", String(r.fields[0]?.id));
}

// ---- over budget
{
  const r = report({ turns: [turn({ first_audio_ms: 400 }), turn({ first_audio_ms: 1200 })] });
  check("over-budget counts turns past the budget", r.latency.over_budget === 1, String(r.latency.over_budget));
  check("the budget is reported so the page does not hardcode it", r.latency.budget_ms === 800);
}

// ---- empty window
{
  const r = report({ calls: [], turns: [], fieldEvents: [] });
  check("an empty window does not throw", r.totals.calls === 0);
  check("an empty window reports null rather than zero", r.latency.first_audio === null && r.accuracy.hands_free_rate === null);
}

console.log(failed ? `\n${failed} failed` : "\nall ok");
process.exit(failed ? 1 : 0);
```

- [ ] **Step 3: Wire the script and run it to verify it fails**

Add to `apps/orchestrator/package.json` scripts:

```json
    "analytics:check": "tsx src/analytics/aggregate.check.ts",
```

Add to the root `package.json` scripts:

```json
    "analytics:check": "pnpm --filter orchestrator analytics:check",
```

Run: `corepack pnpm analytics:check`
Expected: FAIL. `./aggregate.js` does not exist.

- [ ] **Step 4: Write the aggregation**

Create `apps/orchestrator/src/analytics/aggregate.ts`:

```ts
import type { TurnKind } from "@recall/shared";
import type {
  AnalyticsInput,
  AnalyticsResponse,
  CallLite,
  FieldStat,
  Stats,
  TrendPoint,
  TurnRow,
} from "./types.js";

/**
 * Every number on the analytics dashboard, computed from rows.
 *
 * Pure on purpose. The database work lives in `query.ts`, so this file can be
 * exercised exhaustively in milliseconds by `pnpm analytics:check`, which is
 * where the arithmetic errors actually hide.
 *
 * Two rules run through all of it. A missing measurement is null and is skipped,
 * never zero and summed - a zero is a claim that something took no time or cost
 * no tokens. And a number that cannot be computed honestly is null rather than
 * a default, so the page can say "not enough data" instead of drawing a
 * confident zero.
 */

/** Below this many calls in the window, a per-day trend is decoration. */
export const THIN_DATA_MIN_CALLS = 10;

/** The turn budget the rehearsal checklist asserts a median against. */
export const LATENCY_BUDGET_MS = 800;

/** Nearest-rank, which for small samples is the honest one: every value reported is a value observed. */
export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.min(Math.max(rank, 1), sorted.length) - 1;
  return sorted[index] as number;
}

export function summarise(values: number[]): Stats | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return {
    p50: percentile(sorted, 50) as number,
    p90: percentile(sorted, 90) as number,
    min: sorted[0] as number,
    max: sorted[sorted.length - 1] as number,
    n: sorted.length,
  };
}

function numbers<T>(rows: T[], pick: (row: T) => number | null): number[] {
  const out: number[] = [];
  for (const row of rows) {
    const value = pick(row);
    if (typeof value === "number" && Number.isFinite(value)) out.push(value);
  }
  return out;
}

function day(iso: string): string {
  return iso.slice(0, 10);
}

function countBy<T>(rows: T[], pick: (row: T) => string | null): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) {
    const key = pick(row);
    if (key === null) continue;
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

const KINDS: TurnKind[] = ["closed_field", "cached_line", "generated"];

/** Fixed buckets, so two windows drawn side by side share an x axis. */
const HISTOGRAM_EDGES = [0, 200, 400, 600, 800, 1000, 1500, 2000, 3000];

function histogram(values: number[]): { from_ms: number; to_ms: number | null; count: number }[] {
  return HISTOGRAM_EDGES.map((from, i) => {
    const to = HISTOGRAM_EDGES[i + 1] ?? null;
    const count = values.filter((v) => v >= from && (to === null || v < to)).length;
    return { from_ms: from, to_ms: to, count };
  });
}

function fieldStats(events: AnalyticsInput["fieldEvents"]): FieldStat[] {
  // Per field per call, because "re-asked" is a fact about one call's attempt at
  // one field, not about the field across the whole window.
  const perCall = new Map<string, { field: string; attempts: number; redacted: boolean }>();
  const confidences = new Map<string, number[]>();

  for (const event of events) {
    const key = `${event.call_id} ${event.field}`;
    const seen = perCall.get(key) ?? { field: event.field, attempts: 0, redacted: false };
    seen.attempts = Math.max(seen.attempts, event.attempts);
    if (event.state === "redacted") seen.redacted = true;
    perCall.set(key, seen);

    if (typeof event.confidence === "number" && Number.isFinite(event.confidence)) {
      const list = confidences.get(event.field) ?? [];
      list.push(event.confidence);
      confidences.set(event.field, list);
    }
  }

  const byField = new Map<string, FieldStat>();
  for (const seen of perCall.values()) {
    const stat =
      byField.get(seen.field) ??
      ({ id: seen.field, asked: 0, captured_first_try: 0, re_asks: 0, mean_confidence: null, redacted: 0 } as FieldStat);
    stat.asked += 1;
    if (seen.attempts === 0) stat.captured_first_try += 1;
    stat.re_asks += seen.attempts;
    if (seen.redacted) stat.redacted += 1;
    byField.set(seen.field, stat);
  }

  for (const [field, list] of confidences) {
    const stat = byField.get(field);
    if (stat && list.length) stat.mean_confidence = list.reduce((a, b) => a + b, 0) / list.length;
  }

  // Worst first. The point of this table is to say which question the agent
  // keeps fumbling, so the answer has to be the top row.
  return [...byField.values()].sort((a, b) => {
    const aRate = a.asked ? a.re_asks / a.asked : 0;
    const bRate = b.asked ? b.re_asks / b.asked : 0;
    if (aRate !== bRate) return bRate - aRate;
    return a.id.localeCompare(b.id);
  });
}

function trend(calls: CallLite[], turns: TurnRow[]): TrendPoint[] {
  const days = new Map<string, { calls: number; submitted: number; latencies: number[] }>();
  for (const c of calls) {
    const key = day(c.started_at);
    const bucket = days.get(key) ?? { calls: 0, submitted: 0, latencies: [] };
    bucket.calls += 1;
    if (c.outcome === "submitted") bucket.submitted += 1;
    days.set(key, bucket);
  }
  for (const t of turns) {
    const key = day(t.at);
    const bucket = days.get(key);
    if (bucket) bucket.latencies.push(t.first_audio_ms);
  }
  return [...days.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([dayKey, bucket]) => ({
      day: dayKey,
      calls: bucket.calls,
      submitted: bucket.submitted,
      first_audio_p50: percentile(bucket.latencies, 50),
    }));
}

export function buildAnalytics(input: AnalyticsInput): AnalyticsResponse {
  const simulatedCount = input.calls.filter((c) => c.simulated).length;
  const calls = input.source === "dialled" ? input.calls.filter((c) => !c.simulated) : input.calls;
  const keep = new Set(calls.map((c) => c.id));
  const turns = input.turns.filter((t) => keep.has(t.call_id));
  const fieldEvents = input.fieldEvents.filter((e) => keep.has(e.call_id));

  const thin = calls.length < THIN_DATA_MIN_CALLS;

  const handsFreeCaptured = calls.reduce((sum, c) => sum + (c.fields_hands_free ?? 0), 0);
  const handsFreeTotal = calls.reduce((sum, c) => sum + (c.fields_total ?? 0), 0);
  const durations = numbers(calls, (c) => c.duration_s);

  const firstAudio = numbers(turns, (t) => t.first_audio_ms);

  const byModel: AnalyticsResponse["usage"]["by_model"] = {};
  let promptTokens = 0;
  let completionTokens = 0;
  for (const t of turns) {
    if (typeof t.prompt_tokens !== "number" || typeof t.completion_tokens !== "number" || !t.model) continue;
    promptTokens += t.prompt_tokens;
    completionTokens += t.completion_tokens;
    const entry = byModel[t.model] ?? { prompt_tokens: 0, completion_tokens: 0, calls: 0 };
    entry.prompt_tokens += t.prompt_tokens;
    entry.completion_tokens += t.completion_tokens;
    entry.calls += 1;
    byModel[t.model] = entry;
  }

  const byKind = {} as Record<TurnKind, Stats | null>;
  for (const kind of KINDS) {
    byKind[kind] = summarise(numbers(turns.filter((t) => t.kind === kind), (t) => t.first_audio_ms));
  }

  return {
    window: { window: input.window, source: input.source, from: input.from, to: input.to },
    thin,
    thin_threshold: THIN_DATA_MIN_CALLS,
    totals: {
      calls: calls.length,
      dialled: input.calls.length - simulatedCount,
      simulated: simulatedCount,
      by_outcome: countBy(calls, (c) => c.outcome),
      by_handoff_reason: countBy(calls, (c) => c.handoff_reason),
    },
    accuracy: {
      hands_free_captured: handsFreeCaptured,
      hands_free_total: handsFreeTotal,
      hands_free_rate: handsFreeTotal ? handsFreeCaptured / handsFreeTotal : null,
      submitted_rate: calls.length ? calls.filter((c) => c.outcome === "submitted").length / calls.length : null,
      median_duration_s: percentile(durations, 50),
    },
    latency: {
      budget_ms: LATENCY_BUDGET_MS,
      turns: turns.length,
      over_budget: firstAudio.filter((ms) => ms > LATENCY_BUDGET_MS).length,
      first_audio: summarise(firstAudio),
      stages: {
        think: summarise(numbers(turns, (t) => t.think_ms)),
        wire_wait: summarise(numbers(turns, (t) => t.wire_wait_ms)),
        tts_ttfb: summarise(numbers(turns, (t) => t.tts_ttfb_ms)),
      },
      llm: {
        ttfb: summarise(numbers(turns, (t) => t.llm_ttfb_ms)),
        total: summarise(numbers(turns, (t) => t.llm_total_ms)),
      },
      by_kind: byKind,
      histogram: histogram(firstAudio),
    },
    // A trend over fewer than the threshold is decoration, so it is not drawn
    // at all rather than drawn with a caveat underneath it.
    trend: thin ? [] : trend(calls, turns),
    fields: fieldStats(fieldEvents),
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      tts_chars: turns.reduce((sum, t) => sum + (t.tts_chars ?? 0), 0),
      tts_chars_synthesised: turns
        .filter((t) => t.kind !== "cached_line")
        .reduce((sum, t) => sum + (t.tts_chars ?? 0), 0),
      by_model: byModel,
    },
  };
}
```

- [ ] **Step 5: Run the checks to verify they pass**

Run: `corepack pnpm analytics:check`
Expected: PASS, `all ok`, every assertion listed.

Run: `corepack pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/orchestrator/src/analytics apps/orchestrator/package.json package.json
git commit -m "Compute the dashboard numbers, with no database in the way

Pure functions over rows, so the arithmetic can be exercised exhaustively
in milliseconds. Two rules run through all of it: a missing measurement
is null and skipped rather than zero and summed, and a number that cannot
be computed honestly is null so the page can say so rather than draw a
confident zero.

Percentiles are nearest-rank, which for a handful of calls is the honest
choice - every value reported is a value actually observed."
```

---

### Task 7: The query layer and the endpoint

**Files:**
- Create: `apps/orchestrator/src/analytics/query.ts`
- Modify: `apps/orchestrator/src/api/routes.ts` (add the route near the history section)

**Interfaces:**
- Consumes: everything from Task 6; `sb()` from `db/supabase.js`.
- Produces: `loadAnalytics(window: AnalyticsWindow, source: AnalyticsSource): Promise<AnalyticsResponse>` from `analytics/query.js`, which throws `Error("supabase is not configured")` when there is no client.

- [ ] **Step 1: Write the query layer**

Create `apps/orchestrator/src/analytics/query.ts`:

```ts
import { sb } from "../db/supabase.js";
import { log } from "../log.js";
import { buildAnalytics } from "./aggregate.js";
import type {
  AnalyticsResponse,
  AnalyticsSource,
  AnalyticsWindow,
  CallLite,
  FieldEventRow,
  TurnRow,
} from "./types.js";

/**
 * The database half of the dashboard.
 *
 * Aggregation runs over `call_events` rather than a table of its own. That table
 * is already the single audit mirror of the SSE union, which is what makes a
 * finished call replayable; a second write path would give the call detail page
 * two sources for one number, and they can disagree. If volume ever makes the
 * JSONB scan slow, a materialised view goes behind this file without the
 * endpoint changing shape.
 */

const WINDOW_MS: Record<AnalyticsWindow, number | null> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
  all: null,
};

/** Opening the page twice in a row must not rescan. */
const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { at: number; value: AnalyticsResponse }>();

export function clearAnalyticsCache(): void {
  cache.clear();
}

export async function loadAnalytics(
  window: AnalyticsWindow,
  source: AnalyticsSource
): Promise<AnalyticsResponse> {
  const key = `${window}:${source}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  const client = sb();
  if (!client) throw new Error("supabase is not configured");

  const to = new Date();
  const span = WINDOW_MS[window];
  const from = span === null ? null : new Date(to.getTime() - span);

  let callQuery = client
    .from("calls")
    .select("id, outcome, handoff_reason, started_at, duration_s, fields_hands_free, fields_total, simulated")
    .order("started_at", { ascending: false })
    .limit(2000);
  if (from) callQuery = callQuery.gte("started_at", from.toISOString());

  const { data: callRows, error: callError } = await callQuery;
  if (callError) {
    log.warn(`analytics.calls: ${callError.message}`);
    throw new Error(callError.message);
  }

  const calls = (callRows ?? []).map(
    (row): CallLite => ({
      id: String(row.id),
      outcome: (row.outcome as CallLite["outcome"]) ?? null,
      handoff_reason: (row.handoff_reason as string | null) ?? null,
      started_at: String(row.started_at),
      duration_s: (row.duration_s as number | null) ?? null,
      fields_hands_free: (row.fields_hands_free as number | null) ?? null,
      fields_total: (row.fields_total as number | null) ?? null,
      // A row written before the column existed reads as simulated. Counting an
      // unknown as dialled would put exactly the samples the column exists to
      // exclude back into the latency numbers.
      simulated: row.simulated !== false,
    })
  );

  // No calls in the window means no events worth fetching, and an `in` filter
  // on an empty list is a query that matches everything on some drivers.
  if (!calls.length) {
    const empty = buildAnalytics({
      window,
      source,
      from: from?.toISOString() ?? null,
      to: to.toISOString(),
      calls: [],
      turns: [],
      fieldEvents: [],
    });
    cache.set(key, { at: Date.now(), value: empty });
    return empty;
  }

  const ids = calls.map((c) => c.id);

  const [{ data: turnRows, error: turnError }, { data: fieldRows, error: fieldError }] = await Promise.all([
    client.from("call_events").select("call_id, at, payload").eq("type", "turn.timing").in("call_id", ids).limit(50_000),
    client.from("call_events").select("call_id, payload").eq("type", "field.update").in("call_id", ids).limit(50_000),
  ]);

  if (turnError) log.warn(`analytics.turns: ${turnError.message}`);
  if (fieldError) log.warn(`analytics.fields: ${fieldError.message}`);

  const turns = (turnRows ?? []).map((row): TurnRow => {
    const p = (row.payload ?? {}) as Record<string, unknown>;
    const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
    return {
      call_id: String(row.call_id),
      at: String(row.at),
      think_ms: num(p.think_ms) ?? 0,
      llm_ttfb_ms: num(p.llm_ttfb_ms),
      llm_total_ms: num(p.llm_total_ms),
      wire_wait_ms: num(p.wire_wait_ms) ?? 0,
      tts_ttfb_ms: num(p.tts_ttfb_ms) ?? 0,
      first_audio_ms: num(p.first_audio_ms) ?? 0,
      prompt_tokens: num(p.prompt_tokens),
      completion_tokens: num(p.completion_tokens),
      model: typeof p.model === "string" ? p.model : null,
      tts_chars: num(p.tts_chars) ?? 0,
      kind: (p.kind as TurnRow["kind"]) ?? "generated",
    };
  });

  const fieldEvents = (fieldRows ?? []).map((row): FieldEventRow => {
    const p = (row.payload ?? {}) as Record<string, unknown>;
    return {
      call_id: String(row.call_id),
      field: String(p.field ?? ""),
      state: p.state as FieldEventRow["state"],
      confidence: typeof p.confidence === "number" ? p.confidence : null,
      attempts: typeof p.attempts === "number" ? p.attempts : 0,
    };
  });

  const value = buildAnalytics({
    window,
    source,
    from: from?.toISOString() ?? null,
    to: to.toISOString(),
    calls,
    turns,
    fieldEvents,
  });
  cache.set(key, { at: Date.now(), value });
  return value;
}
```

- [ ] **Step 2: Add the route**

In `apps/orchestrator/src/api/routes.ts`, add the import:

```ts
import { loadAnalytics } from "../analytics/query.js";
import type { AnalyticsSource, AnalyticsWindow } from "../analytics/types.js";
```

and the route, in the history section near `GET /calls`:

```ts
const WINDOWS: AnalyticsWindow[] = ["24h", "7d", "30d", "all"];

/**
 * The whole analytics dashboard in one response.
 *
 * One request rather than four, because the page is one screen: a single
 * loading state and no waterfall. Everything is computed from the audit trail,
 * so this endpoint is read-only and cannot affect a call.
 */
api.get("/analytics", async (req, res) => {
  const windowParam = String(req.query.window ?? "7d");
  const window = (WINDOWS as string[]).includes(windowParam) ? (windowParam as AnalyticsWindow) : "7d";
  const source: AnalyticsSource = String(req.query.source ?? "dialled") === "all" ? "all" : "dialled";

  try {
    res.json(await loadAnalytics(window, source));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // 503 rather than 500: the orchestrator is fine, its audit database is not,
    // and the page says exactly that instead of rendering zeroes that read as
    // real measurements.
    res.status(503).json({ error: `analytics unavailable: ${message}` });
  }
});
```

- [ ] **Step 3: Verify against the running orchestrator**

Run: `pkill -f "tsx watch src/index.ts"` then `corepack pnpm dev:api`

In another shell:

```bash
curl -s "localhost:8080/analytics?window=all&source=all" | head -c 600
```

Expected: a JSON object with `window`, `thin`, `totals`, `accuracy`, `latency`, `trend`, `fields`, `usage`. With no `turn.timing` rows in the database yet, `latency.first_audio` is null and `totals.calls` reflects the existing call rows.

```bash
curl -s "localhost:8080/analytics?window=nonsense" | python3 -c "import json,sys; print(json.load(sys.stdin)['window'])"
```

Expected: `{'window': '7d', 'source': 'dialled', ...}` - a bad window falls back rather than erroring.

- [ ] **Step 4: Commit**

```bash
git add apps/orchestrator/src/analytics/query.ts apps/orchestrator/src/api/routes.ts
git commit -m "Serve the dashboard from one endpoint

Aggregated over call_events rather than a table of its own: that table is
already the single audit mirror of the event union, and a second write
path would give the call detail page two sources for one number.

A database outage is a 503 with a reason, not zeroes that read as real
measurements."
```

---

### Task 8: Chart primitives

Small, focused SVG components.
Each one does a single shape and takes its colour from the CSS variables already in `globals.css`.

**Files:**
- Create: `apps/web/components/analytics/StatTile.tsx`
- Create: `apps/web/components/analytics/Histogram.tsx`
- Create: `apps/web/components/analytics/StageBars.tsx`
- Create: `apps/web/components/analytics/TrendChart.tsx`
- Create: `apps/web/components/analytics/OutcomeBar.tsx`
- Create: `apps/web/components/analytics/FieldTable.tsx`
- Create: `apps/web/components/analytics/Thin.tsx`
- Modify: `apps/web/app/globals.css` (append an analytics section)

**Interfaces:**
- Consumes: the `AnalyticsResponse` shape from Task 6, mirrored into the web app in Task 9.
- Produces, all default-free named exports:
  - `StatTile({ label, value, sub, tone, meter })`
  - `Histogram({ buckets, budgetMs })`
  - `StageBars({ stages, total })`
  - `TrendChart({ points })`
  - `OutcomeBar({ counts, total })`
  - `FieldTable({ fields })`
  - `Thin({ calls, threshold, what })`

- [ ] **Step 1: Read the design guidance**

Before writing any chart code, load the `dataviz` skill and the `frontend-design` skill.
The palette must come from the variables already in `globals.css` (`--info`, `--info-line`, `--warn`, `--warn-line`, `--success`, `--success-line`, `--error`, `--error-line`, `--muted`, `--hairline`), not from new hex values.

- [ ] **Step 2: Write the thin-data notice**

Create `apps/web/components/analytics/Thin.tsx`:

```tsx
/**
 * What a chart renders instead of a line when there is not enough behind it.
 *
 * Five dialled calls drawn as a trend is decoration that reads as evidence.
 * This is the component that refuses to do that, which is why it is a component
 * and not a sentence in the copy.
 */
export function Thin({ calls, threshold, what }: { calls: number; threshold: number; what: string }) {
  return (
    <div className="thin" role="status">
      <span className="thin-count">{calls}</span>
      <span className="thin-text">
        {calls === 1 ? "call" : "calls"} in this window. {what} needs at least {threshold} to mean anything.
      </span>
    </div>
  );
}
```

- [ ] **Step 3: Write the stat tile**

Create `apps/web/components/analytics/StatTile.tsx`:

```tsx
/**
 * One headline number, with the threshold it is being judged against.
 *
 * The threshold is the point. "1.18s" says nothing on its own; "1.18s against a
 * 800ms budget" is a verdict, and a tile that shows the first without the second
 * is decoration.
 */
export function StatTile({
  label,
  value,
  sub,
  tone = "neutral",
  meter,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "neutral" | "good" | "warn" | "bad";
  /** 0..1 against the threshold named in `sub`. Omitted when there is nothing to compare to. */
  meter?: number | null;
}) {
  return (
    <div className={`tile tile-${tone}`}>
      <span className="tile-label">{label}</span>
      <span className="tile-value">{value}</span>
      {sub && <span className="tile-sub">{sub}</span>}
      {typeof meter === "number" && (
        <span className="tile-meter" aria-hidden="true">
          <span className="tile-meter-fill" style={{ width: `${Math.min(Math.max(meter, 0), 1) * 100}%` }} />
        </span>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Write the histogram**

Create `apps/web/components/analytics/Histogram.tsx`:

```tsx
type Bucket = { from_ms: number; to_ms: number | null; count: number };

/**
 * The first-audio distribution, with the budget drawn as a rule.
 *
 * A distribution rather than an average because the average is the one number
 * that cannot show you the tail, and the tail is what breaks calls.
 */
export function Histogram({ buckets, budgetMs }: { buckets: Bucket[]; budgetMs: number }) {
  const max = Math.max(1, ...buckets.map((b) => b.count));
  const width = 640;
  const height = 180;
  const padLeft = 34;
  const padBottom = 26;
  const plotWidth = width - padLeft - 8;
  const plotHeight = height - padBottom - 8;
  const barWidth = plotWidth / buckets.length;

  // Where the budget falls, as a fraction across the bucket edges.
  const edges = buckets.map((b) => b.from_ms);
  const last = buckets[buckets.length - 1];
  const span = (last?.to_ms ?? (last?.from_ms ?? 0) + 1000) - (edges[0] ?? 0);
  const budgetX = padLeft + ((budgetMs - (edges[0] ?? 0)) / span) * plotWidth;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="chart" role="img" aria-label="First audio distribution">
      <line x1={padLeft} y1={8 + plotHeight} x2={width - 8} y2={8 + plotHeight} stroke="var(--hairline-strong)" />
      {buckets.map((bucket, i) => {
        const barHeight = (bucket.count / max) * plotHeight;
        const overBudget = bucket.from_ms >= budgetMs;
        return (
          <rect
            key={bucket.from_ms}
            x={padLeft + i * barWidth + 2}
            y={8 + plotHeight - barHeight}
            width={Math.max(barWidth - 4, 1)}
            height={barHeight}
            rx="2"
            fill={overBudget ? "var(--warn-line)" : "var(--info-line)"}
          >
            <title>
              {bucket.from_ms}
              {bucket.to_ms === null ? "ms and up" : ` to ${bucket.to_ms}ms`}: {bucket.count}
            </title>
          </rect>
        );
      })}
      <line
        x1={budgetX}
        y1={4}
        x2={budgetX}
        y2={8 + plotHeight}
        stroke="var(--error-line)"
        strokeWidth="1.5"
        strokeDasharray="4 3"
      />
      <text x={budgetX + 4} y={16} className="chart-note" fill="var(--error)">
        {budgetMs}ms budget
      </text>
      <text x={padLeft} y={height - 8} className="chart-axis" fill="var(--muted)">
        0
      </text>
      <text x={width - 8} y={height - 8} textAnchor="end" className="chart-axis" fill="var(--muted)">
        {last?.from_ms ?? 0}ms+
      </text>
      <text x={4} y={16} className="chart-axis" fill="var(--muted)">
        {max}
      </text>
    </svg>
  );
}
```

- [ ] **Step 5: Write the stage bars**

Create `apps/web/components/analytics/StageBars.tsx`:

```tsx
type Stage = { id: string; label: string; p50: number | null; hint: string };

/**
 * Where the time inside a turn goes.
 *
 * The three stages tile the turn, so they are drawn as one bar cut into three
 * rather than three bars side by side. Reading them as parts of a whole is the
 * entire point.
 */
export function StageBars({ stages, total }: { stages: Stage[]; total: number | null }) {
  const known = stages.filter((s) => typeof s.p50 === "number") as (Stage & { p50: number })[];
  const sum = known.reduce((acc, s) => acc + s.p50, 0);
  if (!known.length || sum <= 0) return null;
  const colours = ["var(--info-line)", "var(--muted-soft)", "var(--warn-line)"];

  return (
    <div className="stages">
      <div className="stages-bar" role="img" aria-label="Turn stages at the median">
        {known.map((stage, i) => (
          <span
            key={stage.id}
            className="stages-slice"
            style={{ width: `${(stage.p50 / sum) * 100}%`, background: colours[i % colours.length] }}
            title={`${stage.label}: ${stage.p50}ms`}
          />
        ))}
      </div>
      <ul className="stages-key">
        {known.map((stage, i) => (
          <li key={stage.id}>
            <span className="stages-dot" style={{ background: colours[i % colours.length] }} />
            <span className="stages-name">{stage.label}</span>
            <span className="stages-ms">{stage.p50}ms</span>
            <span className="stages-hint">{stage.hint}</span>
          </li>
        ))}
      </ul>
      {typeof total === "number" && <p className="stages-total">Median turn: {total}ms</p>}
    </div>
  );
}
```

- [ ] **Step 6: Write the trend chart**

Create `apps/web/components/analytics/TrendChart.tsx`:

```tsx
type Point = { day: string; calls: number; submitted: number; first_audio_p50: number | null };

/** Median first audio per day, with the call count behind it as bars. */
export function TrendChart({ points, budgetMs }: { points: Point[]; budgetMs: number }) {
  if (points.length < 2) return null;
  const width = 640;
  const height = 200;
  const pad = { left: 40, right: 12, top: 12, bottom: 28 };
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;

  const latencies = points.map((p) => p.first_audio_p50).filter((v): v is number => typeof v === "number");
  const maxLatency = Math.max(budgetMs * 1.25, ...latencies, 1);
  const maxCalls = Math.max(1, ...points.map((p) => p.calls));
  const step = plotWidth / Math.max(points.length - 1, 1);

  const x = (i: number) => pad.left + i * step;
  const y = (ms: number) => pad.top + plotHeight - (ms / maxLatency) * plotHeight;

  const line = points
    .map((p, i) => (typeof p.first_audio_p50 === "number" ? `${i === 0 ? "M" : "L"}${x(i)},${y(p.first_audio_p50)}` : null))
    .filter(Boolean)
    .join(" ");

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="chart" role="img" aria-label="Median first audio per day">
      {points.map((p, i) => {
        const barHeight = (p.calls / maxCalls) * plotHeight * 0.4;
        return (
          <rect
            key={p.day}
            x={x(i) - Math.min(step, 24) / 2}
            y={pad.top + plotHeight - barHeight}
            width={Math.min(step, 24)}
            height={barHeight}
            fill="var(--hairline)"
          >
            <title>{`${p.day}: ${p.calls} calls, ${p.submitted} submitted`}</title>
          </rect>
        );
      })}
      <line
        x1={pad.left}
        y1={y(budgetMs)}
        x2={width - pad.right}
        y2={y(budgetMs)}
        stroke="var(--error-line)"
        strokeDasharray="4 3"
      />
      <text x={pad.left} y={y(budgetMs) - 4} className="chart-note" fill="var(--error)">
        {budgetMs}ms
      </text>
      {line && <path d={line} fill="none" stroke="var(--info-line)" strokeWidth="2" />}
      {points.map((p, i) =>
        typeof p.first_audio_p50 === "number" ? (
          <circle key={p.day} cx={x(i)} cy={y(p.first_audio_p50)} r="3" fill="var(--info)">
            <title>{`${p.day}: ${p.first_audio_p50}ms median`}</title>
          </circle>
        ) : null
      )}
      <line x1={pad.left} y1={pad.top + plotHeight} x2={width - pad.right} y2={pad.top + plotHeight} stroke="var(--hairline-strong)" />
      <text x={pad.left} y={height - 8} className="chart-axis" fill="var(--muted)">
        {points[0]?.day.slice(5)}
      </text>
      <text x={width - pad.right} y={height - 8} textAnchor="end" className="chart-axis" fill="var(--muted)">
        {points[points.length - 1]?.day.slice(5)}
      </text>
    </svg>
  );
}
```

- [ ] **Step 7: Write the outcome bar and the field table**

Create `apps/web/components/analytics/OutcomeBar.tsx`:

```tsx
/** How the calls in this window ended, as one bar. */
const TONE: Record<string, string> = {
  submitted: "var(--success-line)",
  handoff: "var(--warn-line)",
  incomplete: "var(--muted-soft)",
  no_answer: "var(--hairline-strong)",
  abandoned: "var(--hairline-strong)",
  disconnected: "var(--muted-soft)",
  declined: "var(--error-line)",
};

export function OutcomeBar({ counts }: { counts: Record<string, number> }) {
  const entries = Object.entries(counts).sort(([, a], [, b]) => b - a);
  const total = entries.reduce((sum, [, n]) => sum + n, 0);
  if (!total) return null;

  return (
    <div className="outcomes">
      <div className="outcomes-bar" role="img" aria-label="Outcome mix">
        {entries.map(([outcome, n]) => (
          <span
            key={outcome}
            className="outcomes-slice"
            style={{ width: `${(n / total) * 100}%`, background: TONE[outcome] ?? "var(--muted-soft)" }}
            title={`${outcome.replace(/_/g, " ")}: ${n}`}
          />
        ))}
      </div>
      <ul className="outcomes-key">
        {entries.map(([outcome, n]) => (
          <li key={outcome}>
            <span className="outcomes-dot" style={{ background: TONE[outcome] ?? "var(--muted-soft)" }} />
            <span className="outcomes-name">{outcome.replace(/_/g, " ")}</span>
            <span className="outcomes-n">{n}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

Create `apps/web/components/analytics/FieldTable.tsx`:

```tsx
type FieldStat = {
  id: string;
  asked: number;
  captured_first_try: number;
  re_asks: number;
  mean_confidence: number | null;
  redacted: number;
};

/**
 * Which question the agent keeps fumbling.
 *
 * Sorted worst first by the server, so the answer is the top row rather than
 * something to hunt for.
 */
export function FieldTable({ fields }: { fields: FieldStat[] }) {
  if (!fields.length) return <p className="empty">No fields have been asked yet.</p>;

  return (
    <table className="field-table">
      <thead>
        <tr>
          <th scope="col">Field</th>
          <th scope="col">Asked</th>
          <th scope="col">First try</th>
          <th scope="col">Re-asks</th>
          <th scope="col">Confidence</th>
        </tr>
      </thead>
      <tbody>
        {fields.map((field) => {
          const firstTry = field.asked ? field.captured_first_try / field.asked : null;
          return (
            <tr key={field.id}>
              <th scope="row">
                {field.id.replace(/_/g, " ")}
                {field.redacted > 0 && <span className="chip chip-error">redacted {field.redacted}</span>}
              </th>
              <td>{field.asked}</td>
              <td>{firstTry === null ? "-" : `${Math.round(firstTry * 100)}%`}</td>
              <td className={field.re_asks > 0 ? "num-warn" : undefined}>{field.re_asks}</td>
              <td>{field.mean_confidence === null ? "-" : `${Math.round(field.mean_confidence * 100)}%`}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
```

- [ ] **Step 8: Add the styles**

Append an analytics section to `apps/web/app/globals.css`, following the file's existing commenting style and using only variables already defined at the top of that file. Cover: `.analytics-grid`, `.tile` and its modifiers, `.tile-meter`, `.chart`, `.chart-axis`, `.chart-note`, `.stages` and children, `.outcomes` and children, `.field-table`, `.num-warn`, `.thin`. Keep cards white on `--hairline`, matching the existing `.call-row` and `.notice` rules.

- [ ] **Step 9: Verify it compiles**

Run: `corepack pnpm typecheck`
Expected: PASS. The components are not imported anywhere yet, which is fine.

- [ ] **Step 10: Commit**

```bash
git add apps/web/components/analytics apps/web/app/globals.css
git commit -m "Draw the charts by hand, in the console's own language

No chart library: it would bring half a megabyte and its own visual
defaults, and these five shapes are simple. Colours come only from the
variables already in globals.css, so the console stays light.

Thin is a component rather than a line of copy because refusing to draw
five calls as a trend has to be enforced somewhere."
```

---

### Task 9: The analytics page

**Files:**
- Create: `apps/web/lib/analytics.ts` (the response type, mirrored)
- Create: `apps/web/app/analytics/page.tsx`
- Modify: `apps/web/components/Nav.tsx`

**Interfaces:**
- Consumes: every component from Task 8; `getJson` from `lib/api`.
- Produces: `AnalyticsResponse` type from `lib/analytics`; the `/analytics` route.

- [ ] **Step 1: Mirror the response type**

Create `apps/web/lib/analytics.ts` containing the `AnalyticsResponse`, `Stats`, `TrendPoint` and `FieldStat` types exactly as defined in `apps/orchestrator/src/analytics/types.ts` in Task 6, plus these helpers:

```ts
export function ms(value: number | null): string {
  if (value === null) return "-";
  return value >= 1000 ? `${(value / 1000).toFixed(2)}s` : `${Math.round(value)}ms`;
}

export function pct(value: number | null): string {
  return value === null ? "-" : `${Math.round(value * 100)}%`;
}
```

These types are duplicated rather than imported from `@recall/shared` because they describe one endpoint's response rather than the SSE contract the two apps must agree on.
Add a comment saying so at the top of the file.

- [ ] **Step 2: Add the nav link**

In `apps/web/components/Nav.tsx`, the wordmark stays the only fixed left item; add a link row after it:

```tsx
      <nav className="nav-links">
        <Link href="/calls">Calls</Link>
        <Link href="/analytics">Analytics</Link>
      </nav>
```

Add a `.nav-links` rule to `globals.css` matching the existing nav typography.

- [ ] **Step 3: Write the page**

Create `apps/web/app/analytics/page.tsx`:

```tsx
"use client";

import { useEffect, useState } from "react";
import { getJson } from "../../lib/api";
import { Nav } from "../../components/Nav";
import { StatTile } from "../../components/analytics/StatTile";
import { Histogram } from "../../components/analytics/Histogram";
import { StageBars } from "../../components/analytics/StageBars";
import { TrendChart } from "../../components/analytics/TrendChart";
import { OutcomeBar } from "../../components/analytics/OutcomeBar";
import { FieldTable } from "../../components/analytics/FieldTable";
import { Thin } from "../../components/analytics/Thin";
import { ms, pct, type AnalyticsResponse } from "../../lib/analytics";

const WINDOWS = [
  { id: "24h", label: "24 hours" },
  { id: "7d", label: "7 days" },
  { id: "30d", label: "30 days" },
  { id: "all", label: "All time" },
] as const;

/**
 * Is the agent fast, and is it accurate.
 *
 * Simulated calls are excluded by default. A sim call with mocked voice returns
 * TTS instantly and scores every turn at 95%, so including them makes the agent
 * look several times faster than it is.
 */
export default function Analytics() {
  const [window, setWindow] = useState<(typeof WINDOWS)[number]["id"]>("7d");
  const [includeSimulated, setIncludeSimulated] = useState(false);
  const [data, setData] = useState<AnalyticsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setError(null);
    void getJson<AnalyticsResponse>(`/analytics?window=${window}&source=${includeSimulated ? "all" : "dialled"}`)
      .then((next) => live && setData(next))
      .catch((err) => live && setError(err instanceof Error ? err.message : "Orchestrator is not reachable."));
    return () => {
      live = false;
    };
  }, [window, includeSimulated]);

  const budget = data?.latency.budget_ms ?? 800;
  const p50 = data?.latency.first_audio?.p50 ?? null;

  return (
    <div className="console">
      <Nav />

      <section className="step-body" aria-label="Analytics">
        <div className="intro">
          <h1 className="intro-title">Analytics</h1>
          <p className="intro-sub">
            Whether the agent is fast enough to hold a phone call, and accurate enough to be trusted with the form.
          </p>
        </div>

        <div className="analytics-controls">
          <div className="segmented" role="group" aria-label="Time window">
            {WINDOWS.map((option) => (
              <button
                key={option.id}
                type="button"
                className={`segmented-option${window === option.id ? " is-on" : ""}`}
                onClick={() => setWindow(option.id)}
              >
                {option.label}
              </button>
            ))}
          </div>
          <label className="toggle">
            <input
              type="checkbox"
              checked={includeSimulated}
              onChange={(event) => setIncludeSimulated(event.target.checked)}
            />
            Include simulated calls
          </label>
        </div>

        {error && (
          <div className="notice" role="status">
            {error}
          </div>
        )}

        {!data && !error && <p className="empty">Loading.</p>}

        {data && (
          <>
            <div className="analytics-tiles">
              <StatTile
                label="Median first audio"
                value={ms(p50)}
                sub={`against a ${budget}ms budget`}
                tone={p50 === null ? "neutral" : p50 <= budget ? "good" : "bad"}
                meter={p50 === null ? null : p50 / budget}
              />
              <StatTile
                label="Hands free"
                value={pct(data.accuracy.hands_free_rate)}
                sub={`${data.accuracy.hands_free_captured} of ${data.accuracy.hands_free_total} fields, 25% is the bar`}
                tone={
                  data.accuracy.hands_free_rate === null
                    ? "neutral"
                    : data.accuracy.hands_free_rate >= 0.25
                      ? "good"
                      : "warn"
                }
                meter={data.accuracy.hands_free_rate}
              />
              <StatTile
                label="Submitted"
                value={pct(data.accuracy.submitted_rate)}
                sub={`${data.totals.by_outcome.submitted ?? 0} of ${data.totals.calls} calls`}
                tone="neutral"
                meter={data.accuracy.submitted_rate}
              />
              <StatTile
                label="Calls"
                value={String(data.totals.calls)}
                sub={
                  includeSimulated
                    ? `${data.totals.simulated} simulated included`
                    : `${data.totals.simulated} simulated excluded`
                }
                tone="neutral"
              />
            </div>

            <div className="analytics-row">
              <section className="card">
                <h2 className="card-title">First audio, every turn</h2>
                <p className="card-sub">
                  {data.latency.turns} turns, {data.latency.over_budget} over the {budget}ms budget.
                </p>
                {data.latency.turns === 0 ? (
                  <p className="empty">No measured turns yet. Run a call.</p>
                ) : (
                  <Histogram buckets={data.latency.histogram} budgetMs={budget} />
                )}
              </section>

              <section className="card">
                <h2 className="card-title">Where the turn goes</h2>
                <p className="card-sub">At the median. The three stages tile the turn.</p>
                <StageBars
                  total={p50}
                  stages={[
                    {
                      id: "think",
                      label: "Think",
                      p50: data.latency.stages.think?.p50 ?? null,
                      hint: "transcript to reply decided",
                    },
                    {
                      id: "wire",
                      label: "Wire wait",
                      p50: data.latency.stages.wire_wait?.p50 ?? null,
                      hint: "previous line still playing",
                    },
                    {
                      id: "tts",
                      label: "TTS",
                      p50: data.latency.stages.tts_ttfb?.p50 ?? null,
                      hint: "text to first audio frame",
                    },
                  ]}
                />
              </section>
            </div>

            <div className="analytics-row">
              <section className="card">
                <h2 className="card-title">Over time</h2>
                {data.thin ? (
                  <Thin calls={data.totals.calls} threshold={data.thin_threshold} what="A daily trend" />
                ) : (
                  <TrendChart points={data.trend} budgetMs={budget} />
                )}
              </section>

              <section className="card">
                <h2 className="card-title">How calls ended</h2>
                <OutcomeBar counts={data.totals.by_outcome} />
              </section>
            </div>

            <section className="card">
              <h2 className="card-title">Which question the agent fumbles</h2>
              <p className="card-sub">Worst first, by re-asks per call that reached the field.</p>
              <FieldTable fields={data.fields} />
            </section>

            <section className="card">
              <h2 className="card-title">Usage</h2>
              <ul className="usage-list">
                <li>
                  <span>Prompt tokens</span>
                  <span>{data.usage.prompt_tokens.toLocaleString()}</span>
                </li>
                <li>
                  <span>Completion tokens</span>
                  <span>{data.usage.completion_tokens.toLocaleString()}</span>
                </li>
                <li>
                  <span>TTS characters synthesised</span>
                  <span>{data.usage.tts_chars_synthesised.toLocaleString()}</span>
                </li>
                <li>
                  <span>TTS characters played from cache</span>
                  <span>{(data.usage.tts_chars - data.usage.tts_chars_synthesised).toLocaleString()}</span>
                </li>
              </ul>
            </section>
          </>
        )}
      </section>
    </div>
  );
}
```

- [ ] **Step 4: Add the remaining styles**

Append rules for `.analytics-controls`, `.segmented`, `.segmented-option`, `.toggle`, `.analytics-tiles`, `.analytics-row`, `.card`, `.card-title`, `.card-sub` and `.usage-list` to `apps/web/app/globals.css`, matching the existing card and button idiom.

- [ ] **Step 5: Verify in the browser**

Run `corepack pnpm dev:api` and `corepack pnpm dev:web`, then open `http://localhost:3000/analytics`.

Expected: the page renders, the window control switches, and with no measured turns yet the distribution card says "No measured turns yet. Run a call." rather than drawing an empty chart. Check the browser console for errors and confirm there are none.

- [ ] **Step 6: Commit**

```bash
git add apps/web/app/analytics apps/web/lib/analytics.ts apps/web/components/Nav.tsx apps/web/app/globals.css
git commit -m "Add the analytics page

Simulated calls are excluded by default and the tile says how many were
left out, so the number on screen can be trusted without knowing how the
orchestrator was configured when each call ran.

Every tile carries the threshold it is judged against. A median of 1.18s
says nothing on its own; 1.18s against an 800ms budget is a verdict."
```

---

### Task 10: The per-call timing panel

**Files:**
- Create: `apps/web/components/analytics/CallTiming.tsx`
- Modify: `apps/web/lib/useCallStream.ts` (collect `turn.timing` events)
- Modify: `apps/web/components/CallBoard.tsx` (render the panel)

**Interfaces:**
- Consumes: `TurnTiming` from `@recall/shared`; the stream hook's existing state shape.
- Produces: `timings: TurnTiming[]` on the `useCallStream` return value; `CallTiming({ timings })`.

- [ ] **Step 1: Collect the events in the stream hook**

In `apps/web/lib/useCallStream.ts`, add `timings` to the state the hook builds, appending on each `turn.timing` event, in the same switch the hook already uses for `field.update` and `transcript.final`.
Read the file first and follow its existing reducer shape exactly.

- [ ] **Step 2: Write the panel**

Create `apps/web/components/analytics/CallTiming.tsx`:

```tsx
import type { TurnTiming } from "@recall/shared";
import { ms } from "../../lib/analytics";

const KIND_LABEL: Record<TurnTiming["kind"], string> = {
  closed_field: "matched in code",
  cached_line: "played from cache",
  generated: "generated",
};

/**
 * This call's turns, in order, against the budget.
 *
 * Built from the timing events already streaming in, so a replayed call shows
 * the same numbers as a live one and there is no second source to disagree.
 */
export function CallTiming({ timings, budgetMs = 800 }: { timings: TurnTiming[]; budgetMs?: number }) {
  if (!timings.length) return null;
  const worst = Math.max(budgetMs, ...timings.map((t) => t.first_audio_ms));
  const tokens = timings.reduce(
    (acc, t) => ({
      prompt: acc.prompt + (t.prompt_tokens ?? 0),
      completion: acc.completion + (t.completion_tokens ?? 0),
    }),
    { prompt: 0, completion: 0 }
  );
  const chars = timings.reduce((sum, t) => sum + t.tts_chars, 0);

  return (
    <section className="card call-timing">
      <h2 className="card-title">Turn timing</h2>
      <p className="card-sub">
        {timings.length} turns. Think, wire wait and TTS tile each bar and sum to first audio.
      </p>
      <ol className="turn-list">
        {timings.map((turn, i) => (
          <li key={i} className={turn.first_audio_ms > budgetMs ? "turn over" : "turn"}>
            <span className="turn-n">{i + 1}</span>
            <span className="turn-bar" aria-hidden="true">
              <span className="turn-slice s-think" style={{ width: `${(turn.think_ms / worst) * 100}%` }} />
              <span className="turn-slice s-wire" style={{ width: `${(turn.wire_wait_ms / worst) * 100}%` }} />
              <span className="turn-slice s-tts" style={{ width: `${(turn.tts_ttfb_ms / worst) * 100}%` }} />
            </span>
            <span className="turn-total">{ms(turn.first_audio_ms)}</span>
            <span className="turn-kind">{KIND_LABEL[turn.kind]}</span>
          </li>
        ))}
      </ol>
      <ul className="usage-list">
        <li>
          <span>Prompt tokens</span>
          <span>{tokens.prompt.toLocaleString()}</span>
        </li>
        <li>
          <span>Completion tokens</span>
          <span>{tokens.completion.toLocaleString()}</span>
        </li>
        <li>
          <span>TTS characters</span>
          <span>{chars.toLocaleString()}</span>
        </li>
      </ul>
    </section>
  );
}
```

- [ ] **Step 3: Render it**

In `apps/web/components/CallBoard.tsx`, import `CallTiming` and render `<CallTiming timings={timings} />` below the transcript pane, where `timings` comes from the stream hook.

Add `.call-timing`, `.turn-list`, `.turn`, `.turn.over`, `.turn-n`, `.turn-bar`, `.turn-slice`, `.s-think`, `.s-wire`, `.s-tts`, `.turn-total` and `.turn-kind` rules to `globals.css`, reusing the stage colours from Task 8.

- [ ] **Step 4: Verify**

Run: `corepack pnpm typecheck`
Expected: PASS.

With both dev servers running, open an existing call at `http://localhost:3000/calls/<id>`.
Expected: the panel is absent for a call recorded before this instrumentation existed (no `turn.timing` events), and no error appears in the console. That absence is correct behaviour, not a bug.

- [ ] **Step 5: Commit**

```bash
git add apps/web/components/analytics/CallTiming.tsx apps/web/components/CallBoard.tsx apps/web/lib/useCallStream.ts apps/web/app/globals.css
git commit -m "Show one call's turn timing on its own page

Built from the timing events already streaming in, so a replayed call and
a live one read from the same source and cannot disagree. A call recorded
before this instrumentation shows no panel rather than an empty one."
```

---

### Task 11: End to end against a real call

The whole point of the instrumentation is numbers off a real phone call.
This task proves the path works from the wire to the chart.

**Files:** none created or modified unless a defect is found.

- [ ] **Step 1: Kill every stale watcher**

Run: `pkill -f "tsx watch src/index.ts"`

This is not optional. Seventeen orchestrators have been alive at once on this project, and whichever owns :8080 decides whether the phone rings and with which environment.

- [ ] **Step 2: Start one orchestrator and confirm its mode**

Run: `corepack pnpm dev:api`, then in another shell:

```bash
curl -s localhost:8080/health | python3 -m json.tool | head -30
```

Expected: `boot` reports the transport and call mode you intend. For a real call that is `transport: pstn`, `mock_voice: false`, `call_mode: journey`.

- [ ] **Step 3: Run a simulated call first**

Set `TRANSPORT=sim` and `MOCK_VOICE=1` in `.env`, restart the orchestrator, then:

```bash
curl -s -X POST localhost:8080/calls -H 'content-type: application/json' -d '{"lead_id":"L-1042"}'
```

Expected: `"simulated": true`. Open the call page and confirm the turn timing panel appears with one bar per reply.

- [ ] **Step 4: Confirm the simulated call is excluded by default**

```bash
curl -s "localhost:8080/analytics?window=all&source=dialled" | python3 -c "import json,sys; d=json.load(sys.stdin); print('calls', d['totals']['calls'], 'simulated', d['totals']['simulated'], 'turns', d['latency']['turns'])"
```

Expected: the simulated call is counted in `totals.simulated` and excluded from `totals.calls` and `latency.turns`.

Then:

```bash
curl -s "localhost:8080/analytics?window=all&source=all" | python3 -c "import json,sys; d=json.load(sys.stdin); print('turns', d['latency']['turns'], 'p50', d['latency']['first_audio'] and d['latency']['first_audio']['p50'])"
```

Expected: the turns appear, with a p50 far below the budget - which is exactly why they are excluded by default.

- [ ] **Step 5: Run a real call**

Restore `TRANSPORT=pstn` and `MOCK_VOICE=0`, run `corepack pnpm twilio:check` to confirm geo and tunnel, restart the orchestrator, and dial.

Expected: the handset rings. Watch the call page and confirm the turn timing panel fills in as the call runs.

- [ ] **Step 6: Read the dashboard**

Open `http://localhost:3000/analytics` with the window set to 24 hours.

Expected: the median first audio tile carries a real number against the 800ms budget, the distribution has bars, the stage bar shows three slices, and the thin notice appears under "Over time" because one call is well below the threshold of ten.

- [ ] **Step 7: Run every check**

Run:

```bash
corepack pnpm typecheck && corepack pnpm analytics:check && corepack pnpm usage:check && corepack pnpm dialogue:check && corepack pnpm setup:check && corepack pnpm normalise:check && corepack pnpm tts:check && corepack pnpm transport:check
```

Expected: all PASS. If any fails, fix it before proceeding - including a failure that predates this work.

- [ ] **Step 8: Record what the call showed**

Append a short section to `docs/HANDOFF.md` under the existing call write-ups, saying what the measured stage split was on this call and whether first audio was inside the budget.
Follow the file's existing style: one sentence per line, specific numbers, no hedging.

- [ ] **Step 9: Commit**

```bash
git add docs/HANDOFF.md
git commit -m "Write down what the first measured journey call showed"
```

---

## Self-Review

**Spec coverage**

| Spec section | Task |
| --- | --- |
| `turn.timing` event and stage definitions | 1, 4 |
| Token usage capture | 2 |
| TTS cached versus synthesised | 3 |
| `DialogueEngine` never emitted `latency.turn` | 4 |
| `simulated` column and migration | 5 |
| Percentiles not averages; pure aggregation; thin-data rule | 6 |
| `GET /analytics`, 30-second cache, 503 on no database | 7 |
| Hand-rolled SVG, light palette, thin-data component | 8 |
| `/analytics` page and nav | 9 |
| Call detail timing panel | 10 |
| End-to-end verification | 11 |
| Sentiment (out of scope) | none, deliberately |
| Dark theme (out of scope) | none, deliberately |
| `call_turns` table (out of scope) | none, deliberately |

**Type consistency**

- `TurnTiming.kind` is `TurnKind` in Task 1, produced by `TurnClock.kind()` in Task 4, read as `t.kind` in Task 6, and keyed as `KIND_LABEL[turn.kind]` in Task 10. Consistent.
- `TokenUsage` is `{ prompt, completion, model }` in Task 2, consumed as `usage?.prompt` in Task 4, and read as `prompt_tokens` on the flattened event thereafter. Consistent.
- `AudioMeta` is `{ cached, chars }` in Task 3, consumed by `noteAudio` in Task 4, and surfaces as `tts_chars` plus the `cached_line` kind. Consistent.
- `THIN_DATA_MIN_CALLS` is defined once in Task 6 and reported to the client as `thin_threshold`, which Task 9 passes to `Thin` as `threshold`. Consistent.
- `summarise` returns `Stats | null` everywhere, and every consumer in Task 9 uses `?.p50` rather than assuming a value. Consistent.

**Known gap, stated rather than hidden**

`llm_ttfb_ms` is only populated on the streamed reply path, because the extraction call is not streamed and there is no first-token moment to measure on it.
Most journey turns will therefore report `llm_total_ms` and a null TTFB.
This is honest and is the reason the dashboard shows both numbers separately rather than one labelled "LLM TTFB".
Making extraction streamable is a separate piece of work and is out of scope here.

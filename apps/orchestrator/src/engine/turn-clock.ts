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

  /**
   * The reply came out of the model rather than a script.
   *
   * Nothing reaches this today: it is called from the `generate: true` branch of
   * dialogue.ts, and no caller sets that flag. Kept because it is correct for
   * the path it guards and that path is still wired up. Until something does set
   * it, every `synthesised` turn got there through the cache miss below.
   */
  markGenerated(): void {
    this.generated = true;
  }

  /** The answer was matched in code and never reached the model. */
  markClosedField(): void {
    this.closedField = true;
  }

  /**
   * Synthesised is the fallback because it is the honest one: a line that did
   * not come out of the pre-render went to a live TTS socket, whether the words
   * were scripted or generated.
   */
  private kind(): TurnKind {
    if (this.closedField) return "closed_field";
    if (this.generated) return "synthesised";
    return this.audio?.cached ? "cached_line" : "synthesised";
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

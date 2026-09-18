import type { CallOutcome } from "@recall/shared";
import { env } from "../env.js";
import { log } from "../log.js";
import type { Transport, TransportEndReason } from "./transport.js";

/**
 * Echo mode - tonight's infrastructure target.
 *
 * The agent repeats back what STT heard, and nothing else. No journey, no
 * extraction, no scripts. It exists to prove the one thing everything else sits
 * on: Twilio in, Scribe out, ElevenLabs back, under a second, on a real phone.
 *
 * It measures the round trip the way the customer experiences it - from the
 * moment the transcript is committed to the moment the first audio frame goes
 * back on the wire - because that is the number that decides whether the call
 * feels like a conversation or like a walkie-talkie.
 */

export type EchoStats = {
  turns: number;
  /** Committed transcript to first audio frame, in milliseconds. */
  roundTripMs: number[];
};

export type EchoHooks = {
  onAgentLine: (text: string) => void;
  onCustomerLine: (text: string, confidence: number | null) => void;
  onPartial: (speaker: "agent" | "customer", text: string) => void;
  onOutcome: (outcome: CallOutcome) => void;
  onTurnMeasured: (ms: number, text: string) => void;
};

export class EchoEngine {
  readonly stats: EchoStats = { turns: 0, roundTripMs: [] };
  private finalised = false;
  private silenceTimer: NodeJS.Timeout | null = null;

  constructor(
    readonly callId: string,
    private transport: Transport,
    private hooks: EchoHooks
  ) {
    transport.onPartial((text) => this.hooks.onPartial("customer", text));
    transport.onUtterance((text, confidence) => void this.onTranscript(text, confidence));
    transport.onEnded((reason) => void this.onEnded(reason));
  }

  async begin(): Promise<void> {
    await this.transport.speak(
      "Hi, this is a test of the recall voice loop. Say something and I'll repeat it back."
    );
    this.armSilence();
  }

  private async onTranscript(text: string, confidence: number | null): Promise<void> {
    if (this.finalised || !text.trim()) return;
    this.clearSilence();

    const heardAt = Date.now();
    this.hooks.onCustomerLine(text, confidence);

    const line = `You said: ${text}`;
    this.hooks.onAgentLine(line);
    await this.transport.speak(line);

    // speak() resolves on playback completion, so the round trip is measured from
    // the transcript to the point the transport accepted the line - close enough
    // to first-frame for a go/no-go, and it needs no hook inside the wire path.
    const ms = Date.now() - heardAt;
    this.stats.turns++;
    this.stats.roundTripMs.push(ms);
    this.hooks.onTurnMeasured(ms, text);

    const verdict = ms < 1000 ? "ok" : "SLOW";
    log.call(this.callId, `echo turn ${this.stats.turns}: ${ms}ms ${verdict} (conf ${confidence ?? "n/a"})`);

    this.armSilence();
  }

  private armSilence(): void {
    this.clearSilence();
    this.silenceTimer = setTimeout(() => void this.finalise("abandoned"), env.silenceAbandonMs * 3);
  }

  private clearSilence(): void {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = null;
  }

  private async onEnded(reason: TransportEndReason): Promise<void> {
    await this.finalise(reason === "no_answer" ? "no_answer" : "disconnected");
  }

  /** Idempotent, for the same reason the journey engine's is. */
  async finalise(outcome: CallOutcome): Promise<void> {
    if (this.finalised) return;
    this.finalised = true;
    this.clearSilence();
    this.hooks.onOutcome(outcome);
    log.call(this.callId, `echo done: ${this.stats.turns} turns, median ${this.median() ?? "n/a"}ms`);
    try {
      await this.transport.hangup(outcome);
    } catch {
      /* line already gone */
    }
  }

  median(): number | null {
    if (!this.stats.roundTripMs.length) return null;
    const sorted = [...this.stats.roundTripMs].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? (sorted[mid] as number) : Math.round(((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2);
  }

  get isFinalised(): boolean {
    return this.finalised;
  }
}

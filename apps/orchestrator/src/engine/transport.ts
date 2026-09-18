import type { Journey, Lead } from "@recall/shared";

/**
 * The seam that lets the dialogue engine stay honest.
 *
 * A PSTN call and a simulated customer implement the same verbs, so the eval
 * harness exercises the exact code that runs on stage. When the venue's telephony
 * wobbles, the demo falls back to SimTransport without the engine noticing.
 *
 * Ported from buildin-hours. Two changes: the language argument is gone (this
 * agent is Australian English only), and `onUtterance` now carries STT confidence,
 * because the LOW CONF escalation signal is defined on it.
 */
export interface Transport {
  readonly id: string;
  readonly kind: "pstn" | "sim";

  /** Dial / connect. Resolves once the far end is actually listening. */
  start(): Promise<void>;

  /** Say something. Resolves when playback finishes or is cut short by barge-in. */
  speak(text: string): Promise<void>;

  /** A completed utterance from the customer, with mean STT word confidence. */
  onUtterance(cb: (text: string, confidence: number | null) => void): void;

  /** An interim transcript, for the console's grey streaming text. */
  onPartial(cb: (text: string) => void): void;

  /** They started talking over us. */
  onBargeIn(cb: () => void): void;

  /** The line is gone. */
  onEnded(cb: (reason: TransportEndReason) => void): void;

  /**
   * Warm handoff. Hands the live call to a human and resolves once the transfer
   * is placed. The sim transport records it instead of dialling.
   */
  transfer(toNumber: string, whisper: string): Promise<void>;

  hangup(reason?: string): Promise<void>;

  /** Where the audio landed, if the transport records. */
  recordingUrl?: string;
}

export type TransportEndReason =
  | "completed"
  | "no_answer"
  | "busy"
  | "voicemail"
  | "failed"
  | "hangup"
  | "transferred";

export type TransportDeps = {
  journey: Journey;
  lead: Lead;
  callId: string;
};

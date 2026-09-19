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
/** What happened to a line once it was on the wire. */
export type SpeakResult = {
  /** False when the customer talked over it and playback was cut. */
  completed: boolean;
  /**
   * The sentences that had finished playing when it was cut, or the whole line
   * when it completed. A question that was cut before its question mark has
   * not been asked, whatever the script says.
   */
  heard: string;
};

/** What the transport knows about an utterance beyond its words. */
export type UtteranceMeta = {
  /**
   * When the customer started talking, in the orchestrator's clock, or null if
   * the transport cannot tell. This is what lets the engine attribute a "yes"
   * to the line it was said over rather than to whichever line is current by
   * the time the transcript commits.
   */
  startedAt: number | null;
};

export interface Transport {
  readonly id: string;
  readonly kind: "pstn" | "sim";

  /** Dial / connect. Resolves once the far end is actually listening. */
  start(): Promise<void>;

  /**
   * Say something. Resolves when playback finishes or is cut short by barge-in.
   *
   * `onFirstAudio` fires when the first frame reaches the wire. That is the
   * moment the customer stops hearing silence, and it is the only latency number
   * worth quoting - measuring to the end of playback measures how long the agent
   * talked for, not how quickly it answered.
   *
   * `interruptible: false` plays the line to the end whatever the customer says.
   * The handoff bridge has to be heard whole: cut short by a customer still
   * finishing their address, it left them with "I'm going to" and a dead line.
   */
  speak(text: string, opts?: { onFirstAudio?: () => void; interruptible?: boolean }): Promise<SpeakResult>;

  /**
   * Say a reply that is still being generated.
   *
   * Sentences arrive from the LLM as they complete and go on the wire immediately,
   * so time-to-first-audio is one short synthesis rather than the whole turn. The
   * transport owns the wire and the framing; the engine owns the model. Returns
   * what was actually spoken, which is less than what was yielded when barge-in
   * cuts the reply short.
   */
  speakStream(sentences: AsyncIterable<string>, signal?: AbortSignal): Promise<string>;

  /**
   * A completed utterance from the customer, with mean STT word confidence.
   * `meta` is absent on transports that cannot time speech, such as the sim.
   */
  onUtterance(cb: (text: string, confidence: number | null, meta?: UtteranceMeta) => void): void;

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

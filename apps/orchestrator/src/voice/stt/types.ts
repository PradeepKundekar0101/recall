/**
 * The STT seam.
 *
 * Both providers take Twilio's ulaw 8 kHz frames unchanged and hand back the same
 * three things: interim text, committed text, and a confidence the engine can gate
 * on. Nothing above this layer knows which vendor is running.
 */

/** What the provider's word objects say about the speech behind a commit. */
export type SttFinalMeta = {
  /** Speech duration from word timestamps, in milliseconds, or null if untimed. */
  speechMs: number | null;
  /** Real words committed, excluding spacing tokens, or null if unknown. */
  words: number | null;
};

export type SttEvents = {
  /** Caller started talking. Fires during our playback too - this is the barge-in trigger. */
  onSpeechStart?: () => void;
  onSpeechEnd?: () => void;
  onPartial?: (text: string) => void;
  /**
   * `confidence` is mean word confidence over the utterance, 0-1, or null.
   *
   * `meta` carries what the provider's own word objects say about the speech
   * behind the words - how long it lasted and how many words there really
   * were. Both are what the echo and answer gates are defined on, and both are
   * absent from providers that do not timestamp, in which case the gates skip
   * that clause rather than treating "unmeasured" as "failed".
   */
  onFinal?: (text: string, confidence: number | null, meta?: SttFinalMeta) => void;
  /**
   * Provider-detected sensitive spans, when the provider offers it. Scribe's
   * entity detection flags credit_card before our own digit-run heuristic sees a
   * complete number, which is the difference between cutting in during the card
   * number and cutting in after it.
   */
  onSensitiveEntity?: (entityType: string, text: string) => void;
  onError?: (err: Error) => void;
  onClose?: () => void;
};

export type SttSession = {
  /** Feed one base64 ulaw@8k chunk straight off the Twilio media event. */
  push: (base64Ulaw: string) => void;
  /** Force finalisation of whatever is buffered, when the far end goes quiet. */
  flush: () => void;
  close: () => void;
  readonly ready: boolean;
};

export type SttOptions = {
  events: SttEvents;
  /** Domain words - suburb names, plan names - that bias recognition. */
  keywords?: string[];
  /** Milliseconds of silence before the turn closes. Defaults to `STT_SILENCE_MS`. */
  silenceMs?: number;
  /**
   * Voice-activity threshold, where the provider takes one. Higher means
   * quieter audio - our own voice off a speakerphone - does not open a turn.
   * Undefined leaves the provider's default alone.
   */
  vadThreshold?: number | null;
  /**
   * Ignore the provider's turn detection and commit on our own silence timer.
   * Ours knows whether the agent is talking; the server's cannot.
   */
  manualCommit?: boolean;
  label?: string;
};

export type SttOpener = (opts: SttOptions) => Promise<SttSession>;

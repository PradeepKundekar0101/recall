/**
 * The STT seam.
 *
 * Both providers take Twilio's ulaw 8 kHz frames unchanged and hand back the same
 * three things: interim text, committed text, and a confidence the engine can gate
 * on. Nothing above this layer knows which vendor is running.
 */

export type SttEvents = {
  /** Caller started talking. Fires during our playback too - this is the barge-in trigger. */
  onSpeechStart?: () => void;
  onSpeechEnd?: () => void;
  onPartial?: (text: string) => void;
  /** `confidence` is mean word confidence over the utterance, 0-1, or null. */
  onFinal?: (text: string, confidence: number | null) => void;
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
  /** Milliseconds of silence before the provider closes a turn. */
  silenceMs?: number;
  label?: string;
};

export type SttOpener = (opts: SttOptions) => Promise<SttSession>;

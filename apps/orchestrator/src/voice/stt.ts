import { env, has } from "../env.js";
import { log } from "../log.js";

/**
 * Streaming speech-to-text.
 *
 * Deepgram Nova over a websocket, taking Twilio's mulaw@8k natively so there is no
 * transcode step in the turn budget. Server-side endpointing closes the turn, which
 * is the 300 ms line in the latency table.
 *
 * The session shape is deliberately identical to the one the Sarvam path exposed,
 * so `transports/twilio.ts` ports across with an import change and nothing else.
 *
 * Word-level confidence is carried on `onFinal` because the LOW CONF escalation
 * signal is defined on it: mean word confidence under 0.6 on two consecutive turns
 * hands off. Dropping it here would mean reconstructing it later from nothing.
 */

export type SttEvents = {
  /** Caller started talking. Fires during our playback too - this is the barge-in trigger. */
  onSpeechStart?: () => void;
  onSpeechEnd?: () => void;
  onPartial?: (text: string) => void;
  /** `confidence` is the mean word confidence over the utterance, 0-1. */
  onFinal?: (text: string, confidence: number | null) => void;
  onError?: (err: Error) => void;
  onClose?: () => void;
};

export type SttSession = {
  /** Feed one base64 mulaw@8k chunk straight off the Twilio media event. */
  push: (base64Mulaw: string) => void;
  /** Force finalisation of whatever is buffered, when the far end goes quiet. */
  flush: () => void;
  close: () => void;
  readonly ready: boolean;
};

export type SttOptions = {
  events: SttEvents;
  /** Domain words - suburb names, plan names - that bias recognition. */
  keywords?: string[];
  /** Milliseconds of silence before the server closes a turn. Lower is snappier and cuts people off. */
  silenceMs?: number;
  label?: string;
};

export const DEEPGRAM_URL = "wss://api.deepgram.com/v1/listen";

/**
 * Query string for the realtime socket. Split out so `pnpm twilio:check` and the
 * eval harness can assert the encoding matches what Twilio actually sends without
 * opening a billable socket.
 */
export function deepgramQuery(opts: SttOptions): URLSearchParams {
  return new URLSearchParams({
    model: "nova-3",
    language: "en-AU",
    // Twilio's native format. Anything else buys a transcode inside the budget.
    encoding: "mulaw",
    sample_rate: "8000",
    channels: "1",
    // Server-side VAD closes the turn; the engine never has to guess at silence.
    endpointing: String(opts.silenceMs ?? 300),
    interim_results: "true",
    // Needed for the LOW CONF signal.
    punctuate: "true",
    smart_format: "true",
    ...(opts.keywords?.length ? { keywords: opts.keywords.join(":") } : {}),
  });
}

/** A session that swallows audio and never transcribes. The sim transport needs no STT. */
function mockSession(): SttSession {
  return {
    push: () => {},
    flush: () => {},
    close: () => {},
    get ready() {
      return true;
    },
  };
}

export async function openStt(opts: SttOptions): Promise<SttSession> {
  if (env.mockVoice) {
    log.info(`[${opts.label ?? "stt"}] MOCK_VOICE=1, no Deepgram socket opened`);
    return mockSession();
  }
  if (!has.deepgram()) {
    throw new Error("DEEPGRAM_API_KEY is not set - cannot open an STT socket");
  }
  // Build block P3: open the ws with the `ws` package (never the Node global, which
  // drops the Authorization header), wire Results -> onPartial/onFinal, compute mean
  // word confidence per utterance, and map SpeechStarted -> onSpeechStart for barge-in.
  throw new Error("voice/stt.ts: Deepgram streaming not implemented yet (build block P3)");
}

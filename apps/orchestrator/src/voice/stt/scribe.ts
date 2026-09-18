import { WebSocket } from "ws";
import { env } from "../../env.js";
import { log } from "../../log.js";
import type { SttOptions, SttSession } from "./types.js";

/**
 * ElevenLabs Scribe v2 Realtime.
 *
 * Twilio's frames arrive base64-encoded ulaw at 8 kHz, and Scribe accepts exactly
 * that as `audio_format=ulaw_8000` with the payload passed straight through as
 * `audio_base_64`. There is no decode, no resample and no re-encode anywhere in
 * this path, which is the only reason the 800 ms turn budget is reachable.
 *
 * `commit_strategy=vad` puts turn detection on the server, so nothing here counts
 * silence. `include_timestamps` is what makes the LOW CONF escalation signal
 * possible: committed transcripts come back with a per-word `logprob`.
 *
 * Opened with the `ws` package rather than Node's global WebSocket. The global
 * ignores the options argument, so the `xi-api-key` header is silently dropped and
 * the server answers with an auth error - the same trap that cost this project an
 * evening on the previous stack, and the reason Node 20 is pinned.
 */

const URL_BASE = "wss://api.elevenlabs.io/v1/speech-to-text/realtime";

type ScribeWord = { text: string; type?: string; logprob?: number };

type ScribeMessage = {
  message_type: string;
  text?: string;
  words?: ScribeWord[];
  entities?: { text: string; entity_type: string }[];
  message?: string;
  session_id?: string;
};

export function scribeQuery(opts: SttOptions): URLSearchParams {
  const params = new URLSearchParams({
    model_id: env.sttModel,
    // Twilio's native format, passed through untouched.
    audio_format: "ulaw_8000",
    language_code: "en",
    // Server-side VAD closes the turn; the engine never has to guess at silence.
    commit_strategy: "vad",
    // The server clamps this to 0.5s minimum - asking for 0.3 silently became 0.5,
    // so it is set to the real floor rather than a number that looks faster.
    vad_silence_threshold_secs: String(Math.max(0.5, (opts.silenceMs ?? 500) / 1000)),
    min_speech_duration_ms: "120",
    // Required for per-word logprobs, which the LOW CONF signal is defined on.
    include_timestamps: "true",
  });

  /**
   * Entity detection takes entity types or categories, not a boolean. `pci` is the
   * category covering payment-card data, which is exactly what guardrail 3 is
   * watching for - and Scribe flags it before our own digit-run heuristic has seen
   * a complete number.
   *
   * Not combined with `filter_background_audio`: the server rejects that pairing
   * with include_timestamps, and timestamps win because LOW CONF cannot work
   * without them.
   */
  params.append("entity_detection", "pci");

  if (opts.keywords?.length) {
    for (const term of opts.keywords.slice(0, 100)) params.append("keyterms", term);
  }
  return params;
}

/**
 * The confidence scale, measured rather than assumed.
 *
 * Scribe reports per-word log probabilities, which are not on the same scale as
 * Deepgram's 0-1 confidence. Measured against this account with `pnpm
 * voice:calibrate`, clean synthetic speech that transcribed perfectly scored
 * 0.46-0.63 raw, mean 0.52. Carrying over a 0.85 accept threshold would have
 * rejected every correct answer on the call and re-asked every field.
 *
 * So raw probability is divided by the measured clean baseline: 1.0 means "as
 * confident as this model gets on clean audio", which is what the thresholds
 * downstream are written against.
 *
 * Re-measure on real phone audio before the demo. Synthetic speech fed back
 * through the encoder is not a mobile handset in a loud room, and the baseline
 * will move.
 */
export const CLEAN_BASELINE = 0.52;

type ScribeWordLike = { text?: string; type?: string; logprob?: number };

/**
 * exp() converts one log probability back to a probability; the mean over real
 * words is the utterance confidence. Spacing tokens are excluded because they are
 * always near-certain and would drag the mean up over exactly the mumbled
 * utterances this is meant to catch.
 */
export function meanConfidence(words: ScribeWordLike[] | undefined): number | null {
  const real = (words ?? []).filter((w) => w.type !== "spacing" && typeof w.logprob === "number");
  if (!real.length) return null;
  const raw = real.reduce((acc, w) => acc + Math.exp(w.logprob as number), 0) / real.length;
  return Math.min(1, raw / CLEAN_BASELINE);
}

/** The unscaled mean, for the calibration tool. */
export function rawMeanProbability(words: ScribeWordLike[] | undefined): number | null {
  const real = (words ?? []).filter((w) => w.type !== "spacing" && typeof w.logprob === "number");
  if (!real.length) return null;
  return real.reduce((acc, w) => acc + Math.exp(w.logprob as number), 0) / real.length;
}

export async function openScribe(opts: SttOptions): Promise<SttSession> {
  const { events } = opts;
  const label = opts.label ?? "scribe";

  const socket = new WebSocket(`${URL_BASE}?${scribeQuery(opts).toString()}`, {
    headers: { "xi-api-key": env.elevenLabsKey },
  });

  let ready = false;
  let closed = false;
  /** Frames that arrive before the socket opens. Dropping them clips the first word. */
  const backlog: string[] = [];
  /** VAD speech-start is inferred from the first partial of a turn. */
  let turnOpen = false;

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("scribe did not open within 8s")), 8000);

    socket.on("open", () => {
      clearTimeout(timer);
      ready = true;
      for (const chunk of backlog.splice(0)) send(chunk);
      log.info(`[${label}] scribe open (${env.sttModel}, ulaw_8000)`);
      resolve();
    });

    socket.on("error", (err) => {
      clearTimeout(timer);
      events.onError?.(err);
      reject(err);
    });
  });

  socket.on("message", (data) => {
    let msg: ScribeMessage;
    try {
      msg = JSON.parse(data.toString()) as ScribeMessage;
    } catch {
      return;
    }

    switch (msg.message_type) {
      case "session_started":
        log.info(`[${label}] scribe session ${msg.session_id ?? "?"}`);
        break;

      case "partial_transcript": {
        const text = msg.text ?? "";
        if (!text.trim()) break;
        if (!turnOpen) {
          turnOpen = true;
          events.onSpeechStart?.();
        }
        events.onPartial?.(text);
        break;
      }

      // Plain committed_transcript carries no words, so it is ignored when
      // timestamps are on - the *_with_timestamps variant is the one that can
      // supply a confidence, and acting on both would double every turn.
      case "committed_transcript_with_timestamps": {
        const text = msg.text ?? "";
        turnOpen = false;
        events.onSpeechEnd?.();
        if (text.trim()) events.onFinal?.(text, meanConfidence(msg.words));
        break;
      }

      // Arrives either side of the timestamped transcript - both orders observed
      // against the live service - so the engine treats it as an out-of-band trip
      // rather than as part of the turn it belongs to.
      case "committed_transcript_entities": {
        for (const entity of msg.entities ?? []) {
          events.onSensitiveEntity?.(entity.entity_type, entity.text);
        }
        break;
      }

      case "auth_error":
      case "quota_exceeded":
      case "rate_limited":
      case "transcriber_error":
      case "invalid_request":
      case "input_error":
      case "error":
        events.onError?.(new Error(`${msg.message_type}: ${msg.message ?? "no detail"}`));
        break;
    }
  });

  socket.on("close", () => {
    closed = true;
    ready = false;
    events.onClose?.();
  });

  function send(base64Ulaw: string, commit = false): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ message_type: "input_audio_chunk", audio_base_64: base64Ulaw, commit }));
  }

  return {
    push(base64Ulaw) {
      if (closed) return;
      if (!ready) {
        backlog.push(base64Ulaw);
        return;
      }
      send(base64Ulaw);
    },
    flush() {
      // An empty chunk with commit closes the turn without waiting on VAD.
      send("", true);
    },
    close() {
      closed = true;
      try {
        socket.close();
      } catch {
        /* already closing */
      }
    },
    get ready() {
      return ready;
    },
  };
}

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

/**
 * One word as Scribe commits it.
 *
 * `start` and `end` are seconds, per the realtime API reference, and are only
 * present with `include_timestamps`. `logprob` is the per-word confidence the
 * LOW CONF signal and the answer gate are both defined on.
 */
type ScribeWord = { text: string; type?: string; logprob?: number; start?: number; end?: number };

type ScribeMessage = {
  message_type: string;
  text?: string;
  words?: ScribeWord[];
  entities?: { text: string; entity_type: string }[];
  /** The server puts rejection detail here, not in `message`. */
  error?: string;
  message?: string;
  session_id?: string;
};

export function scribeQuery(opts: SttOptions): URLSearchParams {
  const silenceMs = opts.silenceMs ?? env.sttSilenceMs;
  const params = new URLSearchParams({
    model_id: env.sttModel,
    // Twilio's native format, passed through untouched.
    audio_format: "ulaw_8000",
    language_code: "en",
    /**
     * Server-side VAD closes the turn, unless we have taken that job over.
     *
     * `manual` stops Scribe deciding when speech ended and leaves the commit to
     * our own silence timer - which, unlike the server's, knows whether the
     * agent is currently talking. The two are not equivalent in latency: the
     * server commits the moment its VAD closes, ours commits `silenceMs` after
     * the last partial, so this is a deliberate trade and off by default.
     */
    commit_strategy: opts.manualCommit ?? env.sttManualCommit ? "manual" : "vad",
    // The server clamps this to 0.5s minimum - asking for 0.3 silently became 0.5,
    // so it is set to the real floor rather than a number that looks faster.
    vad_silence_threshold_secs: String(Math.max(0.5, silenceMs / 1000)),
    min_speech_duration_ms: "120",
    // Required for per-word logprobs and timestamps. The first is what LOW CONF
    // and the answer gate are built on; the second is how the half-duplex gate
    // measures speech duration without trusting wall clock between events.
    include_timestamps: "true",
  });

  /**
   * Only sent when the operator set it.
   *
   * A parameter Scribe does not like fails the whole socket with
   * `invalid_request`, and the call then runs with the agent talking and
   * hearing nothing - which has happened once already, over a keyterm. An
   * unset threshold leaves the server's own default in place.
   */
  const vadThreshold = opts.vadThreshold ?? env.sttVadThreshold;
  if (vadThreshold !== null && vadThreshold !== undefined && Number.isFinite(vadThreshold)) {
    params.append("vad_threshold", String(vadThreshold));
  }

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

type ScribeWordLike = { text?: string; type?: string; logprob?: number; start?: number; end?: number };

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

/**
 * How long the speech itself lasted, from the provider's own word timestamps.
 *
 * Wall clock between the first partial and the commit measures the vendor's
 * latency as much as the customer's speech, and the half-duplex gate needs the
 * second without the first: half a second of speech is a person taking the
 * turn, half a second of network is nothing at all.
 *
 * `start` and `end` are documented as seconds. A committed turn that carries no
 * timestamps returns null rather than zero, so the caller can skip the clause
 * instead of treating "not measured" as "too short" and dropping every answer.
 */
export function speechDurationMs(words: ScribeWordLike[] | undefined): number | null {
  const timed = (words ?? []).filter(
    (w) => w.type !== "spacing" && typeof w.start === "number" && typeof w.end === "number"
  );
  if (!timed.length) return null;
  const start = Math.min(...timed.map((w) => w.start as number));
  const end = Math.max(...timed.map((w) => w.end as number));
  if (!(end > start)) return 0;
  return Math.round((end - start) * 1000);
}

/** Real words, excluding the spacing tokens, which are not words anybody said. */
export function realWordCount(words: ScribeWordLike[] | undefined): number | null {
  if (!words) return null;
  return words.filter((w) => w.type !== "spacing" && (w.text ?? "").trim().length > 0).length;
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
  let framesPushed = 0;
  /** Frames that arrive before the socket opens. Dropping them clips the first word. */
  const backlog: string[] = [];
  /** VAD speech-start is inferred from the first partial of a turn. */
  let turnOpen = false;

  let messagesSeen = 0;
  /** The raw word shape is printed once per session, for the gates below. */
  let wordsLogged = false;

  const manualCommit = opts.manualCommit ?? env.sttManualCommit;
  const silenceMs = opts.silenceMs ?? env.sttSilenceMs;
  let commitTimer: NodeJS.Timeout | null = null;

  function clearManualCommit(): void {
    if (commitTimer) clearTimeout(commitTimer);
    commitTimer = null;
  }

  /**
   * Close the turn ourselves, `silenceMs` after the last partial.
   *
   * Only armed under `commit_strategy=manual`. Under VAD the server owns this
   * and a second timer racing it would commit the same speech twice.
   */
  function armManualCommit(): void {
    if (!manualCommit) return;
    clearManualCommit();
    commitTimer = setTimeout(() => {
      commitTimer = null;
      if (closed) return;
      log.info(`[${label}] committing on our own silence timer (${silenceMs}ms)`);
      send("", true);
    }, silenceMs);
    commitTimer.unref?.();
  }

  /**
   * Every handler is attached before the open handshake is awaited.
   *
   * `session_started` arrives the instant the socket opens, and ws drops events
   * that have no listener yet - so attaching the message handler after awaiting
   * open silently discarded whatever the server said first. Handler registration
   * is cheap; ordering it after an await is a race for no benefit.
   */
  const opened = new Promise<void>((resolve, reject) => {
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
      log.error(`[${label}] scribe socket error: ${err.message}`);
      events.onError?.(err);
      reject(err);
    });
  });

  socket.on("message", (data) => {
    messagesSeen++;
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

      default:
        // Anything unrecognised is logged once rather than silently dropped. A
        // socket that opens and then says something we do not handle looks
        // identical to a socket that says nothing at all.
        if (messagesSeen <= 5) log.info(`[${label}] scribe -> ${JSON.stringify(msg).slice(0, 200)}`);
        break;

      case "partial_transcript": {
        const text = msg.text ?? "";
        if (!text.trim()) break;
        if (!turnOpen) {
          turnOpen = true;
          events.onSpeechStart?.();
        }
        events.onPartial?.(text);
        // Our own silence timer, when Scribe's VAD has been turned off. Every
        // partial pushes the commit out, so a customer still talking is never
        // cut mid-sentence by a clock.
        armManualCommit();
        break;
      }

      // Plain committed_transcript carries no words, so it is ignored when
      // timestamps are on - the *_with_timestamps variant is the one that can
      // supply a confidence, and acting on both would double every turn.
      case "committed_transcript_with_timestamps": {
        const text = msg.text ?? "";
        turnOpen = false;
        clearManualCommit();
        events.onSpeechEnd?.();

        /**
         * The raw word objects, once per session.
         *
         * The gates below are defined on per-word `logprob` and on `start` /
         * `end` timestamps, and the only way to know those fields are really
         * there - and really vary - is to look at what a live call returns.
         * One line, the first committed turn, and never again: this is a
         * transcript and it does not belong in a log on every turn.
         */
        if (!wordsLogged) {
          wordsLogged = true;
          log.info(`[${label}] first committed words: ${JSON.stringify((msg.words ?? []).slice(0, 8))}`);
        }

        if (text.trim()) {
          events.onFinal?.(text, meanConfidence(msg.words), {
            speechMs: speechDurationMs(msg.words),
            words: realWordCount(msg.words),
          });
        }
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
        // `error` first: that is where the server actually puts the reason, and
        // reading `message` instead turned a precise rejection ("Invalid entity
        // types", "cannot be combined with") into a useless "no detail".
        events.onError?.(new Error(`${msg.message_type}: ${msg.error ?? msg.message ?? "no detail"}`));
        break;
    }
  });

  socket.on("close", (code, reason) => {
    closed = true;
    ready = false;
    // Always logged. A Scribe socket that closes mid-call is the difference
    // between a conversation and dead air, and the transport has no other way to
    // find out that it happened.
    log.warn(
      `[${label}] scribe closed ${code} after ${framesPushed} frames, ${messagesSeen} messages` +
        (reason?.length ? `: ${reason.toString().slice(0, 200)}` : "")
    );
    events.onClose?.();
  });

  function send(base64Ulaw: string, commit = false): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ message_type: "input_audio_chunk", audio_base_64: base64Ulaw, commit }));
    if (base64Ulaw) {
      framesPushed++;
      // Once a second of audio is in, say so. Silence from Scribe with frames
      // flowing is a very different problem from no frames flowing at all.
      if (framesPushed === 50) log.info(`[${label}] scribe has taken 1s of audio`);
      if (framesPushed % 500 === 0) log.info(`[${label}] scribe: ${framesPushed} frames pushed, ${messagesSeen} messages back`);
    }
  }

  await opened;

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
      clearManualCommit();
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

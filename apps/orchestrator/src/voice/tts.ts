import { WebSocket } from "ws";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { env, has } from "../env.js";
import { log } from "../log.js";

/**
 * ElevenLabs over the realtime websocket.
 *
 * The model is `TTS_MODEL`. It has to be one the configured voice is actually
 * fine-tuned on: a professional voice clone rendered through a model whose
 * fine-tune is missing or failed still produces audio, just flat and synthetic,
 * and that is what the first journey call sounded like on Flash v2.5. A voice's
 * per-model state is in `fine_tuning.state` on GET /v1/voices/{id}.
 *
 * `output_format=ulaw_8000` means the audio comes back in exactly the shape Twilio
 * wants, so the return path has no transcode either. ~75 ms model latency is the
 * 150 ms line in the turn budget once the first sentence is in.
 *
 * Fixed script lines are pre-rendered to ulaw files on disk at boot. On stage the
 * consent opener has to land instantly or the call opens with dead air, and the
 * bridging line has to play the moment an escalation fires. Caching them on disk
 * rather than in memory means a restart between rehearsals does not re-spend the
 * latency or the quota.
 */

const here = dirname(fileURLToPath(import.meta.url));
const cacheDir = resolve(here, "../..", env.prerenderDir);
const memory = new Map<string, Buffer>();

/** Spells a value out for the `letters` confirm mode: "p-r-i-y-a, dot, sharma". */
export function spellOut(value: string): string {
  return value
    .split("")
    .map((ch) => {
      if (ch === "@") return ", at, ";
      if (ch === ".") return ", dot, ";
      if (ch === "-") return ", dash, ";
      if (ch === "_") return ", underscore, ";
      if (ch === " ") return ", ";
      return ch;
    })
    .join("-")
    .replace(/-, /g, ", ")
    .replace(/, -/g, ", ");
}

/**
 * Loudness levelling.
 *
 * ElevenLabs normalises each request on its own, so a two-word acknowledgement
 * comes back hot and a long sentence comes back soft. Measured across the
 * pre-rendered lines, "Okay." sat 10 dB above the consent line that follows it,
 * which on a handset is a shout between sentences. Every finished utterance is
 * brought to one RMS target here, with a ceiling on the peak so nothing clips.
 *
 * This is a gain stage on a complete buffer, not a resample: the audio stays
 * 8 kHz mulaw end to end and the cost is one table lookup per sample.
 */
export const TARGET_RMS = 2000;
const PEAK_CEILING = 28000;
/** Below this the buffer is silence or mock audio and is left alone. */
const MIN_RMS_TO_LEVEL = 50;

const ULAW_TO_LINEAR = new Int16Array(256);
for (let byte = 0; byte < 256; byte++) {
  const inverted = ~byte & 0xff;
  const exponent = (inverted >> 4) & 0x07;
  const mantissa = inverted & 0x0f;
  const magnitude = (((mantissa << 3) + 0x84) << exponent) - 0x84;
  ULAW_TO_LINEAR[byte] = inverted & 0x80 ? -magnitude : magnitude;
}

export function ulawToLinear(ulaw: Buffer): Int16Array {
  const out = new Int16Array(ulaw.length);
  for (let i = 0; i < ulaw.length; i++) out[i] = ULAW_TO_LINEAR[ulaw[i] as number] as number;
  return out;
}

export function linearToUlaw(sample: number): number {
  const BIAS = 0x84;
  const CLIP = 32635;
  const sign = sample < 0 ? 0x80 : 0;
  let magnitude = Math.abs(sample);
  if (magnitude > CLIP) magnitude = CLIP;
  magnitude += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (magnitude & mask) === 0 && exponent > 0; exponent--, mask >>= 1) {
    /* find the segment */
  }
  const mantissa = (magnitude >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

export function rmsOf(ulaw: Buffer): number {
  if (!ulaw.length) return 0;
  let sum = 0;
  for (let i = 0; i < ulaw.length; i++) {
    const s = ULAW_TO_LINEAR[ulaw[i] as number] as number;
    sum += s * s;
  }
  return Math.sqrt(sum / ulaw.length);
}

export function levelLoudness(ulaw: Buffer, targetRms = TARGET_RMS): Buffer {
  const rms = rmsOf(ulaw);
  if (rms < MIN_RMS_TO_LEVEL) return ulaw;

  let peak = 0;
  for (let i = 0; i < ulaw.length; i++) {
    const s = Math.abs(ULAW_TO_LINEAR[ulaw[i] as number] as number);
    if (s > peak) peak = s;
  }
  const gain = Math.min(targetRms / rms, peak ? PEAK_CEILING / peak : 1);
  if (Math.abs(gain - 1) < 0.05) return ulaw;

  const out = Buffer.alloc(ulaw.length);
  for (let i = 0; i < ulaw.length; i++) {
    out[i] = linearToUlaw(Math.round((ULAW_TO_LINEAR[ulaw[i] as number] as number) * gain));
  }
  return out;
}

function cacheKey(text: string): string {
  // The target is part of the key, so a change to it re-renders rather than
  // serving lines levelled to the old one.
  return createHash("sha1")
    .update(`${env.ttsModel}|${env.elevenLabsVoiceId}|rms${TARGET_RMS}|${text}`)
    .digest("hex")
    .slice(0, 16);
}

function cachePath(text: string): string {
  return resolve(cacheDir, `${cacheKey(text)}.ulaw`);
}

/** 8 kHz ulaw silence. Stands in for real audio so the loop can run dry. */
function mockAudio(seconds = 0.4): Buffer {
  return Buffer.alloc(Math.round(8000 * seconds), 0xff);
}

export type SpeakOptions = {
  text: string;
  /** Persist to disk and serve from there afterwards. Used for the fixed lines. */
  cacheable?: boolean;
  /** Abort mid-synthesis. Barge-in passes the turn's signal here. */
  signal?: AbortSignal;
};

/**
 * Synthesises one utterance and returns it as ulaw.
 *
 * Used for the fixed lines and for whole short replies. The streaming path that
 * feeds sentences in as the model produces them is `openTtsStream`.
 */
export async function synthesize(opts: SpeakOptions): Promise<Buffer> {
  // Spoken verbatim. How a value is worded - a date as a date, a postcode digit
  // by digit - is decided where the value is known, in `speakableValue`.
  const text = opts.text.trim();
  if (!text) return Buffer.alloc(0);

  if (opts.cacheable) {
    const hit = memory.get(text);
    if (hit) return hit;
    const path = cachePath(text);
    if (existsSync(path)) {
      const audio = readFileSync(path);
      memory.set(text, audio);
      return audio;
    }
  }

  if (env.mockVoice) return mockAudio();
  if (!has.tts()) throw new Error("ELEVENLABS_API_KEY / ELEVENLABS_VOICE_ID are not set - cannot synthesize");

  const chunks: Buffer[] = [];
  const stream = await openTtsStream({ signal: opts.signal, onAudio: (buf) => chunks.push(buf) });
  stream.push(text);
  await stream.end();

  const audio = levelLoudness(Buffer.concat(chunks));
  if (opts.cacheable && audio.length) {
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(cachePath(text), audio);
    memory.set(text, audio);
  }
  return audio;
}

export type TtsStream = {
  /** Feed a sentence. Safe to call repeatedly as the model produces them. */
  push: (text: string) => void;
  /** Closes the input and resolves once the server has sent its final audio. */
  end: () => Promise<void>;
  /** Barge-in: drop the socket immediately without waiting for isFinal. */
  cancel: () => void;
};

/**
 * Opens a streaming synthesis socket.
 *
 * Sentences are pushed in as the LLM produces them, so time-to-first-audio is one
 * short synthesis rather than the whole reply. `cancel()` exists because barge-in
 * has to kill the TTS socket as well as the LLM stream - leaving it open means the
 * customer keeps hearing the sentence they just talked over.
 */
export async function openTtsStream(opts: {
  onAudio: (audio: Buffer) => void;
  signal?: AbortSignal;
}): Promise<TtsStream> {
  const query = new URLSearchParams({
    model_id: env.ttsModel,
    // Native Twilio format. Anything else buys a transcode inside the budget.
    output_format: "ulaw_8000",
    // Lets the server decide when it has enough text to start, rather than us
    // guessing with try_trigger_generation.
    auto_mode: "true",
    inactivity_timeout: "20",
  });

  const socket = new WebSocket(
    `wss://api.elevenlabs.io/v1/text-to-speech/${env.elevenLabsVoiceId}/stream-input?${query.toString()}`,
    { headers: { "xi-api-key": env.elevenLabsKey } }
  );

  let cancelled = false;
  let finished = false;
  let resolveEnd: (() => void) | null = null;
  /** Set when the server reports a problem, and rethrown from end(). */
  let failure: Error | null = null;

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("elevenlabs tts did not open within 8s")), 8000);
    socket.on("open", () => {
      clearTimeout(timer);
      // The initialising message must be sent before any text.
      socket.send(
        JSON.stringify({
          text: " ",
          voice_settings: { stability: 0.5, similarity_boost: 0.75, speed: 1 },
        })
      );
      resolve();
    });
    socket.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });

  socket.on("message", (data) => {
    if (cancelled) return;
    let msg: { audio?: string; isFinal?: boolean; error?: string; message?: string; code?: number };
    try {
      msg = JSON.parse(data.toString()) as typeof msg;
    } catch {
      return;
    }

    // The server reports a bad voice, a bad model or an exhausted quota as an
    // ordinary message and then closes. Ignoring it produced a silent zero-byte
    // synthesis, which on a call is indistinguishable from dead air - and which
    // hid a wrong voice id behind "TTS returned zero bytes".
    if (msg.error || (msg.message && !msg.audio)) {
      failure = new Error(`elevenlabs tts: ${msg.error ?? "error"} - ${msg.message ?? "no detail"}`);
      log.error(failure.message);
      finished = true;
      resolveEnd?.();
      return;
    }

    if (msg.audio) opts.onAudio(Buffer.from(msg.audio, "base64"));
    if (msg.isFinal) {
      finished = true;
      resolveEnd?.();
    }
  });

  socket.on("close", (code, reason) => {
    // 1000 is a clean close; anything else that arrives before isFinal means the
    // synthesis did not happen.
    if (!finished && code !== 1000) {
      failure ??= new Error(`elevenlabs tts closed ${code}: ${reason.toString().slice(0, 200)}`);
    }
    finished = true;
    resolveEnd?.();
  });

  const onAbort = () => cancel();
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  function cancel(): void {
    if (cancelled) return;
    cancelled = true;
    try {
      socket.terminate();
    } catch {
      /* already gone */
    }
    resolveEnd?.();
  }

  return {
    push(text) {
      if (cancelled || socket.readyState !== WebSocket.OPEN) return;
      // The trailing space is required; ElevenLabs treats it as a word boundary.
      socket.send(JSON.stringify({ text: `${text.trim()} `, flush: false }));
    },
    async end() {
      if (cancelled) return;
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ text: "" })); // end-of-input sentinel
      }
      if (!finished) {
        await new Promise<void>((resolve) => {
          resolveEnd = resolve;
          // A dropped isFinal must never wedge a call.
          setTimeout(resolve, 15_000).unref?.();
        });
      }
      opts.signal?.removeEventListener("abort", onAbort);
      if (failure) throw failure;
    },
    cancel,
  };
}

/**
 * Pre-renders the lines that never change, at boot.
 *
 * Returns how many were already on disk, so the boot report can say whether the
 * demo will open instantly or pay for a synthesis on the first call.
 */
export async function prerender(lines: string[]): Promise<{ cached: number; rendered: number }> {
  const unique = [...new Set(lines.map((l) => l.trim()).filter(Boolean))];
  if (env.mockVoice || !has.tts()) {
    log.info(`tts: skipped pre-rendering ${unique.length} fixed lines (${env.mockVoice ? "MOCK_VOICE=1" : "no key"})`);
    return { cached: 0, rendered: 0 };
  }

  mkdirSync(cacheDir, { recursive: true });
  let cached = 0;
  let rendered = 0;

  for (const text of unique) {
    if (existsSync(cachePath(text))) {
      memory.set(text, readFileSync(cachePath(text)));
      cached++;
      continue;
    }
    // Sequential on purpose: firing every fixed line at the socket concurrently at
    // boot is a good way to meet a rate limit right before a demo.
    await synthesize({ text, cacheable: true });
    rendered++;
  }

  log.info(`tts: ${cached} fixed lines from disk, ${rendered} newly rendered -> ${cacheDir}`);
  return { cached, rendered };
}

export function cachedLineCount(): number {
  return memory.size;
}

import { env, has } from "../env.js";
import { log } from "../log.js";

/**
 * Streaming text-to-speech.
 *
 * ElevenLabs Flash v2.5 over a websocket with `output_format=ulaw_8000`, so audio
 * goes to Twilio without a transcode. ~75 ms model latency is the 150 ms line in
 * the budget once the first sentence is in.
 *
 * Two things here exist purely to defend the 800 ms turn target:
 *
 *   - the fixed script lines (opener, read-back templates, bridging line, close)
 *     are pre-rendered once at call start and served from memory afterwards, so
 *     they play instantly rather than costing a round trip;
 *   - `groupDigits` puts spaces between digits before synthesis, because "2150"
 *     read as "two thousand one hundred and fifty" is wrong for a postcode.
 */

export type SpeakOptions = {
  text: string;
  /** Cache the result keyed by text+voice. Used for the fixed lines. */
  cacheable?: boolean;
};

const cache = new Map<string, Buffer>();

/**
 * Digits a customer reads back should be spoken as digits. Postcodes, NMIs and
 * phone numbers all land here, and all three are read back for confirmation, so
 * getting this wrong shows up as a failed confirmation rather than a cosmetic bug.
 */
export function groupDigits(text: string): string {
  return text.replace(/\b\d{2,}\b/g, (run) => run.split("").join(" "));
}

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

/** 8 kHz mulaw silence. Stands in for real audio so the loop can run dry. */
function mockAudio(seconds = 0.4): Buffer {
  return Buffer.alloc(Math.round(8000 * seconds), 0xff);
}

export async function synthesize(opts: SpeakOptions): Promise<Buffer> {
  if (env.mockVoice) return mockAudio();
  if (!has.elevenLabs()) {
    throw new Error("ELEVENLABS_API_KEY / ELEVENLABS_VOICE_ID are not set - cannot synthesize");
  }

  const text = groupDigits(opts.text.trim());
  const key = `${env.ttsModel}|${env.elevenLabsVoiceId}|${text}`;
  if (opts.cacheable) {
    const hit = cache.get(key);
    if (hit) return hit;
  }

  // Build block P3: open the ElevenLabs ws with output_format=ulaw_8000, stream the
  // text in sentence-sized chunks, and return the concatenated mulaw.
  throw new Error("voice/tts.ts: ElevenLabs streaming not implemented yet (build block P3)");
}

/**
 * Pre-renders the lines that are always the same, at call start.
 *
 * These are the lines the demo leans on - the consent opener has to land instantly
 * or the call opens with dead air, and the bridging line has to play the moment an
 * escalation fires, before the transfer.
 */
export async function prerender(lines: string[]): Promise<void> {
  if (env.mockVoice) {
    log.info(`tts: MOCK_VOICE=1, skipped pre-rendering ${lines.length} fixed lines`);
    return;
  }
  await Promise.all(lines.map((text) => synthesize({ text, cacheable: true })));
  log.info(`tts: pre-rendered ${lines.length} fixed lines`);
}

export function cachedLineCount(): number {
  return cache.size;
}

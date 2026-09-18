import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { env, has } from "./env.js";
import { synthesize } from "./voice/tts.js";
import { openStt } from "./voice/stt.js";

/**
 * `pnpm voice:check` - the vendor smoke test.
 *
 * Synthesises a known sentence with Flash, then feeds those exact bytes back into
 * Scribe as if they had arrived off a Twilio media stream. If the transcript comes
 * back recognisable, then both sockets work, the auth headers survived, and the
 * ulaw_8000 assumption holds on both ends - which is the whole no-transcode claim.
 *
 * Doing this before a phone call matters because a real call fails all at once and
 * tells you nothing about which half broke.
 */

const PHRASE = "Forty two Wattle Street, Parramatta, postcode two one five zero.";
const FRAME_BYTES = 160; // 20ms of ulaw at 8kHz, the size Twilio sends
const SAMPLE_RATE = 8000;

/** ulaw silence is 0xFF. Scribe's VAD needs trailing quiet to close the turn. */
function silence(ms: number): Buffer {
  return Buffer.alloc(Math.round((SAMPLE_RATE * ms) / 1000), 0xff);
}

const NUMBER_WORDS: Record<string, string> = {
  zero: "0", one: "1", two: "2", three: "3", four: "4",
  five: "5", six: "6", seven: "7", eight: "8", nine: "9",
};

/**
 * Compares on meaning, not spelling.
 *
 * Scribe formats numbers as it goes: "forty two" comes back as "42" and "two one
 * five zero" as "2150". Both are correct - arguably more useful than verbatim -
 * so a naive word match scores a perfect transcription at 40%.
 */
function similarity(a: string, b: string): number {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter(Boolean)
      .flatMap((w) => (NUMBER_WORDS[w] ? [NUMBER_WORDS[w]] : [w]))
      .join(" ")
      .replace(/\b(\d)\s+(?=\d\b)/g, "$1")
      .split(/\s+/)
      .filter(Boolean);
  const want = norm(a);
  const got = new Set(norm(b));
  if (!want.length) return 0;
  return want.filter((w) => got.has(w)).length / want.length;
}

async function main(): Promise<void> {
  if (env.mockVoice) {
    console.error("MOCK_VOICE=1 - this check only means something with it off.");
    console.error("Run: MOCK_VOICE=0 pnpm voice:check");
    process.exit(1);
  }
  if (!has.tts()) {
    console.error("ELEVENLABS_API_KEY / ELEVENLABS_VOICE_ID are not set.");
    process.exit(1);
  }

  // ---- 1. TTS -------------------------------------------------------------
  console.log(`tts   synthesising with ${env.ttsModel}, voice ${env.elevenLabsVoiceId}`);
  const ttsStart = Date.now();
  const audio = await synthesize({ text: PHRASE });
  const ttsMs = Date.now() - ttsStart;

  if (!audio.length) {
    console.error("FAIL  tts returned zero bytes");
    process.exit(1);
  }
  const seconds = audio.length / SAMPLE_RATE;
  console.log(`ok    tts ${audio.length} bytes = ${seconds.toFixed(2)}s of ulaw@8k in ${ttsMs}ms`);

  // A wildly wrong duration is how a format mismatch shows up: mp3 or pcm16
  // returned instead of ulaw would make this number nonsense rather than error.
  if (seconds < 1 || seconds > 15) {
    console.error(`FAIL  ${seconds.toFixed(2)}s is not a plausible duration - check output_format`);
    process.exit(1);
  }

  const outDir = resolve(process.cwd(), ".voice-check");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(resolve(outDir, "tts.ulaw"), audio);
  console.log(`      wrote ${resolve(outDir, "tts.ulaw")}`);
  console.log(`      play with: ffplay -f mulaw -ar 8000 -ac 1 ${resolve(outDir, "tts.ulaw")}`);

  if (!has.stt()) {
    console.log("\nskip  stt - no key for the configured provider");
    process.exit(0);
  }

  // ---- 2. STT -------------------------------------------------------------
  console.log(`\nstt   opening ${env.sttProvider}/${env.sttModel}`);
  let partials = 0;
  let firstPartialAt: number | null = null;
  const finals: { text: string; confidence: number | null; at: number }[] = [];
  const entities: string[] = [];
  const errors: string[] = [];

  const started = Date.now();
  const session = await openStt({
    label: "voice-check",
    keywords: ["Wattle", "Parramatta"],
    events: {
      onPartial: () => {
        partials++;
        firstPartialAt ??= Date.now();
      },
      onFinal: (text, confidence) => finals.push({ text, confidence, at: Date.now() }),
      onSensitiveEntity: (type, text) => entities.push(`${type}: ${text}`),
      onError: (err) => errors.push(err.message),
    },
  });
  console.log(`ok    socket open in ${Date.now() - started}ms`);

  // Paced at 20ms per frame, the way Twilio actually delivers audio. Firing the
  // whole clip at once would test a condition that never happens on a call.
  const withTail = Buffer.concat([silence(300), audio, silence(1500)]);
  const sendStart = Date.now();
  for (let off = 0; off < withTail.length; off += FRAME_BYTES) {
    session.push(withTail.subarray(off, off + FRAME_BYTES).toString("base64"));
    await new Promise((r) => setTimeout(r, 20));
  }
  console.log(`      streamed ${Math.ceil(withTail.length / FRAME_BYTES)} frames in ${Date.now() - sendStart}ms`);

  // Give VAD a moment to commit before giving up on it.
  const deadline = Date.now() + 8000;
  while (!finals.length && Date.now() < deadline && !errors.length) {
    await new Promise((r) => setTimeout(r, 100));
  }
  session.close();

  // ---- 3. Verdict ---------------------------------------------------------
  console.log("");
  for (const err of errors) console.error(`FAIL  stt error: ${err}`);
  if (errors.length) process.exit(1);

  if (!finals.length) {
    console.error("FAIL  no committed transcript within 8s of the audio ending");
    console.error(`      ${partials} partials were received, so the socket was alive`);
    process.exit(1);
  }

  const heard = finals.map((f) => f.text).join(" ");
  const confidence = finals[0]?.confidence ?? null;
  // "forty two" -> "42" both ways, so the comparison is on digits either way.
  const score = Math.max(similarity(PHRASE, heard), similarity(heard, PHRASE));

  console.log(`sent  "${PHRASE}"`);
  console.log(`heard "${heard.trim()}"`);
  console.log(`      ${partials} partials, confidence ${confidence?.toFixed(3) ?? "n/a"}, word match ${(score * 100).toFixed(0)}%`);
  if (entities.length) console.log(`      entities: ${entities.join(", ")}`);

  if (score < 0.6) {
    console.error(`\nFAIL  transcript does not match what was sent - check audio_format`);
    process.exit(1);
  }
  if (confidence === null) {
    console.error("\nFAIL  no confidence returned - LOW CONF cannot work without it");
    process.exit(1);
  }

  console.log("\nAll checks passed. TTS and STT both speak ulaw_8000 with no transcode.");
  process.exit(0);
}

void main().catch((err) => {
  console.error(`\nFAIL  ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

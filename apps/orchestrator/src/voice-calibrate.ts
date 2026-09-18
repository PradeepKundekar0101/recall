import { env } from "./env.js";
import { synthesize } from "./voice/tts.js";
import { openStt } from "./voice/stt.js";
import { meanConfidence } from "./voice/stt/scribe.js";

/**
 * `pnpm voice:calibrate` - measures the confidence scale before trusting it.
 *
 * Scribe reports per-word log probabilities, not a 0-1 confidence like Deepgram.
 * The two are not on the same scale, so the thresholds that gate whether a value
 * is written or re-asked have to be measured rather than carried over.
 *
 * Runs each phrase clean and again through degraded audio, and prints the spread.
 * The gap between those two distributions is what the thresholds have to sit in.
 */

const PHRASES = [
  "Forty two Wattle Street, Parramatta.",
  "My email is priya dot sharma at gmail dot com.",
  "The postcode is two one five zero.",
  "Yes, that's right, electricity only.",
];

const FRAME = 160;
const DEGRADE_NOISE = Number(process.env.DEGRADE_NOISE ?? 0.04);
const DEGRADE_DROP = Number(process.env.DEGRADE_DROP ?? 0);

/**
 * Degrades ulaw toward a bad mobile line.
 *
 * ulaw is logarithmically companded, so adding linear noise to the encoded bytes
 * is far more destructive than the same noise on the waveform - at 0.18 it
 * destroyed the signal completely and Scribe returned no transcript at all, which
 * is a different failure from a low-confidence one. Kept gentle for that reason.
 */
function degrade(audio: Buffer, noise: number, dropEvery: number): Buffer {
  const out = Buffer.from(audio);
  for (let i = 0; i < out.length; i++) {
    if (dropEvery && Math.floor(i / FRAME) % dropEvery === 0) {
      out[i] = 0xff; // a dropped 20ms frame reads as silence
      continue;
    }
    const jitter = Math.round((Math.random() - 0.5) * 2 * noise * 255);
    out[i] = Math.max(0, Math.min(255, (out[i] as number) + jitter));
  }
  return out;
}

async function transcribe(audio: Buffer): Promise<{ text: string; confidence: number | null; raw: number[] }> {
  const raw: number[] = [];
  type Committed = { text: string; confidence: number | null };
  // A holder rather than a bare `let`: TypeScript cannot see that the socket
  // callback assigns it, so it narrows the variable to never after the wait loop.
  const box: { value: Committed | null } = { value: null };

  const session = await openStt({
    label: "calibrate",
    events: {
      onFinal: (text, confidence) => {
        box.value ??= { text, confidence };
      },
    },
  });

  const all = Buffer.concat([Buffer.alloc(2400, 0xff), audio, Buffer.alloc(12000, 0xff)]);
  for (let o = 0; o < all.length; o += FRAME) {
    session.push(all.subarray(o, o + FRAME).toString("base64"));
    await new Promise((r) => setTimeout(r, 5));
  }

  const deadline = Date.now() + 10000;
  while (!box.value && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  session.close();
  return { text: box.value?.text ?? "", confidence: box.value?.confidence ?? null, raw };
}

async function main(): Promise<void> {
  if (env.mockVoice) {
    console.error("MOCK_VOICE=1 - calibration needs the real services. Use MOCK_VOICE=0.");
    process.exit(1);
  }

  const clean: number[] = [];
  const noisy: number[] = [];

  console.log("phrase".padEnd(46), "clean", " noisy", " transcript (noisy)");
  console.log("-".repeat(110));

  for (const phrase of PHRASES) {
    const audio = await synthesize({ text: phrase });
    const a = await transcribe(audio);
    const b = await transcribe(degrade(audio, DEGRADE_NOISE, DEGRADE_DROP));

    if (a.confidence !== null) clean.push(a.confidence);
    if (b.confidence !== null) noisy.push(b.confidence);

    console.log(
      phrase.slice(0, 44).padEnd(46),
      (a.confidence?.toFixed(3) ?? " n/a ").padStart(5),
      (b.confidence?.toFixed(3) ?? " n/a ").padStart(6),
      " ",
      b.text.slice(0, 44)
    );
  }

  const stats = (xs: number[]) =>
    xs.length
      ? {
          min: Math.min(...xs).toFixed(3),
          mean: (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(3),
          max: Math.max(...xs).toFixed(3),
        }
      : null;

  console.log("\nclean:", JSON.stringify(stats(clean)));
  console.log("noisy:", JSON.stringify(stats(noisy)));

  if (clean.length && noisy.length) {
    const cleanMin = Math.min(...clean);
    const noisyMax = Math.max(...noisy);
    console.log(
      `\nclean floor ${cleanMin.toFixed(3)} vs noisy ceiling ${noisyMax.toFixed(3)} - ` +
        (cleanMin > noisyMax
          ? `separable; put the accept threshold between them, around ${((cleanMin + noisyMax) / 2).toFixed(2)}`
          : "overlapping; confidence alone cannot separate these, so lean on read-back rather than the gate")
    );
  }
  void meanConfidence;
  process.exit(0);
}

void main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

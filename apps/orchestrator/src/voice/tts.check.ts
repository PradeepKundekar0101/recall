import { TARGET_RMS, levelLoudness, linearToUlaw, rmsOf, spellOut, ulawToLinear } from "./tts.js";

/**
 * `pnpm tts:check` - the pure parts of the speech layer, in milliseconds.
 *
 * Loudness levelling runs on every utterance that reaches the wire, so it has
 * to be right on the boundaries: a quiet line comes up, a hot filler comes
 * down, a spike is not allowed to clip, and silence is left alone.
 */

let failures = 0;

function check(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? `  (${detail})` : ""}`);
}

/** Half a second of 8 kHz mulaw sine at the given amplitude. */
function tone(amplitude: number, seconds = 0.5): Buffer {
  const out = Buffer.alloc(Math.round(8000 * seconds));
  for (let i = 0; i < out.length; i++) {
    out[i] = linearToUlaw(Math.round(amplitude * Math.sin((2 * Math.PI * 440 * i) / 8000)));
  }
  return out;
}

function peakOf(ulaw: Buffer): number {
  let peak = 0;
  for (const s of ulawToLinear(ulaw)) peak = Math.max(peak, Math.abs(s));
  return peak;
}

const within = (value: number, target: number, tolerance: number) => Math.abs(value - target) <= target * tolerance;

// The codec round-trips: the encoder and the decode table agree with each other.
{
  const original = tone(3000);
  const again = Buffer.from(Array.from(ulawToLinear(original), (s) => linearToUlaw(s)));
  check("mulaw encode/decode round-trips", original.equals(again));
}

// A soft line is brought up to the target.
{
  const soft = tone(800);
  const levelled = levelLoudness(soft);
  check("a quiet line is raised to the target", within(rmsOf(levelled), TARGET_RMS, 0.1), `rms ${rmsOf(soft).toFixed(0)} -> ${rmsOf(levelled).toFixed(0)}`);
}

// A hot filler is brought down to the same target.
{
  const hot = tone(20000);
  const levelled = levelLoudness(hot);
  check("a loud line is lowered to the target", within(rmsOf(levelled), TARGET_RMS, 0.1), `rms ${rmsOf(hot).toFixed(0)} -> ${rmsOf(levelled).toFixed(0)}`);
}

// A mostly-quiet line with one spike must not be pushed into clipping.
{
  const spiky = tone(300);
  spiky[1000] = linearToUlaw(30000);
  spiky[1001] = linearToUlaw(-30000);
  const levelled = levelLoudness(spiky);
  check("the peak ceiling wins over the target", peakOf(levelled) <= 28000 + 300, `peak ${peakOf(levelled)}`);
}

// Silence, which is also what MOCK_VOICE produces, passes through untouched.
{
  const silence = Buffer.alloc(4000, 0xff);
  check("silence is left alone", levelLoudness(silence).equals(silence));
  check("an empty buffer is left alone", levelLoudness(Buffer.alloc(0)).length === 0);
}

// The letters confirm mode still reads punctuation out loud.
check("spellOut names the at and the dot", /, at, /.test(spellOut("priya.sharma@example.com")) && /, dot, /.test(spellOut("priya.sharma@example.com")));

console.log(failures ? `\n${failures} failure(s).` : "\nAll speech checks pass.");
process.exit(failures ? 1 : 0);

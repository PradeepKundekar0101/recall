import { readFileSync } from "node:fs";
import { env } from "./env.js";
import { openStt } from "./voice/stt.js";
import { linearToUlaw } from "./voice/tts.js";
import { recognitionKeywords } from "./transports/twilio.js";
import { loadJourney } from "./journey/index.js";
import { loadLeads } from "./leads/index.js";

/**
 * `pnpm voice:replay <recording.wav> [--no-keyterms]` - a call recording back
 * through the live STT socket.
 *
 * The first journey call transcribed three customer turns as garbage, and the
 * log could not say whether the audio was bad or the transcriber was. This
 * settles it. Twilio's recording of the call - 8 kHz, 16-bit mono WAV, from the
 * console or the Recordings API - is framed and paced exactly as the media
 * stream delivers audio, through the same `openStt()` the transport uses, with
 * the same keyterms. If the words come back here, the live path lost them; if
 * they do not, the line did.
 *
 * Runs in real time: a sixty-second call takes sixty seconds.
 */

const FRAME = 160; // 20 ms of mulaw at 8 kHz

function pcmFromWav(buf: Buffer): Int16Array {
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("not a WAV file");
  }
  let channels = 0;
  let rate = 0;
  let bits = 0;
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === "fmt ") {
      channels = buf.readUInt16LE(offset + 10);
      rate = buf.readUInt32LE(offset + 12);
      bits = buf.readUInt16LE(offset + 22);
    }
    if (id === "data") {
      if (channels !== 1 || rate !== 8000 || bits !== 16) {
        throw new Error(
          `expected 8 kHz 16-bit mono, got ${rate} Hz ${bits}-bit ${channels}ch - ` +
            "Twilio recordings are 8 kHz mono; otherwise convert with: ffmpeg -i in.wav -ar 8000 -ac 1 out.wav"
        );
      }
      const start = buf.byteOffset + offset + 8;
      return new Int16Array(buf.buffer.slice(start, start + size));
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error("WAV file has no data chunk");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const wavPath = args.find((a) => !a.startsWith("--"));
  const useKeyterms = !args.includes("--no-keyterms");
  if (!wavPath) {
    console.error("usage: pnpm voice:replay <recording.wav> [--no-keyterms]");
    process.exit(1);
  }
  if (env.mockVoice) {
    console.error("MOCK_VOICE=1 - there is no socket to replay into. Use MOCK_VOICE=0.");
    process.exit(1);
  }

  const pcm = pcmFromWav(readFileSync(wavPath));
  const ulaw = Buffer.alloc(pcm.length);
  for (let i = 0; i < pcm.length; i++) ulaw[i] = linearToUlaw(pcm[i] as number);

  const keywords = useKeyterms
    ? recognitionKeywords({ journey: loadJourney(), lead: loadLeads()[0]!, callId: "replay" })
    : [];

  const provider = env.sttProvider === "scribe" ? `scribe/${env.sttModel}` : `deepgram/${env.deepgramModel}`;
  console.log(`replay ${(ulaw.length / 8000).toFixed(1)}s of audio into ${provider}, ${keywords.length} keyterms\n`);

  let framesSent = 0;
  const at = () => `${((framesSent * 20) / 1000).toFixed(2).padStart(6)}s`;
  const confidences: number[] = [];
  let finals = 0;

  const session = await openStt({
    label: "replay",
    keywords,
    events: {
      onPartial: (text) => console.log(`${at()}    ~ ${text}`),
      onFinal: (text, confidence) => {
        finals++;
        if (confidence !== null) confidences.push(confidence);
        console.log(`${at()}  FINAL conf=${confidence === null ? "n/a" : confidence.toFixed(2)} | ${text}`);
      },
      onError: (err) => console.error(`${at()}  ERROR ${err.message}`),
    },
  });

  // Paced at 20 ms a frame, the way Twilio delivers it. Faster would test a
  // condition that never happens on a call.
  const started = Date.now();
  for (let off = 0; off < ulaw.length; off += FRAME, framesSent++) {
    session.push(ulaw.subarray(off, off + FRAME).toString("base64"));
    const wait = started + (framesSent + 1) * 20 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
  // Two seconds of silence so the VAD closes the last turn, then a moment for
  // the commit to arrive.
  for (let i = 0; i < 100; i++, framesSent++) {
    session.push(Buffer.alloc(FRAME, 0xff).toString("base64"));
    await new Promise((r) => setTimeout(r, 20));
  }
  await new Promise((r) => setTimeout(r, 3000));
  session.close();

  const mean = confidences.length ? confidences.reduce((a, b) => a + b, 0) / confidences.length : null;
  console.log(
    `\n${finals} committed transcript(s)` +
      (mean === null ? "" : `, confidence ${Math.min(...confidences).toFixed(2)} to ${Math.max(...confidences).toFixed(2)}, mean ${mean.toFixed(2)}`)
  );
  process.exit(0);
}

void main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

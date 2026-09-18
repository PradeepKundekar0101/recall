import { env, has } from "../env.js";
import { log } from "../log.js";
import { openScribe } from "./stt/scribe.js";
import { openDeepgram } from "./stt/deepgram.js";
import type { SttOptions, SttSession } from "./stt/types.js";

export type { SttEvents, SttSession, SttOptions } from "./stt/types.js";
export { meanConfidence, scribeQuery } from "./stt/scribe.js";
export { deepgramQuery } from "./stt/deepgram.js";

/**
 * Provider switch. Nothing above this line knows which vendor is transcribing.
 */

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
    log.info(`[${opts.label ?? "stt"}] MOCK_VOICE=1, no STT socket opened`);
    return mockSession();
  }
  if (!has.stt()) {
    throw new Error(
      env.sttProvider === "scribe"
        ? "ELEVENLABS_API_KEY is not set - cannot open a Scribe socket"
        : "DEEPGRAM_API_KEY is not set - cannot open a Deepgram socket"
    );
  }
  return env.sttProvider === "scribe" ? openScribe(opts) : openDeepgram(opts);
}

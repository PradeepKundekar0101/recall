import { WebSocket } from "ws";
import { env } from "../../env.js";
import { log } from "../../log.js";
import type { SttOptions, SttSession } from "./types.js";

/**
 * Deepgram Nova-3, the fallback behind STT_PROVIDER=deepgram.
 *
 * Kept wired but not the build target. It also takes Twilio's mulaw natively, so
 * switching providers is an env change rather than an audio-path change - which is
 * the whole point of having the seam if Scribe wobbles on the venue network.
 */

const URL_BASE = "wss://api.deepgram.com/v1/listen";

type DeepgramAlternative = { transcript: string; confidence?: number };
type DeepgramMessage = {
  type?: string;
  is_final?: boolean;
  speech_final?: boolean;
  channel?: { alternatives?: DeepgramAlternative[] };
};

export function deepgramQuery(opts: SttOptions): URLSearchParams {
  const params = new URLSearchParams({
    model: env.deepgramModel,
    language: "en-AU",
    encoding: "mulaw",
    sample_rate: "8000",
    channels: "1",
    endpointing: String(opts.silenceMs ?? 300),
    interim_results: "true",
    vad_events: "true",
    punctuate: "true",
    smart_format: "true",
  });
  if (opts.keywords?.length) {
    for (const term of opts.keywords.slice(0, 100)) params.append("keyterm", term);
  }
  return params;
}

export async function openDeepgram(opts: SttOptions): Promise<SttSession> {
  const { events } = opts;
  const label = opts.label ?? "deepgram";

  const socket = new WebSocket(`${URL_BASE}?${deepgramQuery(opts).toString()}`, {
    headers: { Authorization: `Token ${env.deepgramKey}` },
  });

  let ready = false;
  let closed = false;
  const backlog: string[] = [];

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("deepgram did not open within 8s")), 8000);
    socket.on("open", () => {
      clearTimeout(timer);
      ready = true;
      for (const chunk of backlog.splice(0)) socket.send(Buffer.from(chunk, "base64"));
      log.info(`[${label}] deepgram open (${env.deepgramModel}, mulaw 8k)`);
      resolve();
    });
    socket.on("error", (err) => {
      clearTimeout(timer);
      events.onError?.(err);
      reject(err);
    });
  });

  socket.on("message", (data) => {
    let msg: DeepgramMessage;
    try {
      msg = JSON.parse(data.toString()) as DeepgramMessage;
    } catch {
      return;
    }

    if (msg.type === "SpeechStarted") {
      events.onSpeechStart?.();
      return;
    }
    if (msg.type === "UtteranceEnd") {
      events.onSpeechEnd?.();
      return;
    }

    const alt = msg.channel?.alternatives?.[0];
    const text = alt?.transcript ?? "";
    if (!text.trim()) return;

    if (msg.is_final) events.onFinal?.(text, alt?.confidence ?? null);
    else events.onPartial?.(text);
  });

  socket.on("close", () => {
    closed = true;
    ready = false;
    events.onClose?.();
  });

  return {
    push(base64Ulaw) {
      if (closed) return;
      if (!ready) {
        backlog.push(base64Ulaw);
        return;
      }
      // Deepgram takes raw binary frames, not a base64 JSON envelope.
      socket.send(Buffer.from(base64Ulaw, "base64"));
    },
    flush() {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "Finalize" }));
    },
    close() {
      closed = true;
      try {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "CloseStream" }));
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

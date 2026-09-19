"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { API } from "./api";

/**
 * Listens to the agent's own voice, live, from the machine running the demo.
 *
 * The orchestrator publishes every frame it writes to Twilio on a local
 * websocket. That is the agent only - the customer's audio is never on this
 * socket - so the monitor is a way to hear what the customer is hearing
 * without a second handset in the room, and it cannot be turned into a way to
 * listen to the customer.
 *
 * Two things make this harder than "decode and play". Frames arrive far faster
 * than realtime, because we write a whole reply into Twilio's buffer in a few
 * milliseconds; and they arrive in bursts with silence between them, because
 * the agent only talks on its turn. So playback is scheduled against the audio
 * clock rather than played on arrival, and the schedule is allowed to run at
 * most a jitter buffer ahead of it.
 */

/** How far ahead of the audio clock playback is allowed to be scheduled. */
const JITTER_MS = 100;

/** Twilio's media format, and ours end to end. */
const SAMPLE_RATE = 8000;

/**
 * mulaw to linear, as a lookup table.
 *
 * The same expansion the orchestrator does in `voice/tts.ts`. 256 entries,
 * built once per module rather than per frame.
 */
const ULAW_TO_LINEAR = new Int16Array(256);
for (let byte = 0; byte < 256; byte++) {
  const inverted = ~byte & 0xff;
  const exponent = (inverted >> 4) & 0x07;
  const mantissa = inverted & 0x0f;
  const magnitude = (((mantissa << 3) + 0x84) << exponent) - 0x84;
  ULAW_TO_LINEAR[byte] = inverted & 0x80 ? -magnitude : magnitude;
}

/** The wire format: one length-prefixed call id, then the ulaw payload. */
function parseFrame(buffer: ArrayBuffer): { callId: string; ulaw: Uint8Array } | null {
  const bytes = new Uint8Array(buffer);
  if (!bytes.length) return null;
  const idLength = bytes[0] as number;
  if (bytes.length < 1 + idLength) return null;
  return {
    callId: new TextDecoder().decode(bytes.subarray(1, 1 + idLength)),
    ulaw: bytes.subarray(1 + idLength),
  };
}

export type MonitorState = {
  /** Whether the operator has asked to listen. */
  on: boolean;
  toggle: () => void;
  /** The socket is open. False while connecting, or after it dropped. */
  connected: boolean;
  /** Seconds of agent audio played since the monitor was switched on. */
  heardS: number;
  /** Why it is not working, when it is not. */
  error: string | null;
};

export function useMonitor(callId: string | null): MonitorState {
  const [on, setOn] = useState(false);
  const [connected, setConnected] = useState(false);
  const [heardS, setHeardS] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const context = useRef<AudioContext | null>(null);
  /** When the audio already scheduled will have finished, on the audio clock. */
  const playhead = useRef(0);

  const toggle = useCallback(() => setOn((v) => !v), []);

  useEffect(() => {
    if (!on || !callId) return;

    let closed = false;
    let socket: WebSocket | null = null;
    let played = 0;

    // Created inside the gesture-initiated effect: browsers suspend a context
    // built without one, and a suspended context schedules silently forever.
    let audio: AudioContext;
    try {
      audio = new AudioContext({ sampleRate: SAMPLE_RATE });
    } catch {
      // Safari refuses a non-native rate. Resampling is done per buffer below,
      // so the context's own rate only has to be something it will give us.
      audio = new AudioContext();
    }
    context.current = audio;
    void audio.resume().catch(() => undefined);
    playhead.current = 0;

    const url = `${API.replace(/^http/, "ws")}/monitor?call=${encodeURIComponent(callId)}`;
    try {
      socket = new WebSocket(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not open the monitor socket");
      return;
    }
    socket.binaryType = "arraybuffer";

    socket.onopen = () => {
      if (closed) return;
      setConnected(true);
      setError(null);
    };
    socket.onerror = () => {
      if (closed) return;
      setConnected(false);
      setError(`no monitor at ${url} - is the orchestrator running?`);
    };
    socket.onclose = () => {
      if (!closed) setConnected(false);
    };

    socket.onmessage = (message) => {
      // The hello frame is text; everything else is audio.
      if (typeof message.data === "string") return;
      const frame = parseFrame(message.data as ArrayBuffer);
      if (!frame || !frame.ulaw.length) return;
      if (frame.callId !== callId) return;

      const samples = frame.ulaw.length;
      const buffer = audio.createBuffer(1, samples, SAMPLE_RATE);
      const channel = buffer.getChannelData(0);
      for (let i = 0; i < samples; i++) {
        channel[i] = (ULAW_TO_LINEAR[frame.ulaw[i] as number] as number) / 32768;
      }

      /**
       * Scheduled against the audio clock, not played on arrival.
       *
       * `playhead` is where the audio queued so far runs out. A frame that
       * arrives while there is still audio queued goes on the end of it; one
       * that arrives after a gap - the agent finished its line a moment ago -
       * starts a fresh schedule a jitter buffer from now. Without the second
       * case, every burst would be played back to back and the monitor would
       * run steadily further ahead of the call.
       */
      const startAt = Math.max(playhead.current, audio.currentTime + JITTER_MS / 1000);
      const source = audio.createBufferSource();
      source.buffer = buffer;
      source.connect(audio.destination);
      source.start(startAt);
      playhead.current = startAt + samples / SAMPLE_RATE;

      played += samples / SAMPLE_RATE;
      setHeardS(Math.round(played));
    };

    return () => {
      closed = true;
      setConnected(false);
      try {
        socket?.close();
      } catch {
        /* already gone */
      }
      void audio.close().catch(() => undefined);
      context.current = null;
    };
  }, [on, callId]);

  // Switching off resets the counter, so the next listen reads as its own.
  useEffect(() => {
    if (!on) {
      setHeardS(0);
      setError(null);
    }
  }, [on]);

  return { on, toggle, connected, heardS, error };
}

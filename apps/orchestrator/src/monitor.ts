import { spawn, type ChildProcess } from "node:child_process";
import type { WebSocket } from "ws";
import { env } from "./env.js";
import { log } from "./log.js";

/**
 * A local tap on the agent's own voice.
 *
 * Every frame the agent puts on the wire is also published here, so the voice
 * can be heard from the room the orchestrator is running in rather than only
 * through a handset. That is the difference between "the customer says it
 * sounded broken" and hearing what they heard.
 *
 * Agent audio only, ever. The inbound track is the customer's voice and
 * monitoring it would turn a debugging aid into a wiretap - and it is also the
 * one thing that could feed back into the very echo path this exists to
 * diagnose, if the console were played through a speaker in the same room.
 *
 * Nothing on this path is allowed to affect the call. Every publish is wrapped,
 * a subscriber that throws is dropped rather than propagated, and a monitor
 * with no listeners costs one Map lookup per frame.
 */

/**
 * Wire format, one binary frame per audio frame:
 *
 *     [1 byte: length of the call id][call id, utf8][ulaw 8 kHz payload]
 *
 * Self-describing on purpose. A text frame announcing "the next frames belong
 * to call X" would be correct until two calls overlap, and then silently wrong
 * - which is exactly the kind of bug that only shows up when a second phone is
 * in the room.
 */
export function frameFor(callId: string, ulaw: Buffer): Buffer {
  const id = Buffer.from(callId, "utf8").subarray(0, 255);
  const header = Buffer.alloc(1 + id.length);
  header.writeUInt8(id.length, 0);
  id.copy(header, 1);
  return Buffer.concat([header, ulaw]);
}

/** The inverse, for the console and for the checks. */
export function parseFrame(frame: Buffer): { callId: string; ulaw: Buffer } | null {
  if (frame.length < 1) return null;
  const idLength = frame.readUInt8(0);
  if (frame.length < 1 + idLength) return null;
  return {
    callId: frame.subarray(1, 1 + idLength).toString("utf8"),
    ulaw: frame.subarray(1 + idLength),
  };
}

type Subscriber = {
  socket: WebSocket;
  /** Only this call's audio, when the client asked for one. */
  callId: string | null;
};

const subscribers = new Set<Subscriber>();

/**
 * The CLI sink, paced to realtime.
 *
 * Frames are written to Twilio far faster than they play, so piping them
 * straight at a player means the monitor runs ahead of the call and the
 * sentences arrive jammed together. The browser schedules its own playback;
 * ffplay just plays what it is given, so the pacing has to happen here.
 */
class RealtimeSink {
  private child: ChildProcess | null = null;
  private queue: Buffer[] = [];
  private timer: NodeJS.Timeout | null = null;
  /** Wall clock at which the audio written so far will have finished playing. */
  private playheadAt = 0;
  private failed = false;

  constructor(private command: string) {}

  push(ulaw: Buffer): void {
    if (this.failed || !ulaw.length) return;
    this.queue.push(ulaw);
    this.pump();
  }

  private start(): ChildProcess | null {
    if (this.child || this.failed) return this.child;
    try {
      // The arguments are fixed rather than taken from the environment: this
      // spawns a process, and the only thing the operator gets to choose is
      // which player binary, not what it is asked to do.
      this.child = spawn(this.command, ["-f", "mulaw", "-ar", "8000", "-nodisp", "-autoexit", "-i", "-"], {
        stdio: ["pipe", "ignore", "ignore"],
      });
      this.child.on("error", (err) => {
        this.failed = true;
        this.child = null;
        log.warn(`monitor: ${this.command} could not be started (${err.message}) - falling back to silence`);
      });
      this.child.on("exit", () => {
        this.child = null;
        this.playheadAt = 0;
      });
      log.info(`monitor: piping agent audio to ${this.command}`);
    } catch (err) {
      this.failed = true;
      log.warn(`monitor: ${this.command} could not be started (${String(err)})`);
    }
    return this.child;
  }

  /** Writes one frame's worth every 20 ms, which is what 8 kHz ulaw plays at. */
  private pump(): void {
    if (this.timer) return;
    const write = () => {
      this.timer = null;
      const next = this.queue.shift();
      if (!next) {
        this.playheadAt = 0;
        return;
      }
      const child = this.start();
      if (!child?.stdin?.writable) {
        this.queue.length = 0;
        return;
      }
      child.stdin.write(next);
      const now = Date.now();
      this.playheadAt = Math.max(this.playheadAt, now) + (next.length / 8000) * 1000;
      if (this.queue.length) this.timer = setTimeout(write, Math.max(0, this.playheadAt - now)).unref?.() ?? null;
    };
    write();
  }
}

const cliSink = env.monitorCmd ? new RealtimeSink(env.monitorCmd) : null;

/**
 * Publish one frame of agent audio.
 *
 * Called from the single point where ulaw reaches Twilio, so a line that came
 * off the pre-render cache and a line that was just synthesised are both heard
 * here - there is no second path to forget about.
 */
export function publishAgentAudio(callId: string, ulaw: Buffer): void {
  if (!ulaw.length) return;
  if (!subscribers.size && !cliSink) return;

  try {
    cliSink?.push(ulaw);
    if (!subscribers.size) return;
    const frame = frameFor(callId, ulaw);
    for (const subscriber of subscribers) {
      if (subscriber.callId && subscriber.callId !== callId) continue;
      try {
        // 1 is OPEN. Imported as a value only to compare would pull ws into a
        // module the checks run without a socket library for.
        if (subscriber.socket.readyState === 1) subscriber.socket.send(frame);
      } catch {
        subscribers.delete(subscriber);
      }
    }
  } catch (err) {
    // A monitor that fails is a monitor that is off, not a call that ends.
    log.warn(`monitor publish failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Attaches a console's websocket. `callId` narrows it to one call. */
export function attachMonitor(socket: WebSocket, callId: string | null): void {
  const subscriber: Subscriber = { socket, callId };
  subscribers.add(subscriber);
  log.info(`monitor attached${callId ? ` for ${callId.slice(0, 8)}` : " (all calls)"} - ${subscribers.size} listening`);

  // A hello frame, as text, so a client that connects between utterances knows
  // it is connected rather than waiting on audio that may be a minute away.
  try {
    socket.send(JSON.stringify({ type: "monitor.hello", call_id: callId, format: "ulaw_8000" }));
  } catch {
    /* it went away between accept and hello */
  }

  const detach = () => {
    if (!subscribers.delete(subscriber)) return;
    log.info(`monitor detached - ${subscribers.size} listening`);
  };
  socket.on("close", detach);
  socket.on("error", detach);
}

export function monitorListenerCount(): number {
  return subscribers.size;
}

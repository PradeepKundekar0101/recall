import type { WebSocket } from "ws";
import twilio from "twilio";
import { env } from "../env.js";
import { log } from "../log.js";
import { openStt, type SttSession } from "../voice/stt.js";
import type { SttOpener } from "../voice/stt/types.js";
import { synthesize } from "../voice/tts.js";
import type { Transport, TransportDeps, TransportEndReason } from "../engine/transport.js";

/**
 * Twilio Media Streams <-> Deepgram / ElevenLabs, mulaw 8k end to end.
 *
 * There is no transcode layer in this file, and that is the point: Twilio's frames
 * go straight into Deepgram's realtime socket, and ElevenLabs' mulaw comes straight
 * back out to Twilio. Turn detection is Deepgram's server-side endpointing, so
 * nothing here counts silence.
 *
 * Ported from buildin-hours with the vendor swap and one addition: `transfer()`,
 * which redirects the live call to a human with a whisper. The barge-in and echo
 * defence below are unchanged, because they were earned against a real speakerphone
 * in a loud room and that is the same condition this demo runs in.
 */

const FRAME_BYTES = 160; // 20ms of mulaw at 8kHz

/** Media-stream sockets arrive after the dial, so transports park here waiting for theirs. */
const waiting = new Map<string, (ws: WebSocket) => void>();

export function attachMediaStream(callId: string, ws: WebSocket): boolean {
  const resolve = waiting.get(callId);
  if (!resolve) return false;
  waiting.delete(callId);
  resolve(ws);
  return true;
}

/**
 * The slice of the Twilio SDK the transport uses. `pnpm transport:check` injects
 * a fake; everything else gets the real client. Without the seam the check
 * dialled the test handset for real.
 */
export type TwilioClient = Pick<ReturnType<typeof twilio>, "calls">;

let _twilio: ReturnType<typeof twilio> | null = null;
function client(): TwilioClient {
  if (!_twilio) _twilio = twilio(env.twilioSid, env.twilioToken);
  return _twilio;
}

/**
 * Guardrail 1: test data only.
 *
 * Lives here, in the dial path, rather than in a prompt - a synthetic lead that
 * somehow carries a real number must not be reachable by any route, including a
 * model that decides to be helpful.
 */
export function assertTestNumber(to: string): void {
  if (!env.testNumbers.includes(to)) {
    throw new Error(
      `refusing to dial ${to}: not in TEST_NUMBERS (${env.testNumbers.join(", ") || "empty"})`
    );
  }
}

/**
 * Guardrail 1 for the transfer leg.
 *
 * The handoff handset is ours, so it is allowed whether or not it is also a
 * TEST_NUMBER. Requiring it to be one refused every transfer on the second real
 * call: the preflight rightly wants the handoff handset to be a *different*
 * phone from the customer's, and the customer's is the one on the allowlist.
 * What must never happen is dialling a number that is neither ours nor
 * configured, or the phone that is already on the call.
 */
export function assertHandoffNumber(to: string, customer: string): void {
  const ours = new Set([...env.testNumbers, env.handoffNumber].filter(Boolean));
  if (!ours.has(to)) {
    throw new Error(`refusing to transfer to ${to}: not HANDOFF_NUMBER and not in TEST_NUMBERS`);
  }
  if (to === customer) {
    throw new Error(`refusing to transfer to ${to}: that is the phone already on the call`);
  }
}

export class TwilioTransport implements Transport {
  readonly kind = "pstn" as const;
  readonly id: string;
  recordingUrl: string | undefined;

  private ws: WebSocket | null = null;
  private streamSid: string | null = null;
  private twilioCallSid: string | null = null;
  private stt: SttSession | null = null;

  /**
   * Twilio's `start` message - which carries the streamSid we must echo on every
   * outbound frame - arrives *after* the websocket handshake. Anything spoken in
   * that gap has nowhere to go, so we wait for it explicitly rather than letting
   * the consent opener disappear.
   */
  private streamReady!: Promise<void>;
  private markStreamReady!: () => void;

  private utteranceCb: ((text: string, confidence: number | null) => void) | null = null;
  private partialCb: ((text: string) => void) | null = null;
  private bargeInCb: (() => void) | null = null;
  private endedCb: ((reason: TransportEndReason) => void) | null = null;

  /** Resolver for the mark that signals "playback finished". */
  private markResolvers = new Map<string, () => void>();
  private speaking = false;
  private dead = false;
  private framesSent = 0;

  /**
   * Echo defence. On a speakerphone our own playback leaks back into the customer's
   * mic, the VAD opens a turn on it, and a naive barge-in cuts our reply off
   * mid-sentence - which is exactly what a "glitchy, broken" call sounds like.
   * So barge-in is armed by speech_start but only *fires* once a transcript proves
   * there are real words behind it, and any transcript that is mostly our own last
   * line played back at us is dropped instead of being answered.
   */
  private bargeArmed = false;
  private lastSpokenTokens = new Set<string>();
  private playbackEndedAt = 0;

  /**
   * Inbound cadence. Twilio sends a frame every 20 ms; a hole in that rhythm is
   * audio that reached the STT late and in a burst, which on a call looks
   * exactly like the customer saying nothing. On the first journey call one
   * answer never produced a transcript at all, and nothing recorded whether
   * the frames had arrived on time. Now something does.
   */
  private lastMediaAt = 0;
  private inboundStalls = 0;
  private longestStallMs = 0;

  /** False while a line that must be heard whole is playing. */
  private interruptible = true;
  /** Set once the call has been handed to a human. It is theirs from then on. */
  private transferred = false;

  /** Twilio's async AMD verdict, once it lands. Advisory - see notifyAmd(). */
  amdVerdict: string | null = null;

  constructor(private opts: TransportDeps & { client?: TwilioClient; openStt?: SttOpener }) {
    this.id = opts.callId;
    this.streamReady = new Promise<void>((resolve) => {
      this.markStreamReady = resolve;
    });
  }

  async start(): Promise<void> {
    const to = this.opts.lead.phone;
    assertTestNumber(to);

    const streamUrl = `${env.publicBaseUrl.replace(/^https/, "wss")}/media/${this.opts.callId}`;
    log.call(this.id, `TEST RUN - dialling ${to} for lead ${this.opts.lead.id}`);

    const call = await this.api().calls.create({
      to,
      from: env.twilioFrom,
      twiml:
        `<Response><Connect><Stream url="${streamUrl}">` +
        `<Parameter name="callId" value="${this.opts.callId}"/>` +
        `</Stream></Connect></Response>`,
      machineDetection: "Enable",
      asyncAmd: "true",
      asyncAmdStatusCallback: `${env.publicBaseUrl}/twilio/amd/${this.opts.callId}`,
      statusCallback: `${env.publicBaseUrl}/twilio/status/${this.opts.callId}`,
      statusCallbackEvent: ["answered", "completed"],
      record: true,
      recordingStatusCallback: `${env.publicBaseUrl}/twilio/recording/${this.opts.callId}`,
      timeout: 25,
    });
    this.twilioCallSid = call.sid;

    const ws = await new Promise<WebSocket>((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(this.opts.callId);
        reject(new Error("media stream never connected (no answer)"));
      }, 35_000);
      waiting.set(this.opts.callId, (socket) => {
        clearTimeout(timer);
        resolve(socket);
      });
    });

    this.ws = ws;
    await this.bindSocket(ws);
    await this.openStt();

    // Do not report the line as ready until Twilio has told us the streamSid.
    // Without this the opener is synthesised, dropped, and the customer hears
    // silence - on the one line that has to carry the recording disclosure.
    await Promise.race([
      this.streamReady,
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error("Twilio never sent the stream start event")), 15_000)
      ),
    ]);

    log.call(this.id, `media stream live - streamSid ${this.streamSid}`);
  }

  private api(): TwilioClient {
    return this.opts.client ?? client();
  }

  private async bindSocket(ws: WebSocket): Promise<void> {
    ws.on("message", (data) => {
      let msg: {
        event: string;
        streamSid?: string;
        media?: { payload: string };
        mark?: { name: string };
      };
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }

      switch (msg.event) {
        case "connected":
          log.call(this.id, "twilio websocket connected");
          break;
        case "start":
          this.streamSid = msg.streamSid ?? null;
          log.call(this.id, `stream start - sid ${this.streamSid}`);
          if (this.streamSid) this.markStreamReady();
          break;
        case "media": {
          // Straight through. No decode, no resample.
          if (msg.media?.payload) this.stt?.push(msg.media.payload);
          const now = Date.now();
          const stall = this.lastMediaAt ? now - this.lastMediaAt : 0;
          if (stall > 250) {
            this.inboundStalls++;
            this.longestStallMs = Math.max(this.longestStallMs, stall);
            log.call(this.id, `inbound audio stalled for ${stall}ms`);
          }
          this.lastMediaAt = now;
          break;
        }
        case "mark": {
          const name = msg.mark?.name;
          if (name) {
            this.markResolvers.get(name)?.();
            this.markResolvers.delete(name);
          }
          break;
        }
        case "stop":
          this.end("hangup");
          break;
      }
    });

    ws.on("close", () => this.end("hangup"));
    ws.on("error", (err) => {
      log.call(this.id, `media socket error: ${err.message}`);
      this.end("failed");
    });
  }

  private async openStt(): Promise<void> {
    // Injected by `pnpm transport:check`, which has no vendor socket to open and
    // needs to put a turn on the line by hand.
    const open = this.opts.openStt ?? openStt;
    this.stt = await open({
      label: `stt/${this.id.slice(0, 8)}`,
      keywords: recognitionKeywords(this.opts),
      events: {
        onSpeechStart: () => {
          // Might be the customer talking over us - or our own echo. Arm the
          // barge-in and let a transcript with actual words pull the trigger.
          if (this.speaking) this.bargeArmed = true;
        },
        onPartial: (text) => {
          this.partialCb?.(text);
          if (!this.speaking || !this.bargeArmed || !this.interruptible) return;
          if (!meaningfulSpeech(text) || this.isEcho(text)) return;
          this.bargeArmed = false;
          log.call(this.id, `barge-in confirmed by "${text.slice(0, 30)}"`);
          this.clearPlayback();
          this.bargeInCb?.();
        },
        onFinal: (text, confidence) => {
          // Our own line coming back at us is not the customer speaking.
          if (this.isEcho(text) && (this.speaking || Date.now() - this.playbackEndedAt < 1200)) {
            log.call(this.id, `dropped echo "${text.slice(0, 40)}"`);
            return;
          }
          // Finals can arrive without a partial ever firing; honour barge-in here too.
          if (this.speaking && this.interruptible && meaningfulSpeech(text)) {
            this.bargeArmed = false;
            this.clearPlayback();
            this.bargeInCb?.();
          }
          this.utteranceCb?.(text, confidence);
        },
        onError: (err) => log.call(this.id, `stt error: ${err.message}`),
        onClose: () => log.call(this.id, "stt socket closed"),
      },
    });
  }

  onUtterance(cb: (text: string, confidence: number | null) => void): void {
    this.utteranceCb = cb;
  }
  onPartial(cb: (text: string) => void): void {
    this.partialCb = cb;
  }
  onBargeIn(cb: () => void): void {
    this.bargeInCb = cb;
  }
  onEnded(cb: (reason: TransportEndReason) => void): void {
    this.endedCb = cb;
  }

  async speak(text: string, opts: { onFirstAudio?: () => void; interruptible?: boolean } = {}): Promise<void> {
    if (this.dead) return;
    this.interruptible = opts.interruptible ?? true;

    // Never drop a line because the stream was a beat late.
    if (!this.streamSid) await this.streamReady.catch(() => undefined);
    if (this.dead || !this.ws || !this.streamSid) {
      log.call(this.id, `WARN dropped "${text.slice(0, 40)}" - no stream to send it on`);
      return;
    }

    // Sentence-level pipeline: every sentence is synthesised concurrently, and the
    // first one goes on the wire the moment it lands. Time-to-first-audio is one
    // short TTS call, not the whole reply.
    const parts = splitForTts(text);
    const jobs = parts.map((p) =>
      synthesize({ text: p }).catch((err) => {
        log.call(this.id, `TTS failed: ${err instanceof Error ? err.message : err}`);
        return Buffer.alloc(0);
      })
    );

    this.bargeArmed = false;
    this.lastSpokenTokens = tokenize(text);

    // `speaking` flips on with the first frame, not before: a customer utterance
    // that lands while we are still synthesising is a queued turn, not a barge-in.
    let started = false;
    let totalBytes = 0;
    let frames = 0;
    for (const job of jobs) {
      const audio = await job;
      if (this.dead || !this.ws || !this.streamSid) break;
      // Barge-in mid-reply: they are talking, stop feeding sentences at them.
      if (started && !this.speaking) break;
      if (!audio.length) continue;
      if (!started) {
        this.speaking = true;
        started = true;
        opts.onFirstAudio?.();
      }

      for (let off = 0; off < audio.length; off += FRAME_BYTES) {
        const frame = audio.subarray(off, Math.min(off + FRAME_BYTES, audio.length));
        this.ws.send(
          JSON.stringify({
            event: "media",
            streamSid: this.streamSid,
            media: { payload: frame.toString("base64") },
          })
        );
        frames++;
      }
      totalBytes += audio.length;
    }

    if (!totalBytes || this.dead || !this.ws || !this.streamSid || !this.speaking) {
      if (!totalBytes) log.call(this.id, "WARN TTS returned zero bytes");
      this.speaking = false;
      this.playbackEndedAt = Date.now();
      return;
    }

    const markName = `m${Date.now()}${Math.floor(Math.random() * 1000)}`;
    this.ws.send(JSON.stringify({ event: "mark", streamSid: this.streamSid, mark: { name: markName } }));

    log.call(this.id, `spoke ${frames} frames (${(frames * 20) / 1000}s) "${text.slice(0, 40)}"`);

    await new Promise<void>((resolve) => {
      // Resolve on the mark, on barge-in clearing us, or on a hard ceiling so a
      // dropped mark can never wedge the call.
      const ceiling = setTimeout(() => {
        this.markResolvers.delete(markName);
        resolve();
      }, Math.max(4000, (totalBytes / 8000) * 1000 + 2500));

      this.markResolvers.set(markName, () => {
        clearTimeout(ceiling);
        resolve();
      });
    });

    this.speaking = false;
    this.playbackEndedAt = Date.now();
  }

  /**
   * Streams a reply that is still being generated.
   *
   * Each sentence is synthesised and framed the moment it lands, so the customer
   * hears the first clause while the model is still writing the second. Barge-in
   * aborts the signal and the loop stops feeding sentences at someone who has
   * already started talking.
   */
  async speakStream(sentences: AsyncIterable<string>, signal?: AbortSignal): Promise<string> {
    if (this.dead) return "";
    if (!this.streamSid) await this.streamReady.catch(() => undefined);
    if (this.dead || !this.ws || !this.streamSid) return "";

    let spoken = "";
    let started = false;
    this.interruptible = true;

    for await (const sentence of sentences) {
      if (signal?.aborted || this.dead || !this.ws || !this.streamSid) break;
      if (started && !this.speaking) break; // they talked over us

      const audio = await synthesize({ text: sentence, signal }).catch((err) => {
        log.call(this.id, `TTS failed: ${err instanceof Error ? err.message : err}`);
        return Buffer.alloc(0);
      });
      if (!audio.length || signal?.aborted) continue;

      if (!started) {
        this.speaking = true;
        started = true;
        this.bargeArmed = false;
      }
      spoken += `${sentence} `;
      this.lastSpokenTokens = tokenize(spoken);
      this.sendFrames(audio);
    }

    if (started) {
      await this.awaitPlayback();
    }
    return spoken.trim();
  }

  /** Splits one buffer into 20 ms frames and puts them on the wire. */
  private sendFrames(audio: Buffer): number {
    if (!this.ws || !this.streamSid) return 0;
    let frames = 0;
    for (let off = 0; off < audio.length; off += FRAME_BYTES) {
      const frame = audio.subarray(off, Math.min(off + FRAME_BYTES, audio.length));
      this.ws.send(
        JSON.stringify({
          event: "media",
          streamSid: this.streamSid,
          media: { payload: frame.toString("base64") },
        })
      );
      frames++;
    }
    this.framesSent += frames;
    return frames;
  }

  /** Waits for Twilio's mark, for barge-in to clear us, or for a hard ceiling. */
  private async awaitPlayback(): Promise<void> {
    if (!this.ws || !this.streamSid) return;
    const markName = `m${Date.now()}${Math.floor(Math.random() * 1000)}`;
    this.ws.send(JSON.stringify({ event: "mark", streamSid: this.streamSid, mark: { name: markName } }));

    await new Promise<void>((resolve) => {
      // A dropped mark must never wedge the call.
      const ceiling = setTimeout(() => {
        this.markResolvers.delete(markName);
        resolve();
      }, 20_000);
      this.markResolvers.set(markName, () => {
        clearTimeout(ceiling);
        resolve();
      });
    });

    this.speaking = false;
    this.playbackEndedAt = Date.now();
  }

  /**
   * Warm handoff.
   *
   * The customer stays on the line and the human is dialled into it, with a whisper
   * naming the lead and the reason so they are oriented before they speak. The
   * fallback if this misbehaves on the venue network is to hang up after the
   * bridging line and let the human console show "call back now" - rehearse both.
   */
  async transfer(toNumber: string, whisper: string): Promise<void> {
    if (!this.twilioCallSid) throw new Error("no live Twilio call to transfer");
    assertHandoffNumber(toNumber, this.opts.lead.phone);

    this.clearPlayback();
    // The whisper is played to the human only: Twilio fetches the <Number url>
    // when they answer, and that TwiML never reaches the customer's leg.
    await this.api()
      .calls(this.twilioCallSid)
      .update({
        twiml: `<Response><Dial answerOnBridge="true"><Number url="${env.publicBaseUrl}/twilio/whisper?text=${encodeURIComponent(whisper)}">${toNumber}</Number></Dial></Response>`,
      });

    log.call(this.id, `transferred to ${toNumber} - whisper: ${whisper}`);
    this.transferred = true;
    this.end("transferred");
  }

  /** True when the transcript is mostly our own last line leaking back at us. */
  private isEcho(text: string): boolean {
    if (!this.lastSpokenTokens.size) return false;
    const theirs = [...tokenize(text)];
    if (!theirs.length) return false;
    const overlap = theirs.filter((t) => this.lastSpokenTokens.has(t)).length;
    return overlap / theirs.length >= 0.7;
  }

  private clearPlayback(): void {
    if (!this.ws || !this.streamSid) return;
    this.ws.send(JSON.stringify({ event: "clear", streamSid: this.streamSid }));
    // Anything still waiting on a mark will never get one now.
    for (const [name, resolve] of this.markResolvers) {
      this.markResolvers.delete(name);
      resolve();
    }
    this.speaking = false;
    this.bargeArmed = false;
    this.playbackEndedAt = Date.now();
  }

  /**
   * Twilio's async answering-machine verdict. Recorded, never acted on.
   *
   * It used to end the call, and on the third journey call it ended two of them.
   * Twilio posted `machine_start` six seconds after answer - while the opener
   * was still playing to a live human who had already been transcribed - and
   * the hangup followed one second later. From the customer's side the agent
   * greeted them by name, heard them answer, and cut the line.
   *
   * The verdict cannot be trusted here, because this agent talks. Detection
   * runs on the called leg for up to `machine_detection_timeout` while our own
   * opener is playing into it, and anything continuous past Twilio's 2400 ms
   * speech threshold reads as a machine greeting - the customer talking over a
   * long opener, or that opener leaking back off their handset. Both real
   * verdicts landed at 5.4-6.2 s of detection, mid-conversation.
   *
   * So AMD stops being a control and becomes a note on the record. A machine
   * that talks at us and a customer who does are told apart by the thing that
   * already tells them apart: nobody answers the consent question, the two
   * silence nudges go unanswered, and the abandon timer closes the call. That
   * costs about twenty seconds against a voicemail. Cutting off a live
   * customer mid-sentence costs the call.
   */
  notifyAmd(answeredBy: string): void {
    this.amdVerdict = answeredBy || null;
    log.call(
      this.id,
      answeredBy.startsWith("machine")
        ? `AMD: ${answeredBy} - advisory only, the call continues`
        : `AMD: ${answeredBy || "no verdict"}`
    );
  }

  notifyStatus(status: string): void {
    if (status === "no-answer" || status === "busy" || status === "canceled") this.end("no_answer");
    else if (status === "failed") this.end("failed");
    else if (status === "completed") this.end("completed");
  }

  notifyRecording(url: string): void {
    this.recordingUrl = url;
  }

  async hangup(): Promise<void> {
    // A transferred call belongs to the human now. The engine finalises after a
    // transfer and lands here; completing the call at that point tears the Dial
    // down before it has rung anyone.
    if (this.transferred) return;
    if (this.twilioCallSid) {
      try {
        await this.api().calls(this.twilioCallSid).update({ status: "completed" });
      } catch {
        /* already ended */
      }
    }
    this.end("hangup");
  }

  private end(reason: TransportEndReason): void {
    if (this.dead) return;
    this.dead = true;
    this.stt?.close();
    try {
      this.ws?.close();
    } catch {
      /* already closed */
    }
    log.call(
      this.id,
      this.inboundStalls
        ? `inbound audio: ${this.inboundStalls} stall(s) over 250ms, longest ${this.longestStallMs}ms`
        : "inbound audio: no stalls over 250ms"
    );
    liveTwilioTransports.delete(this.id);
    this.endedCb?.(reason);
  }
}

/** Words that matter for echo comparison: lowercase, no punctuation, no one-letter noise. */
function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((t) => t.length > 1)
  );
}

/** Enough words to be a person talking, rather than a cough or a car horn. */
function meaningfulSpeech(text: string): boolean {
  return tokenize(text).size >= 2 || text.trim().length >= 8;
}

/**
 * Split a reply at sentence boundaries for pipelined TTS. Numbers like "2,150"
 * must never be split, so only a boundary followed by whitespace counts.
 */
export function splitForTts(text: string): string[] {
  const parts = text
    .split(/(?<=[.?!])\s+/)
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.length ? parts : [text.trim()];
}

/** Scribe rejects the whole connection if any keyterm exceeds this. */
const MAX_KEYTERM_CHARS = 20;

/**
 * Bias recognition toward the words this call will actually contain.
 *
 * Only things a person says out loud. Emails, phone numbers, dates and plan ids
 * are values, not vocabulary - they are spelled or read digit by digit, so they
 * help recognition not at all, and one of them cost a live call: an email in the
 * prefill became a 24-character keyterm and Scribe rejected the entire socket
 * with `invalid_request`, which surfaced as the agent greeting the customer and
 * then never hearing a word.
 *
 * Over-length terms are dropped rather than truncated. A truncated keyterm is a
 * word the model is being told to expect and will never hear.
 */
export function recognitionKeywords(deps: TransportDeps): string[] {
  const spoken = [
    deps.lead.full_name,
    deps.lead.plan_name ?? "",
    // Prefilled text the customer might repeat: a suburb, a street name. Values
    // that are read out character by character are excluded below.
    ...Object.entries(deps.lead.prefill)
      .filter(([id]) => !["email", "phone", "dob", "postcode", "nmi", "plan_id"].includes(id))
      .map(([, value]) => (typeof value === "string" ? value : "")),
    // Enum options are answers people say: "electricity", "both", "pension".
    ...deps.journey.fields.flatMap((f) => f.options ?? []),
  ];

  const words = spoken
    .flatMap((s) => s.split(/[\s_]+/))
    .map((w) => w.replace(/[^\p{L}\p{N}'-]/gu, "").trim())
    .filter((w) => w.length > 2 && w.length <= MAX_KEYTERM_CHARS)
    // A bare number is never a useful hint; it is dictated, not recognised.
    .filter((w) => !/^\d+$/.test(w));

  return [...new Set(words)].slice(0, 50);
}

export function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) =>
    c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === "&" ? "&amp;" : c === "'" ? "&apos;" : "&quot;"
  );
}

/** Live transports, so webhooks can reach the right one. */
export const liveTwilioTransports = new Map<string, TwilioTransport>();

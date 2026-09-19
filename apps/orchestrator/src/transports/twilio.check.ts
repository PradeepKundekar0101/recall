import { EventEmitter } from "node:events";
import type { WebSocket } from "ws";
import type { SttEvents, SttOpener } from "../voice/stt/types.js";

/**
 * `pnpm transport:check` - the Twilio transport against a fake Twilio and a
 * fake media stream, so the dial, the stream handshake, the warm transfer and
 * the hangup can be exercised without a phone.
 *
 * Written after the second real journey call, which ended the moment the
 * handoff fired: the handoff number was not on the TEST_NUMBERS allowlist, so
 * guardrail 1 refused the transfer and the fallback hung up - and had the
 * transfer gone through, the transport would then have completed the call
 * itself, because the engine's finalise() calls hangup() after transfer().
 */
process.env.MOCK_VOICE = "1";
// Belt and braces: even if the injected client were ever bypassed, these
// credentials cannot place a call.
process.env.TWILIO_ACCOUNT_SID = "ACfake00000000000000000000000000000";
process.env.TWILIO_AUTH_TOKEN = "fake";

const { TwilioTransport, attachMediaStream, assertHandoffNumber } = await import("./twilio.js");
const { loadJourney } = await import("../journey/index.js");
const { loadLeads } = await import("../leads/index.js");
const { env } = await import("../env.js");
const { log } = await import("../log.js");

log.info = () => {};
log.call = () => {};
log.warn = () => {};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? `\n      ${detail}` : ""}`);
}

/**
 * A media stream that plays audio at the speed audio plays.
 *
 * This used to acknowledge every mark after one fixed delay, which is the one
 * thing Twilio does not do - and the whole echo defence now rests on what a
 * returning mark means. Twilio holds a mark until the audio queued in front of
 * it has played out, so a mark is a statement about the customer's ears rather
 * than about the socket. A fake that acknowledges on a timer would let a bug
 * that reports a three-sentence reply as fully heard the instant it is written
 * pass every check in this file.
 *
 * So the playhead is modelled: 20 ms per frame written, marks acknowledged when
 * the playhead reaches them, and a `clear` throws away everything still queued
 * without acknowledging it - which is exactly what makes `playedText` truncate.
 */
class FakeMediaStream extends EventEmitter {
  readonly sent: string[] = [];
  readyState = 1;
  /** When the audio written so far will have finished playing. */
  private playheadAt = 0;
  private pending = new Set<NodeJS.Timeout>();

  send(data: string): void {
    this.sent.push(String(data));
    const msg = JSON.parse(String(data)) as { event: string; mark?: { name: string } };
    const now = Date.now();

    if (msg.event === "media") {
      // One 20 ms frame, queued behind whatever is already playing.
      this.playheadAt = Math.max(this.playheadAt, now) + 20;
      return;
    }

    if (msg.event === "clear") {
      // Twilio drops the buffer. Nothing still queued is ever acknowledged,
      // because none of it was heard.
      for (const timer of this.pending) clearTimeout(timer);
      this.pending.clear();
      this.playheadAt = 0;
      return;
    }

    if (msg.event === "mark" && msg.mark) {
      const { name } = msg.mark;
      const timer = setTimeout(
        () => {
          this.pending.delete(timer);
          this.emit("message", JSON.stringify({ event: "mark", mark: { name } }));
        },
        Math.max(0, this.playheadAt - now)
      );
      this.pending.add(timer);
    }
  }

  /** Outbound audio frames, which is what "the customer can still hear us" means. */
  get mediaFrames(): number {
    return this.sent.filter((s) => s.includes('"event":"media"')).length;
  }
  /** Whether playback was ever cut - the barge-in's `clear`. */
  get cleared(): boolean {
    return this.sent.some((s) => s.includes('"event":"clear"'));
  }
  close(): void {
    this.emit("close");
  }
}

/**
 * A transcriber the check drives by hand, so a turn can be put on the line
 * without a phone, a socket or a vendor.
 */
function fakeStt() {
  let events: SttEvents = {};
  const open: SttOpener = async (opts) => {
    events = opts.events;
    return { push: () => {}, flush: () => {}, close: () => {}, ready: true };
  };
  return {
    open,
    /** The customer starts talking. */
    start: () => events.onSpeechStart?.(),
    /** An interim transcript, which on a real line grows word by word. */
    partial: (text: string) => events.onPartial?.(text),
    /** The customer says something, and it commits. */
    say: (text: string, confidence = 0.9) => events.onFinal?.(text, confidence),
  };
}

type Update = { sid: string; twiml?: string; status?: string };

function fakeTwilio() {
  const updates: Update[] = [];
  let created: { twiml?: string; to?: string } | null = null;
  /** Lets a scenario make an update do to the call what the real Twilio would. */
  const hooks: { onUpdate?: (update: Update) => void } = {};
  const calls = Object.assign(
    (sid: string) => ({
      update: async (params: Omit<Update, "sid">) => {
        const update = { sid, ...params };
        updates.push(update);
        hooks.onUpdate?.(update);
        return {};
      },
    }),
    {
      create: async (params: { twiml?: string; to?: string }) => {
        created = params;
        return { sid: "CA_fake" };
      },
    }
  );
  return {
    client: { calls } as unknown as ConstructorParameters<typeof TwilioTransport>[0]["client"],
    updates,
    created: () => created,
    hooks,
  };
}

const journey = loadJourney();
const lead = loadLeads()[0]!;

/** Dials, attaches a fake media stream, and waits for the transport to be live. */
async function connect(callId: string, openStt?: SttOpener) {
  const twilio = fakeTwilio();
  const transport = new TwilioTransport({ journey, lead, callId, client: twilio.client, openStt });
  const started = transport.start();
  await sleep(20);
  const stream = new FakeMediaStream();
  const attached = attachMediaStream(callId, stream as unknown as WebSocket);
  await sleep(20);
  stream.emit("message", JSON.stringify({ event: "start", streamSid: "MZ_fake" }));
  await started;
  return { transport, twilio, stream, attached };
}

console.log("\n-- guardrail 1 on the transfer leg");
check("a second handset is configured", Boolean(env.handoffNumber) && env.handoffNumber !== lead.phone, `HANDOFF_NUMBER=${env.handoffNumber} customer=${lead.phone}`);
check("the configured handoff handset is allowed", (() => { try { assertHandoffNumber(env.handoffNumber, lead.phone); return true; } catch { return false; } })());
check("the phone already on the call is refused", (() => { try { assertHandoffNumber(lead.phone, lead.phone); return false; } catch { return true; } })());
check("a number that is nobody's is refused", (() => { try { assertHandoffNumber("+61400000000", lead.phone); return false; } catch { return true; } })());

console.log("\n-- dial and stream handshake");
{
  const { transport, twilio, attached } = await connect("check-dial");
  check("the media stream attaches to the waiting transport", attached);
  check("the call is placed with a Connect/Stream TwiML", /<Connect><Stream url="wss:/.test(String(twilio.created()?.twiml)));
  const before = twilio.updates.length;
  await transport.hangup();
  check("hangup on a live call completes it", twilio.updates.slice(before).some((u) => u.status === "completed"));
}

console.log("\n-- warm transfer");
{
  const { transport, twilio } = await connect("check-transfer");
  let ended: string | null = null;
  transport.onEnded((reason) => {
    ended = reason;
  });
  await transport.transfer(env.handoffNumber, "Recovery call, Priya, escalated for CONFUSION.");
  check("the live call is redirected to a Dial with a whisper", twilio.updates.some((u) => /<Dial [^>]*answerOnBridge="true"[^>]*><Number url=/.test(String(u.twiml))));
  // The seventh journey call: the human did not pick up, the <Dial> was the last
  // verb in the document, and Twilio hung the customer up in silence one second
  // after they were told a colleague was coming. An action URL is where a
  // transfer that found nobody gets to say so.
  check(
    "the Dial has somewhere to go when nobody answers",
    twilio.updates.some((u) => /<Dial [^>]*action="[^"]*\/twilio\/handoff-result\/check-transfer"/.test(String(u.twiml))),
    String(twilio.updates.at(-1)?.twiml)
  );
  check("the transport ends as transferred", ended === "transferred", String(ended));

  const before = twilio.updates.length;
  await transport.hangup();
  check("hangup after a transfer leaves the call alone", !twilio.updates.slice(before).some((u) => u.status === "completed"), JSON.stringify(twilio.updates.slice(before)));
}

console.log("\n-- the redirect tears the media stream down, and that is not a hangup");
{
  // The fifth journey call, bd82d644, 19 Sep 05:58 UTC. Twilio's own log has
  // the whole thing: the <Dial> redirect at 05:58:51, our own status=completed
  // on the customer's leg at 05:58:52, and the handoff handset's leg dead at
  // no-answer after 0 seconds. The customer heard the bridging line and then
  // nothing.
  //
  // Redirecting a call ends the <Connect><Stream> it was running, so Twilio
  // tears the media stream down *while the update is still in flight* - before
  // transfer() had marked the call as handed over. The close came back as
  // `hangup`, the engine finalised it as `disconnected`, and finalise() called
  // hangup(), which completed the very call that was ringing the human. The
  // recorded outcome was `disconnected`, not `handoff`, which is what proves
  // the ordering.
  const { transport, twilio, stream } = await connect("check-transfer-teardown");
  let ended: string | null = null;
  transport.onEnded((reason) => {
    ended = reason;
    // What the engine does with it: onTransportEnded -> finalise -> hangup.
    void transport.hangup();
  });
  twilio.hooks.onUpdate = (update) => {
    if (update.twiml) stream.close();
  };

  await transport.transfer(env.handoffNumber, "Recovery call, Priya, escalated for CONFUSION.");
  await sleep(20);

  check("the teardown that follows a redirect ends the call as transferred", ended === "transferred", String(ended));
  check(
    "the customer's leg is never completed by us",
    !twilio.updates.some((u) => u.status === "completed"),
    JSON.stringify(twilio.updates)
  );
}

console.log("\n-- answering-machine detection is advisory");
{
  // The third journey call: Twilio's async AMD returned machine_start six
  // seconds after answer, while the opener was still playing to a live human,
  // and the webhook hung the call up one second later. Twice in one session.
  const stt = fakeStt();
  const { transport, twilio, stream } = await connect("check-amd", stt.open);
  let ended: string | null = null;
  transport.onEnded((reason) => {
    ended = reason;
  });

  await transport.speak("Hi, is this Priya?");
  stt.say("Yeah, speaking.");
  await sleep(10);

  const before = twilio.updates.length;
  const framesBefore = stream.mediaFrames;
  transport.notifyAmd("machine_start");
  await sleep(20);

  check("a machine verdict does not end a call in progress", ended === null, String(ended));
  check(
    "a machine verdict does not complete the call at Twilio",
    !twilio.updates.slice(before).some((u) => u.status === "completed"),
    JSON.stringify(twilio.updates.slice(before))
  );
  check("the verdict is recorded for the outcome", transport.amdVerdict === "machine_start", String(transport.amdVerdict));

  await transport.speak("Is now a good time?");
  check("the agent can still be heard after the verdict", stream.mediaFrames > framesBefore);
}

{
  // The same verdict before anyone has said a word. A machine that has been
  // talking for six seconds and a customer holding the handset in silence are
  // indistinguishable from here, so this one does not end the call either -
  // the silence nudges and the abandon timer close a voicemail.
  const stt = fakeStt();
  const { transport, twilio } = await connect("check-amd-silent", stt.open);
  let ended: string | null = null;
  transport.onEnded((reason) => {
    ended = reason;
  });
  transport.notifyAmd("machine_start");
  await sleep(20);
  check("a machine verdict on a silent line does not end the call either", ended === null, String(ended));
  check(
    "nothing is completed at Twilio",
    !twilio.updates.some((u) => u.status === "completed"),
    JSON.stringify(twilio.updates)
  );
}

console.log("\n-- talking over the agent");
{
  // Two words are a customer agreeing, not taking the turn. Cutting a read-back
  // off on "yeah okay" is a large part of what made real calls sound broken.
  const stt = fakeStt();
  const { transport, stream } = await connect("check-backchannel", stt.open);
  const heard: { text: string; startedAt: number | null }[] = [];
  transport.onUtterance((text, _confidence, meta) => heard.push({ text, startedAt: meta?.startedAt ?? null }));

  const line = "I have Priya Sharma. Is that right?";
  const playing = transport.speak(line);
  await sleep(20);
  stt.start();
  stt.partial("yeah");
  stt.partial("yeah okay");
  await sleep(5);
  check("a two-word backchannel does not clear playback", !stream.cleared);
  stt.say("yeah okay");
  const result = await playing;
  check("the line plays to the end", result.completed === true && result.heard === line, JSON.stringify(result));
  check("the backchannel still reaches the engine", heard.length === 1 && heard[0]?.text === "yeah okay", JSON.stringify(heard));
}

{
  const stt = fakeStt();
  const { transport, stream } = await connect("check-turn-taker", stt.open);
  const playing = transport.speak("I have Priya Sharma. Is that right?");
  await sleep(20);
  stt.start();
  stt.partial("wait");
  await sleep(5);
  check("a turn-taking word stops playback on its own", stream.cleared);
  const result = await playing;
  check("the line reports it was cut", result.completed === false, JSON.stringify(result));
}

{
  const stt = fakeStt();
  const { transport, stream } = await connect("check-sustained", stt.open);
  const playing = transport.speak("First sentence here. Second sentence follows it.");
  // Mock audio is 0.4 s a sentence: the first has played out, the second is playing.
  await sleep(450);
  stt.start();
  stt.partial("hang on my dog is barking");
  const result = await playing;
  check("a sustained utterance stops playback", stream.cleared && result.completed === false, JSON.stringify(result));
  check("what was heard is the sentence that had finished", result.heard === "First sentence here.", JSON.stringify(result.heard));
}

{
  const stt = fakeStt();
  const { transport } = await connect("check-started-at", stt.open);
  let meta: { startedAt: number | null } | undefined;
  transport.onUtterance((_text, _confidence, m) => {
    meta = m;
  });
  const t0 = Date.now();
  stt.start();
  stt.partial("my name");
  await sleep(40);
  stt.say("my name is Priya");
  check(
    "the final carries when the customer started talking, not when it committed",
    meta?.startedAt !== undefined && meta.startedAt !== null && meta.startedAt >= t0 - 2 && meta.startedAt < t0 + 25,
    `startedAt=${meta?.startedAt} t0=${t0}`
  );
}

console.log("\n-- two lines handed over at once");
{
  // The engine's filler is fire-and-forget, so a reply can arrive here while
  // "Okay." is still playing. Both used to go on the wire together, and the
  // first line's mark then cleared `speaking` while the second was still
  // playing - which switched barge-in off for the rest of it.
  const stt = fakeStt();
  const { transport, stream } = await connect("check-two-lines", stt.open);
  const first = transport.speak("First line.");
  const second = transport.speak("Second line.");
  await sleep(20);
  check("the second line waits for the first to play out", stream.mediaFrames === 20, `${stream.mediaFrames} frames already sent`);

  const [a, b] = await Promise.all([first, second]);
  check("both lines report they were heard whole", a.completed && b.completed, JSON.stringify([a, b]));
  check("both lines reached the wire", stream.mediaFrames === 40, `${stream.mediaFrames} frames`);
}

{
  const stt = fakeStt();
  const { transport, stream } = await connect("check-two-lines-barge", stt.open);
  void transport.speak("First line.");
  const second = transport.speak("Second line.");
  // Long enough that the first line has played out and the second is playing.
  // Mock audio is 0.4 s a line and the fake stream now plays it in 0.4 s, so
  // the first line's mark does not come back - and the second does not start -
  // until 400 ms in.
  await sleep(450);
  stt.start();
  stt.partial("hang on stop there");
  const b = await second;
  check(
    "the line that is actually playing owns the barge-in",
    stream.cleared && b.completed === false,
    `cleared=${stream.cleared} ${JSON.stringify(b)}`
  );
}

console.log("\n-- what the customer has actually heard");
{
  // The premise of the whole echo defence. Frames go into Twilio's buffer far
  // faster than they play, so a transport that reports "spoken" when it has
  // finished writing is describing its own socket, not the customer's ears -
  // and every gate built on "is our voice in the room" would then be reading a
  // number that is seconds early.
  const stt = fakeStt();
  const { transport, stream } = await connect("check-playout", stt.open);

  check("nothing has played before a line starts", transport.playout().playedText === "", transport.playout().playedText);

  const line = "First sentence here. Second sentence follows it.";
  const playing = transport.speak(line);

  await sleep(30);
  const early = transport.playout();
  check(
    "both sentences are written long before either is heard",
    stream.mediaFrames === 40 && early.playedText === "" && early.ttsPlaying,
    `${stream.mediaFrames} frames written, played "${early.playedText}"`
  );

  await sleep(420);
  const midway = transport.playout();
  check(
    "the first sentence counts as heard when its mark comes back",
    midway.playedText === "First sentence here." && midway.ttsPlaying,
    `played "${midway.playedText}" ttsPlaying=${midway.ttsPlaying}`
  );

  const result = await playing;
  const after = transport.playout();
  check(
    "the whole line counts as heard once the last mark lands",
    result.completed && after.playedText === line,
    `${JSON.stringify(result)} played "${after.playedText}"`
  );
  check(
    "playback is reported as over, and when",
    !after.ttsPlaying && after.ttsEndedAt > 0 && Date.now() - after.ttsEndedAt < 200,
    `ttsPlaying=${after.ttsPlaying} endedAt=${after.ttsEndedAt}`
  );
}

{
  // Barge-in truncates what was heard to the last acknowledged mark. The
  // sentences still sitting in Twilio's buffer are thrown away by the `clear`,
  // so they were never in the customer's room and must not be compared against
  // the next thing the microphone picks up.
  const stt = fakeStt();
  const { transport, stream } = await connect("check-playout-truncate", stt.open);
  const playing = transport.speak("First sentence here. Second sentence follows it.");

  await sleep(430);
  stt.start();
  stt.partial("hang on my dog is barking");

  const result = await playing;
  check(
    "a cut line reports only the sentence whose mark came back",
    result.completed === false && result.heard === "First sentence here.",
    JSON.stringify(result)
  );
  check(
    "played text is truncated to the last acknowledged mark",
    transport.playout().playedText === "First sentence here." && stream.cleared,
    `played "${transport.playout().playedText}" cleared=${stream.cleared}`
  );
  check(
    "playback is reported as over the instant it is cleared",
    !transport.playout().ttsPlaying,
    `ttsPlaying=${transport.playout().ttsPlaying}`
  );
}

{
  // The engine's own half-duplex gate reaches the wire through this, when it
  // decides a transcript is a barge-in that the transport let past.
  const stt = fakeStt();
  const { transport, stream } = await connect("check-stop-playback", stt.open);
  const playing = transport.speak("First sentence here. Second sentence follows it.");
  await sleep(430);
  transport.stopPlayback();
  const result = await playing;
  check(
    "stopPlayback cuts the line the way barge-in does",
    stream.cleared && result.completed === false && result.heard === "First sentence here.",
    JSON.stringify(result)
  );
}

console.log("\n-- the local monitor");
{
  // Every frame written to Twilio is published for the console, tagged with
  // the call it belongs to. Agent audio only: the inbound track never passes
  // through sendFrames, which is the single place this is tapped.
  const { publishAgentAudio, attachMonitor, parseFrame, monitorListenerCount } = await import("../monitor.js");
  void publishAgentAudio;

  const received: { callId: string; bytes: number }[] = [];
  let hello: string | null = null;
  const socket = Object.assign(new EventEmitter(), {
    readyState: 1,
    send: (data: unknown) => {
      if (typeof data === "string") {
        hello = data;
        return;
      }
      const frame = parseFrame(data as Buffer);
      if (frame) received.push({ callId: frame.callId, bytes: frame.ulaw.length });
    },
  });

  attachMonitor(socket as unknown as WebSocket, "check-monitor");
  check("the monitor says hello before any audio", String(hello).includes("monitor.hello"), String(hello));

  const stt = fakeStt();
  const { transport } = await connect("check-monitor", stt.open);
  await transport.speak("Hello there.");

  check("the agent's audio reaches the monitor", received.length > 0, `${received.length} frame(s)`);
  check(
    "every frame is tagged with the call it came from",
    received.every((f) => f.callId === "check-monitor"),
    JSON.stringify(received.slice(0, 2))
  );
  check(
    "the monitor carries the same 8 kHz ulaw that went to Twilio",
    received.reduce((sum, f) => sum + f.bytes, 0) === 3200,
    `${received.reduce((sum, f) => sum + f.bytes, 0)} bytes for 0.4s of mock audio`
  );

  // A monitor for a different call hears nothing from this one.
  const other: unknown[] = [];
  const otherSocket = Object.assign(new EventEmitter(), {
    readyState: 1,
    send: (data: unknown) => {
      if (typeof data !== "string") other.push(data);
    },
  });
  attachMonitor(otherSocket as unknown as WebSocket, "some-other-call");
  await transport.speak("And again.");
  check("a monitor bound to another call hears nothing", other.length === 0, `${other.length} frame(s)`);

  socket.emit("close");
  otherSocket.emit("close");
  check("closing a monitor detaches it", monitorListenerCount() === 0, `${monitorListenerCount()} still listening`);
}

console.log(failures ? `\n${failures} failure(s).` : "\nAll transport checks pass.");
process.exit(failures ? 1 : 0);

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

class FakeMediaStream extends EventEmitter {
  readonly sent: string[] = [];
  readyState = 1;
  send(data: string): void {
    this.sent.push(String(data));
    // Twilio acks a mark once the audio in front of it has played out. Without
    // that ack here, every speak() in this file would sit on its ceiling timer.
    const msg = JSON.parse(String(data)) as { event: string; mark?: { name: string } };
    if (msg.event === "mark" && msg.mark) {
      const { name } = msg.mark;
      setImmediate(() => this.emit("message", JSON.stringify({ event: "mark", mark: { name } })));
    }
  }

  /** Outbound audio frames, which is what "the customer can still hear us" means. */
  get mediaFrames(): number {
    return this.sent.filter((s) => s.includes('"event":"media"')).length;
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
    /** The customer says something, and it commits. */
    say: (text: string, confidence = 0.9) => events.onFinal?.(text, confidence),
  };
}

type Update = { sid: string; twiml?: string; status?: string };

function fakeTwilio() {
  const updates: Update[] = [];
  let created: { twiml?: string; to?: string } | null = null;
  const calls = Object.assign(
    (sid: string) => ({
      update: async (params: Omit<Update, "sid">) => {
        updates.push({ sid, ...params });
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
  return { client: { calls } as unknown as ConstructorParameters<typeof TwilioTransport>[0]["client"], updates, created: () => created };
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
  check("the live call is redirected to a Dial with a whisper", twilio.updates.some((u) => /<Dial answerOnBridge="true"><Number url=/.test(String(u.twiml))));
  check("the transport ends as transferred", ended === "transferred", String(ended));

  const before = twilio.updates.length;
  await transport.hangup();
  check("hangup after a transfer leaves the call alone", !twilio.updates.slice(before).some((u) => u.status === "completed"), JSON.stringify(twilio.updates.slice(before)));
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

console.log(failures ? `\n${failures} failure(s).` : "\nAll transport checks pass.");
process.exit(failures ? 1 : 0);

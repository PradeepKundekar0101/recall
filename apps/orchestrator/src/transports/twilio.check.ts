import { EventEmitter } from "node:events";
import type { WebSocket } from "ws";

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
  }
  close(): void {
    this.emit("close");
  }
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
async function connect(callId: string) {
  const twilio = fakeTwilio();
  const transport = new TwilioTransport({ journey, lead, callId, client: twilio.client });
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

console.log(failures ? `\n${failures} failure(s).` : "\nAll transport checks pass.");
process.exit(failures ? 1 : 0);

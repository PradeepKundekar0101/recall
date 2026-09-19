import type { Journey, Lead } from "@recall/shared";

/**
 * `pnpm setup:check` - what the operator sets up before dialling.
 *
 * The console lets the operator seed or remove any field before the call and
 * write a brief for how the agent should talk. Both arrive on POST /calls, and
 * both have to be folded in without touching the one thing guardrail 1 cares
 * about: the number that gets dialled. Milliseconds, no network.
 */
import { applySetup, parseSetup } from "./setup.js";
import { loadLeads } from "./index.js";
import { voiceSystemPrompt } from "../engine/voice-prompt.js";

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "  ok " : "FAIL "} ${name}${ok || !detail ? "" : ` - ${detail}`}`);
  if (!ok) failed += 1;
}

const journey = {
  id: "energy",
  vertical: "energy",
  version: "check",
  sections: [{ id: "supply", title: "Supply", intro: "" }],
  fields: [
    { id: "street", section: "supply", type: "text", label: "Street", required: true, capture: "natural", confirm: "read_back", script: { ask: "", reask: "" }, max_attempts: 2, sensitive: false },
    { id: "fuel_type", section: "supply", type: "enum", label: "Fuel", required: true, capture: "closed", confirm: "none", options: ["electricity", "gas", "both"], script: { ask: "", reask: "" }, max_attempts: 2, sensitive: false },
    { id: "concession", section: "supply", type: "bool", label: "Concession", required: true, capture: "closed", confirm: "none", script: { ask: "", reask: "" }, max_attempts: 2, sensitive: false },
    { id: "phone", section: "supply", type: "phone", label: "Phone", required: true, capture: "closed", confirm: "read_back", script: { ask: "", reask: "" }, max_attempts: 2, sensitive: false },
  ],
  scripts: { opener: "", consent_yes: "", review: "", close: "", decline: "", busy: "", handoff_bridge: "", no_advice: "", robot_disclosure: "" },
} as unknown as Journey;

const lead: Lead = {
  id: "L-1",
  first_name: "Priya",
  full_name: "Priya Sharma",
  phone: "+61400000001",
  last_completed_step: "contact",
  prefill: { street: "1 Old Street", phone: "+61400000001", fuel_type: "gas" },
  started_at: "on Tuesday",
};

// ---- parseSetup: what the console can send

{
  const r = parseSetup({ lead_id: "L-1" }, journey);
  check("a bare body parses to an empty setup", r.ok && Object.keys(r.setup.prefill).length === 0 && r.setup.agentBrief === null);
}
{
  const r = parseSetup({ prefill: { street: "42 Wattle Street", fuel_type: null, concession: true } }, journey);
  check(
    "seeds and removals parse by field",
    r.ok && r.setup.prefill.street === "42 Wattle Street" && r.setup.prefill.fuel_type === null && r.setup.prefill.concession === true
  );
}
{
  const r = parseSetup({ prefill: { street: "   " } }, journey);
  check("a blank seed is a removal", r.ok && r.setup.prefill.street === null);
}
{
  const r = parseSetup({ prefill: { card_number: "4111" } }, journey);
  check("a field the journey does not have is refused", !r.ok && /card_number/.test(r.ok ? "" : r.error));
}
{
  const r = parseSetup({ prefill: { fuel_type: "coal" } }, journey);
  check("an enum value outside its options is refused", !r.ok && /fuel_type/.test(r.ok ? "" : r.error));
}
{
  const r = parseSetup({ prefill: { concession: "yes" } }, journey);
  check("a yes/no field only takes a boolean", !r.ok);
}
{
  const r = parseSetup({ prefill: ["street"] }, journey);
  check("a prefill that is not an object is refused", !r.ok);
}
{
  const r = parseSetup({ agent_brief: "  Keep it warm and unhurried.  " }, journey);
  check("the brief is trimmed", r.ok && r.setup.agentBrief === "Keep it warm and unhurried.");
}
{
  const r = parseSetup({ agent_brief: "   " }, journey);
  check("a blank brief is no brief", r.ok && r.setup.agentBrief === null);
}
{
  const r = parseSetup({ agent_brief: "x".repeat(601) }, journey);
  check("a brief past 600 characters is refused", !r.ok);
}
{
  const r = parseSetup({ agent_brief: 42 }, journey);
  check("a brief that is not text is refused", !r.ok);
}

// ---- applySetup: the lead the engine sees

{
  const r = parseSetup({ prefill: { street: "42 Wattle Street", fuel_type: null, concession: false } }, journey);
  const applied = r.ok ? applySetup(lead, r.setup) : lead;
  check("a seed replaces the lead's own value", applied.prefill.street === "42 Wattle Street");
  check("a removal drops the key so the agent asks", !("fuel_type" in applied.prefill));
  check("a seeded closed field arrives as a boolean", applied.prefill.concession === false);
  check("untouched prefill survives", applied.prefill.phone === "+61400000001");
  check("the original lead is not mutated", lead.prefill.street === "1 Old Street" && "fuel_type" in lead.prefill);
}
{
  const r = parseSetup({ prefill: { phone: "+61499999999" } }, journey);
  const applied = r.ok ? applySetup(lead, r.setup) : lead;
  check("seeding the phone field never changes the number that is dialled", applied.phone === "+61400000001" && applied.prefill.phone === "+61499999999");
}

// ---- the fixtures the console picks from

{
  // The phone field's script is a confirmation ("is this number the best one to
  // reach you on?"), which needs the form to be holding a number. Two of the
  // three fixtures carried none, so on those leads the agent asked a question
  // no answer could satisfy and handed the call off for CONFUSION - call
  // bd82d644. The number is never in doubt: it is the one we are about to ring.
  const leads = loadLeads();
  check("there are leads to dial", leads.length > 0);
  check(
    "every lead carries the number we will dial as a seed",
    leads.every((l) => l.prefill.phone === l.phone && Boolean(l.phone)),
    leads.map((l) => `${l.id}: prefill=${String(l.prefill.phone)} dial=${l.phone}`).join(" | ")
  );
}

// ---- voiceSystemPrompt: where the brief goes

{
  const plain = voiceSystemPrompt(null);
  const briefed = voiceSystemPrompt("Keep it warm and unhurried.");
  check("without a brief the prompt is the plain one", !/brief/i.test(plain));
  check("the brief is in the prompt", briefed.includes("Keep it warm and unhurried."));
  check("the never-clauses still end the prompt", /never ask for information you were not given\.$/.test(briefed));
  check("the brief cannot change what is said", /never what/i.test(briefed));
}


// ---- the engine: a seeded field is announced before a word is spoken, and confirmed rather than asked
//
// MOCK_VOICE=1 keeps every vendor out; the walk to the seeded field is a run of
// yes/no confirmations, which is exactly what a seeded field is meant to be.
// env.ts snapshots the process environment at load, hence the dynamic imports.
process.env.MOCK_VOICE = "1";
process.env.SILENCE_NUDGE_MS = "400";
process.env.SILENCE_SECOND_NUDGE_MS = "800";
process.env.SILENCE_ABANDON_MS = "1200";
process.env.FILLER_AFTER_MS = "60000";
process.env.ANSWER_REACTION_MS = "0";
process.env.SANDBOX_URL = "http://127.0.0.1:9";

const { createEngine } = await import("../engine/dialogue.js");
const { loadJourney } = await import("../journey/index.js");
const { log } = await import("../log.js");
log.info = () => {};
log.call = () => {};
log.warn = () => {};

type Transport = import("../engine/transport.js").Transport;
type SpeakResult = import("../engine/transport.js").SpeakResult;
type TransportEndReason = import("../engine/transport.js").TransportEndReason;

/** A phone line with a customer who says yes to every read-back until the seeded field comes up. */
class Line implements Transport {
  readonly kind = "sim" as const;
  readonly id = "check-seed";
  readonly spoken: string[] = [];
  recordingUrl?: string;
  private utter: ((text: string, confidence: number | null) => void) | null = null;
  private ended: ((reason: TransportEndReason) => void) | null = null;
  constructor(private readonly stopAt: string) {}
  async start(): Promise<void> {}
  async speak(text: string, opts: { onFirstAudio?: () => void } = {}): Promise<SpeakResult> {
    opts.onFirstAudio?.();
    this.spoken.push(text);
    const reachedTarget = this.spoken.some((line) => line.includes(this.stopAt));
    if (!reachedTarget && /\?\s*$/.test(text)) setImmediate(() => this.utter?.("Yes.", 0.95));
    return { completed: true, heard: text };
  }
  async speakStream(sentences: AsyncIterable<string>): Promise<string> {
    let all = "";
    for await (const s of sentences) all += `${s} `;
    return all.trim();
  }
  onUtterance(cb: (text: string, confidence: number | null) => void): void {
    this.utter = cb;
  }
  onPartial(): void {}
  onBargeIn(): void {}
  onEnded(cb: (reason: TransportEndReason) => void): void {
    this.ended = cb;
  }
  async transfer(): Promise<void> {
    this.ended?.("transferred");
  }
  async hangup(): Promise<void> {
    this.ended?.("hangup");
  }
}

{
  const journey = loadJourney();
  const street = journey.fields.find((f) => f.id === "street");
  const base: Lead = {
    id: "L-check",
    first_name: "Priya",
    full_name: "Priya Sharma",
    phone: "+61400000001",
    email: "priya@example.com",
    last_completed_step: "contact",
    prefill: {
      full_name: "Priya Sharma",
      dob: "1989-03-07",
      account_holder: true,
      phone: "+61400000001",
      email: "priya@example.com",
      plan_id: "PLAN-EN-0331",
    },
    plan_id: "PLAN-EN-0331",
    plan_name: "econnex Saver 12",
    started_at: "on Tuesday",
  };
  const parsed = parseSetup({ prefill: { street: "42 Wattle Street" } }, journey);
  const seeded = parsed.ok ? applySetup(base, parsed.setup) : base;

  const line = new Line("42 Wattle Street");
  const announced: { field: string; state: string; spokenSoFar: number }[] = [];
  const noop = () => {};
  const engine = createEngine({
    callId: "check-seed",
    journey,
    lead: seeded,
    transport: line,
    hooks: {
      onAgentLine: noop,
      onCustomerLine: noop,
      onPartial: noop,
      onFieldChange: (field) =>
        announced.push({ field, state: engine.state.form.get(field)?.state ?? "?", spokenSoFar: line.spoken.length }),
      onSection: noop,
      onSignals: noop,
      onHandoff: noop,
      onGuardrail: noop,
      onOutcome: noop,
      onSubmit: noop,
      persistField: noop,
      onTranscriptDropped: noop,
      onHandoffCancelled: noop,
      onTurnTiming: noop,
    },
  });

  await engine.begin();
  const deadline = Date.now() + 3000;
  while (!line.spoken.some((l) => l.includes("42 Wattle Street")) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5));
  }

  const streetAnnounced = announced.find((a) => a.field === "street");
  check("the seeded field is announced as prefilled", streetAnnounced?.state === "prefilled");
  check("and announced before a word is spoken", streetAnnounced?.spokenSoFar === 0);
  check(
    "the lead's own prefill is announced too",
    ["full_name", "dob", "email"].every((id) => announced.some((a) => a.field === id && a.state === "prefilled"))
  );
  check(
    "the seeded value is read back for a yes",
    line.spoken.some((l) => l.includes("42 Wattle Street") && /\?\s*$/.test(l)),
    line.spoken.slice(-2).join(" | ")
  );
  check("the seeded field is never asked as an open question", street ? !line.spoken.includes(street.script.ask) : false);
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall setup checks passed");
process.exit(failed ? 1 : 0);

import type { FieldValue, Lead } from "@recall/shared";
import type { SpeakResult, Transport, TransportEndReason, UtteranceMeta } from "./transport.js";
import type { SignalReading } from "./escalation.js";

/**
 * `pnpm dialogue:check` - the turn logic, against a fake line.
 *
 * Every scenario reproduces something the first real journey call did wrong
 * (19 Sep 2026, call 3f927a21, 68 seconds, handed off with nothing captured):
 *
 *   - a name the lead already carried was asked as an open question, misheard,
 *     and re-asked, when a yes/no read-back would have survived the line;
 *   - CONFUSION fired the instant the customer answered the re-ask, before that
 *     answer had been looked at, so the second attempt could never succeed;
 *   - "Sorry, are you still there?" was armed off the agent's line alone, so a
 *     customer mid-sentence would be talked over the moment Scribe was slow.
 *
 * No vendors: MOCK_VOICE=1 makes extraction inert, which is exactly what a test
 * of "what does the engine do when the model returns nothing" wants. Fields that
 * would need the extractor are prefilled, so the walk to a closed field is a run
 * of yes/no confirmations - which is also the design being checked.
 *
 * The env has to be set before the engine is imported, because env.ts snapshots
 * the process environment at load. Hence the dynamic imports.
 */
process.env.MOCK_VOICE = "1";
process.env.SILENCE_NUDGE_MS = "400";
process.env.SILENCE_SECOND_NUDGE_MS = "800";
process.env.SILENCE_ABANDON_MS = "1200";
process.env.FILLER_AFTER_MS = "60000";
process.env.FRAGMENT_HOLD_MS = "300";
// Hermetic: a completed section would otherwise PUT to whatever is on :4001.
process.env.SANDBOX_URL = "http://127.0.0.1:9";

const { createEngine } = await import("./dialogue.js");
const { loadJourney } = await import("../journey/index.js");
const { log } = await import("../log.js");

// The engine narrates every turn. That is right on a call and noise here.
log.info = () => {};
log.call = () => {};
log.warn = () => {};

const journey = loadJourney();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A phone line with a scripted customer on it and no vendors behind it. */
class FakeLine implements Transport {
  readonly kind = "sim" as const;
  readonly spoken: string[] = [];
  /** Whether each spoken line could be talked over, in the same order as `spoken`. */
  readonly interruptible: boolean[] = [];
  transferredTo: string | null = null;
  recordingUrl?: string;
  /** How long each line "plays". Zero means instantly, which is what most scenarios want. */
  speakMs = 0;
  /** Lines that started while another was still playing. A real wire cannot do that. */
  overlaps = 0;
  private playing: ((result: SpeakResult) => void) | null = null;

  private utteranceCb: ((text: string, confidence: number | null, meta?: UtteranceMeta) => void) | null = null;
  private partialCb: ((text: string) => void) | null = null;
  private endedCb: ((reason: TransportEndReason) => void) | null = null;

  constructor(readonly id: string) {}

  async start(): Promise<void> {}

  async speak(text: string, opts: { onFirstAudio?: () => void; interruptible?: boolean } = {}): Promise<SpeakResult> {
    if (this.playing) this.overlaps++;
    opts.onFirstAudio?.();
    this.spoken.push(text);
    this.interruptible.push(opts.interruptible ?? true);
    if (!this.speakMs) return { completed: true, heard: text };
    return new Promise<SpeakResult>((resolve) => {
      const finish = (result: SpeakResult) => {
        clearTimeout(timer);
        this.playing = null;
        resolve(result);
      };
      const timer = setTimeout(() => finish({ completed: true, heard: text }), this.speakMs);
      this.playing = finish;
    });
  }

  async speakStream(sentences: AsyncIterable<string>): Promise<string> {
    let all = "";
    for await (const sentence of sentences) all += `${sentence} `;
    const text = all.trim();
    if (text) this.spoken.push(text);
    return text;
  }

  onUtterance(cb: (text: string, confidence: number | null, meta?: UtteranceMeta) => void): void {
    this.utteranceCb = cb;
  }
  onPartial(cb: (text: string) => void): void {
    this.partialCb = cb;
  }
  onBargeIn(): void {}
  onEnded(cb: (reason: TransportEndReason) => void): void {
    this.endedCb = cb;
  }

  async transfer(toNumber: string): Promise<void> {
    this.transferredTo = toNumber;
    this.endedCb?.("transferred");
  }

  async hangup(): Promise<void> {
    this.endedCb?.("hangup");
  }

  /**
   * A partial, then the committed transcript on a later tick, the way a real line
   * delivers it. `startedAt` is when the customer began talking, which on a real
   * line is earlier than the commit; `cuts` talks over whatever is playing, the
   * way the real transport's barge-in does.
   */
  say(text: string, confidence = 0.9, opts: { startedAt?: number; cuts?: boolean } = {}): void {
    const startedAt = opts.startedAt ?? Date.now();
    this.partialCb?.(text);
    if (opts.cuts && this.playing && this.interruptible.at(-1) !== false) this.playing({ completed: false, heard: "" });
    setImmediate(() => this.utteranceCb?.(text, confidence, { startedAt }));
  }

  partial(text: string): void {
    this.partialCb?.(text);
  }

  /** Resolves once the agent has been quiet for a moment. */
  async settle(quietMs = 40): Promise<void> {
    const deadline = Date.now() + 3000;
    let count = this.spoken.length;
    let since = Date.now();
    while (Date.now() < deadline) {
      await sleep(10);
      if (this.spoken.length !== count) {
        count = this.spoken.length;
        since = Date.now();
      } else if (Date.now() - since > quietMs) {
        return;
      }
    }
  }

  last(): string {
    return this.spoken.at(-1) ?? "";
  }
}

function lead(prefill: Record<string, FieldValue>): Lead {
  return {
    id: "L-check",
    first_name: "Priya",
    full_name: "Priya Sharma",
    phone: "+61412345678",
    email: "priya.sharma@example.com",
    last_completed_step: "contact",
    prefill,
    plan_id: "PLAN-EN-0331",
    plan_name: "econnex Saver 12",
    started_at: "on Tuesday",
  };
}

type Captured = { signals: SignalReading[]; handoff: string | null };

function hooks(captured: Captured) {
  return {
    onAgentLine: () => {},
    onCustomerLine: () => {},
    onPartial: () => {},
    onFieldChange: () => {},
    onSection: () => {},
    onSignals: (readings: SignalReading[]) => captured.signals.push(...readings),
    onHandoff: (reason: string) => {
      captured.handoff = reason;
    },
    onGuardrail: () => {},
    onOutcome: () => {},
    onSubmit: () => {},
    persistField: () => {},
  };
}

function scenario(id: string, prefill: Record<string, FieldValue>) {
  const captured: Captured = { signals: [], handoff: null };
  const line = new FakeLine(id);
  const engine = createEngine({ callId: id, journey, lead: lead(prefill), transport: line, hooks: hooks(captured) });
  return { line, engine, captured };
}

let failures = 0;

function check(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? `\n      ${detail}` : ""}`);
}

const IDENTITY_AND_CONTACT = {
  full_name: "Priya Sharma",
  dob: "1989-03-07",
  account_holder: true,
  phone: "+61412345678",
  email: "priya.sharma@example.com",
};

const THROUGH_SUPPLY = {
  ...IDENTITY_AND_CONTACT,
  street: "42 Wattle Street",
  suburb: "Parramatta",
  postcode: "2150",
  state: "NSW",
};

// ---------------------------------------------------------------------------
console.log("\n-- a field the lead already carries is confirmed, not asked");
{
  const { line, engine } = scenario("prefill", IDENTITY_AND_CONTACT);
  await engine.begin();
  line.say("Yes.");
  await line.settle();

  const name = line.last();
  check("full name is read back for a yes, not asked open-ended", /Priya Sharma/.test(name) && /is that right/i.test(name), name);
  line.say("Yes.");
  await line.settle();
  check("a yes confirms the prefilled name", engine.state.form.get("full_name")?.state === "confirmed");

  const dob = line.last();
  check("date of birth is read back as a human date", /7th of March, 1989/.test(dob) && !/what's your date of birth/i.test(dob), dob);
  line.say("Yes.");
  await line.settle();

  const holder = line.last();
  check("a closed prefilled field keeps its own yes/no question", /account holder/i.test(holder), holder);
  line.say("Yes.");
  await line.settle();

  const phone = line.last();
  check("phone keeps its confirmation phrasing", /best one to reach you on/i.test(phone), phone);
  line.say("Yes.");
  await line.settle();

  const email = line.last();
  check("email is confirmed, not asked", /priya\.sharma@example\.com/i.test(email) && !/what's the best email/i.test(email), email);
  line.say("Yes.");
  await line.settle();
  const emailField = engine.state.form.get("email");
  check("the prefilled email is confirmed with its value", emailField?.state === "confirmed" && emailField.value === "priya.sharma@example.com");
  check("the first empty field is asked normally", /street address/i.test(line.last()), line.last());

  await engine.finalise("incomplete");
}

// ---------------------------------------------------------------------------
console.log("\n-- the answer to a re-ask is heard before CONFUSION is judged");
{
  const { line, engine, captured } = scenario("second-chance", THROUGH_SUPPLY);
  await engine.begin();
  for (let i = 0; i < 10; i++) {
    line.say("Yes.");
    await line.settle();
  }
  check("the walk reaches the fuel type question", /electricity, gas, or both/i.test(line.last()), line.last());

  line.say("Uh, twenty minutes.", 0.3);
  await line.settle();
  check("a garbled answer is re-asked", /sorry - electricity, gas, or both/i.test(line.last()), line.last());
  check("the re-ask is attempt two", engine.state.form.get("fuel_type")?.attempts === 2);

  line.say("Electricity.");
  await line.settle();
  check("the second answer is accepted", engine.state.form.get("fuel_type")?.state === "confirmed" && engine.state.form.get("fuel_type")?.value === "electricity");
  check("no handoff on a customer who answered on the second go", captured.handoff === null && engine.state.outcome === null, `handoff=${captured.handoff} outcome=${engine.state.outcome}`);
  check("the journey moves on to the NMI", /NMI/.test(line.last()), line.last());

  await engine.finalise("incomplete");
}

// ---------------------------------------------------------------------------
console.log("\n-- two failed attempts still hand off");
{
  const { line, engine, captured } = scenario("cap", THROUGH_SUPPLY);
  await engine.begin();
  for (let i = 0; i < 10; i++) {
    line.say("Yes.");
    await line.settle();
  }
  line.say("Uh, twenty minutes.", 0.3);
  await line.settle();
  line.say("I just send the MD.", 0.3);
  await line.settle();

  check("CONFUSION hands off after the second failure", captured.handoff === "CONFUSION", `handoff=${captured.handoff}`);
  check("the bridging line was spoken", line.spoken.some((l) => /colleague/i.test(l)));
  check("the outcome is handoff", engine.state.outcome === "handoff", String(engine.state.outcome));
  check("the console saw CONFUSION fire", captured.signals.some((s) => s.signal === "CONFUSION" && s.fired));
  const bridge = line.spoken.findIndex((l) => /colleague/i.test(l));
  check("the handoff line cannot be talked over", bridge >= 0 && line.interruptible[bridge] === false);
}

// ---------------------------------------------------------------------------
console.log("\n-- asking for the question again is not a failed answer");
{
  const { line, engine, captured } = scenario("repeat", THROUGH_SUPPLY);
  await engine.begin();
  for (let i = 0; i < 10; i++) {
    line.say("Yes.");
    await line.settle();
  }
  line.say("Uh, can you repeat it again?");
  await line.settle();
  check("the question is asked again, word for word", /^Is this for electricity, gas, or both\?$/.test(line.last()), line.last());
  check("no attempt is consumed", engine.state.form.get("fuel_type")?.attempts === 1, `attempts=${engine.state.form.get("fuel_type")?.attempts}`);
  check("no re-ask wording, no handoff", !line.spoken.some((l) => /sorry - electricity/i.test(l)) && captured.handoff === null);

  line.say("Gas.");
  await line.settle();
  check("the answer after the repeat is accepted", engine.state.form.get("fuel_type")?.value === "gas");
  await engine.finalise("incomplete");
}

// ---------------------------------------------------------------------------
console.log("\n-- a sentence cut off by a pause waits for the rest of itself");
{
  const { line, engine } = scenario("fragment", THROUGH_SUPPLY);
  await engine.begin();
  for (let i = 0; i < 10; i++) {
    line.say("Yes.");
    await line.settle();
  }
  const before = line.spoken.length;
  line.say("Uh, it's-", 0.6);
  await sleep(120);
  check("the fragment is held rather than answered", line.spoken.length === before && engine.state.form.get("fuel_type")?.attempts === 1, `${line.spoken.length - before} new line(s), attempts=${engine.state.form.get("fuel_type")?.attempts}`);

  line.say("electricity.");
  await line.settle();
  check("the fragment and the rest are one answer", engine.state.form.get("fuel_type")?.value === "electricity", String(engine.state.form.get("fuel_type")?.value));
  check("the journey moves on", /NMI/.test(line.last()), line.last());
  await engine.finalise("incomplete");
}

{
  const { line, engine } = scenario("fragment-alone", THROUGH_SUPPLY);
  await engine.begin();
  for (let i = 0; i < 10; i++) {
    line.say("Yes.");
    await line.settle();
  }
  line.say("Uh, it's-", 0.6);
  await sleep(600);
  await line.settle();
  check("a fragment with nothing after it is answered on its own", /sorry - electricity, gas, or both/i.test(line.last()) && engine.state.form.get("fuel_type")?.attempts === 2, line.last());
  await engine.finalise("incomplete");
}

// ---------------------------------------------------------------------------
console.log("\n-- a customer who is mid-sentence is not asked if they are still there");
{
  const { line, engine } = scenario("nudge", {});
  await engine.begin();
  const nudged = () => line.spoken.filter((l) => /still there/i.test(l)).length;

  await sleep(150);
  line.partial("Uh, this is");
  await sleep(350);
  check("a partial transcript holds the nudge back", nudged() === 0, `${nudged()} nudge(s) by 500ms with a partial at 150ms and the nudge due at 400ms`);
  await sleep(350);
  check("the nudge still fires once the partials stop", nudged() === 1, `${nudged()} nudge(s) by 850ms`);

  await engine.finalise("abandoned");
}

console.log(failures ? `\n${failures} failure(s).` : "\nAll dialogue checks pass.");
process.exit(failures ? 1 : 0);

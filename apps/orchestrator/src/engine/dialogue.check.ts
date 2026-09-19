import type { FieldValue, Lead, TurnTiming } from "@recall/shared";
import type { AudioMeta, SpeakResult, Transport, TransportEndReason, UtteranceMeta } from "./transport.js";
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
// The fake line plays instantly, so the customer's reaction time is the test's own delay.
process.env.ANSWER_REACTION_MS = "0";
// Hermetic: a completed section would otherwise PUT to whatever is on :4001.
process.env.SANDBOX_URL = "http://127.0.0.1:9";

const { createEngine } = await import("./dialogue.js");
const { TurnClock } = await import("./turn-clock.js");
const { env } = await import("../env.js");
const { loadJourney } = await import("../journey/index.js");
const { log } = await import("../log.js");

// The engine narrates every turn. That is right on a call and noise here.
log.info = () => {};
log.call = () => {};
log.warn = () => {};

const journey = loadJourney();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond() && Date.now() < deadline) await sleep(2);
}

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

  async speak(
    text: string,
    opts: { onFirstAudio?: () => void; onAudioMeta?: (meta: AudioMeta) => void; interruptible?: boolean } = {}
  ): Promise<SpeakResult> {
    if (this.playing) this.overlaps++;
    // The fake models a line that never touches ElevenLabs, the way the sim
    // transport reads a pre-rendered line off disk.
    opts.onAudioMeta?.({ cached: true, chars: text.length });
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

type Captured = { signals: SignalReading[]; handoff: string | null; timings: TurnTiming[] };

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
    onTurnTiming: (timing: TurnTiming) => captured.timings.push(timing),
  };
}

type Deps = { extract?: Parameters<typeof createEngine>[0]["extract"] };

function scenario(id: string, prefill: Record<string, FieldValue>, deps: Deps = {}) {
  const captured: Captured = { signals: [], handoff: null, timings: [] };
  const line = new FakeLine(id);
  const engine = createEngine({
    callId: id,
    journey,
    lead: lead(prefill),
    transport: line,
    hooks: hooks(captured),
    ...deps,
  });
  return { line, engine, captured };
}

/**
 * Says yes until the agent asks the question a scenario wants to start from.
 *
 * Counting turns instead pins the test to how many confirmations the journey
 * happens to need today, so batching the prefilled ones broke eight scenarios
 * that were not about batching at all.
 */
async function walkTo(line: FakeLine, want: RegExp, max = 16): Promise<boolean> {
  for (let i = 0; i < max && !want.test(line.last()); i++) {
    line.say("Yes.");
    await line.settle();
  }
  return want.test(line.last());
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

/** A lead with no date of birth on it, so the date has to be given by voice. */
const IDENTITY_WITHOUT_DOB = {
  full_name: "Priya Sharma",
  account_holder: true,
  phone: "+61412345678",
  email: "priya.sharma@example.com",
};

/** What the console leaves behind when the operator clears the number. */
const IDENTITY_WITHOUT_PHONE = {
  full_name: "Priya Sharma",
  dob: "1989-03-07",
  account_holder: true,
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

  const readBack = line.last();
  check("what the lead carries is read back for a yes, not asked open-ended", /Priya Sharma/.test(readBack) && /is that right/i.test(readBack), readBack);
  check("the date of birth is read back as a human date", /7th of March, 1989/.test(readBack) && !/what's your date of birth/i.test(readBack), readBack);
  line.say("Yes.");
  await line.settle();
  check("a yes confirms the prefilled name", engine.state.form.get("full_name")?.state === "confirmed");

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
console.log("\n-- a run of values the lead carries is confirmed in one line");
{
  // Every prefilled field used to cost its own read-back and its own yes, so a
  // lead that arrived with five fields spent ten turns agreeing with itself
  // before the first real question. They are confirmed as a run now: consecutive
  // prefilled fields in one section, as long as the line actually speaks the
  // value. A line that asks a question rather than reading a value back - "are
  // you the account holder?", "is this number the best one to reach you on?" -
  // keeps its own turn, because a yes to a list is not an answer to a question.
  const { line, engine } = scenario("prefill-run", IDENTITY_AND_CONTACT);
  await engine.begin();
  const before = line.spoken.length;
  line.say("Yes.");
  await line.settle();

  const asked = line.spoken.slice(before);
  const readBack = asked.filter((l) => /is that right/i.test(l));
  check("the name and the date of birth are confirmed together", readBack.length === 1 && /Priya Sharma/.test(readBack[0] ?? "") && /7th of March, 1989/.test(readBack[0] ?? ""), JSON.stringify(readBack));

  line.say("Yes.");
  await line.settle();
  const name = engine.state.form.get("full_name");
  const dob = engine.state.form.get("dob");
  check("one yes confirms both", name?.state === "confirmed" && dob?.state === "confirmed", `${String(name?.state)} ${String(dob?.state)}`);
  check("a question keeps its own turn", /account holder/i.test(line.last()), line.last());

  await engine.finalise("incomplete");
}

// ---------------------------------------------------------------------------
console.log("\n-- a no that names one of them re-opens only that one");
{
  const { line, engine } = scenario("prefill-run-named-no", IDENTITY_AND_CONTACT);
  await engine.begin();
  line.say("Yes.");
  await line.settle();

  line.say("No, the date of birth is wrong.");
  await line.settle();

  check("the name they did not object to stands", engine.state.form.get("full_name")?.state === "confirmed", JSON.stringify(engine.state.form.get("full_name")));
  check("the one they named is re-opened", engine.state.form.get("dob")?.value === null, JSON.stringify(engine.state.form.get("dob")));
  check("and asked for outright", /date of birth again/i.test(line.last()), line.last());

  await engine.finalise("incomplete");
}

// ---------------------------------------------------------------------------
console.log("\n-- a bare no to a list asks which part");
{
  // Which value was wrong is not knowable from "no" alone, and re-asking all of
  // them makes the customer repeat what was already right.
  const { line, engine } = scenario("prefill-run-bare-no", IDENTITY_AND_CONTACT);
  await engine.begin();
  line.say("Yes.");
  await line.settle();

  line.say("No.");
  await line.settle();
  check("the list is not thrown away on a bare no", /which part/i.test(line.last()), line.last());

  line.say("The date of birth.");
  await line.settle();
  check("naming it then re-opens that one", /date of birth again/i.test(line.last()), line.last());
  check("and the rest stands", engine.state.form.get("full_name")?.state === "confirmed", JSON.stringify(engine.state.form.get("full_name")));

  await engine.finalise("incomplete");
}

// ---------------------------------------------------------------------------
console.log("\n-- a yes to a read-back outranks the model's guess at intent");
{
  // Found running the journey end to end against L-1043. Asked "is this number
  // the best one to reach you on?" the customer said "Yes, that's the one." -
  // one character past the length that decides a yes in code, so it went to the
  // extractor, which returned no patch and intent=question. The engine read
  // that as an advice question, deflected it and handed the call off: the
  // customer had just said yes and got a colleague instead.
  //
  // The model's intent is already only trusted when the turn produced nothing.
  // A yes or no to the line on the wire is not nothing.
  const { line, engine, captured } = scenario("yes-outranks-intent", IDENTITY_AND_CONTACT, {
    extract: async () => ({ accepted: [], rejected: [], intent: "question" as const, ms: 0, usage: null }),
  });
  await engine.begin();
  line.say("Yes, now's fine.");
  await line.settle();

  check("the walk reaches the name read-back", /Priya Sharma/.test(line.last()), line.last());
  line.say("Yes, that's the one.");
  await line.settle();

  check("the yes confirms the field", engine.state.form.get("full_name")?.state === "confirmed", JSON.stringify(engine.state.form.get("full_name")));
  check("no handoff on a customer who said yes", captured.handoff === null, String(captured.handoff));
  check("the journey moves on", /account holder/i.test(line.last()), line.last());

  await engine.finalise("incomplete");
}

// ---------------------------------------------------------------------------
console.log("\n-- a number the form does not hold is asked for, not confirmed at nothing");
{
  // Call bd82d644, 19 Sep 2026 05:58 UTC. Lead L-1043 carried no phone, so the
  // form held nothing for that field - but its script is a confirmation ("Is
  // this number the best one to reach you on?") and the engine asked it anyway.
  // "Yeah." cannot fill a phone field, so the same question came round five
  // seconds later, "Oh, yes, it is." could not fill it either, and the attempt
  // after that handed the call off for CONFUSION. The customer had answered
  // every time. A confirmation is only a question when there is something to
  // confirm; with nothing, the field has to be asked for outright.
  const { line, engine, captured } = scenario("phone-unknown", IDENTITY_WITHOUT_PHONE, {
    extract: async ({ utterance }) => ({
      accepted: /four one two/i.test(utterance)
        ? [{ field: "phone", value: "+61412345678", confidence: 0.9, evidence: utterance, needsConfirm: true }]
        : [],
      rejected: [],
      intent: "answer" as const,
      ms: 0,
      usage: null,
    }),
  });
  await engine.begin();
  line.say("Yes.");
  await line.settle();
  for (const _ of ["full_name", "dob", "account_holder"]) {
    line.say("Yes.");
    await line.settle();
  }

  const asked = line.last();
  check("a phone the form does not hold is asked for outright", /what'?s the best number/i.test(asked), asked);
  check("it is not put as a confirmation of nothing", !/is this number the best one/i.test(asked), asked);
  // The account holder read-back was answered by the yes/no shortcut, which
  // returns before the branch that clears this. Left pending, it ate the answer
  // to this question as a late yes to that one.
  check(
    "the read-back before it is no longer pending",
    engine.state.awaitingConfirm.length === 0,
    JSON.stringify(engine.state.awaitingConfirm)
  );

  line.say("Oh four one two, three four five, six seven eight.");
  await line.settle();
  check("the number that is given is read back", /is that right/i.test(line.last()), line.last());
  line.say("Yes.");
  await line.settle();

  const phone = engine.state.form.get("phone");
  check("the number is captured", phone?.state === "confirmed" && phone.value === "+61412345678", JSON.stringify(phone));
  check("no handoff on a customer who answered", captured.handoff === null, String(captured.handoff));
  check("the journey moves on", /email/i.test(line.last()), line.last());

  await engine.finalise("incomplete");
}

// ---------------------------------------------------------------------------
console.log("\n-- the answer to a re-ask is heard before CONFUSION is judged");
{
  const { line, engine, captured } = scenario("second-chance", THROUGH_SUPPLY);
  await engine.begin();
  check("the walk reaches the fuel type question", await walkTo(line, /electricity, gas, or both/i), line.last());

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
console.log("\n-- a read-back nobody answered is said again, not thrown away");
{
  // Call aead90d7. The customer corrected their date of birth, it was captured
  // at 0.90 and read back correctly, and the reply to the read-back came back
  // as "Thank you." at 0.50 - the recording has them saying "Right.". Neither a
  // yes, a no nor a value, so the engine binned the date it had just been
  // given, asked for it again, and charged the field an attempt for the
  // privilege. One more miss and CONFUSION handed off a customer who had
  // answered correctly the first time.
  //
  // Not hearing the answer to a read-back is not the same as being told the
  // value is wrong. The read-back is said again, at no cost to the attempts,
  // and only a second miss gives up on it.
  const { line, engine, captured } = scenario("unheard-read-back", IDENTITY_WITHOUT_DOB, {
    extract: async ({ utterance }) => ({
      accepted: /september/i.test(utterance)
        ? [{ field: "dob", value: "2002-09-01", confidence: 0.9, evidence: utterance, needsConfirm: true }]
        : [],
      rejected: [],
      intent: "answer" as const,
      ms: 0,
      usage: null,
    }),
  });
  await engine.begin();
  check("the walk reaches the date of birth", await walkTo(line, /what's your date of birth/i), line.last());
  line.say("Uh, no. Uh, it's 1st of September, 2002.");
  await line.settle();
  check("the correction is read back", /1st of September, 2002/.test(line.last()), line.last());

  const attemptsBefore = engine.state.form.get("dob")?.attempts ?? 0;
  line.say("Thank you.", 0.5);
  await line.settle();

  const dob = engine.state.form.get("dob");
  check("the date the customer gave is kept", dob?.value === "2002-09-01", JSON.stringify(dob));
  check("the read-back is said again rather than the field re-asked", /1st of September, 2002/.test(line.last()), line.last());
  check("saying it again costs no attempt", dob?.attempts === attemptsBefore, `${String(dob?.attempts)} vs ${attemptsBefore}`);

  line.say("Yes.");
  await line.settle();
  check("a yes to the second read-back confirms it", engine.state.form.get("dob")?.state === "confirmed", JSON.stringify(engine.state.form.get("dob")));
  check("no handoff on a customer who answered", captured.handoff === null, String(captured.handoff));

  await engine.finalise("incomplete");
}

// ---------------------------------------------------------------------------
console.log("\n-- a read-back nobody answers twice gives up and asks again");
{
  const { line, engine } = scenario("unheard-read-back-twice", IDENTITY_WITHOUT_DOB, {
    extract: async ({ utterance }) => ({
      accepted: /september/i.test(utterance)
        ? [{ field: "dob", value: "2002-09-01", confidence: 0.9, evidence: utterance, needsConfirm: true }]
        : [],
      rejected: [],
      intent: "answer" as const,
      ms: 0,
      usage: null,
    }),
  });
  await engine.begin();
  await walkTo(line, /what's your date of birth/i);
  line.say("Uh, no. Uh, it's 1st of September, 2002.");
  await line.settle();

  line.say("Thank you.", 0.5);
  await line.settle();
  line.say("Thank you.", 0.5);
  await line.settle();

  check("the second miss asks for the date again", /date of birth again/i.test(line.last()), line.last());
  check("and that costs an attempt", engine.state.form.get("dob")?.attempts === 2, JSON.stringify(engine.state.form.get("dob")));

  await engine.finalise("incomplete");
}

// ---------------------------------------------------------------------------
console.log("\n-- a read-back answered with a whole sentence is not said again");
{
  // The mumbler. Read back an email, they answer "mmf shrrm at gmnl" - four
  // words, no yes in them, nothing the extractor can take. That is not a
  // misheard yes, it is a correction we failed to make out, and saying the
  // read-back again would talk past them. The field gets asked outright in its
  // own re-ask wording, which for email is the one that offers to spell it.
  const { line, engine } = scenario("read-back-sentence", IDENTITY_AND_CONTACT);
  await engine.begin();
  line.say("Yes.");
  await line.settle();

  check("the walk reaches the name read-back", /Priya Sharma/.test(line.last()), line.last());
  line.say("mmf shrrm at gmnl", 0.38);
  await line.settle();

  check("the field is asked outright", /didn'?t catch that\. What was your full name/i.test(line.last()), line.last());
  check("and that costs an attempt", engine.state.form.get("full_name")?.attempts === 2, JSON.stringify(engine.state.form.get("full_name")));

  await engine.finalise("incomplete");
}

// ---------------------------------------------------------------------------
console.log("\n-- two failed attempts still hand off");
{
  const { line, engine, captured } = scenario("cap", THROUGH_SUPPLY);
  await engine.begin();
  await walkTo(line, /electricity, gas, or both/i);
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
  await walkTo(line, /electricity, gas, or both/i);
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
  await walkTo(line, /electricity, gas, or both/i);
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
  await walkTo(line, /electricity, gas, or both/i);
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

// ---------------------------------------------------------------------------
console.log("\n-- a yes spoken over the acknowledgement does not answer the question that follows it");
{
  // The customer said "yeah, go ahead" while "Great, thanks..." was still playing.
  // That is a yes to the consent question they already answered, not to the name
  // read-back that had not started yet - and it must not confirm the name.
  const { line, engine } = scenario("early-yes", IDENTITY_AND_CONTACT);
  line.speakMs = 40;
  await engine.begin();
  line.say("Yes.");
  await until(() => line.spoken.some((l) => /^Great, thanks/.test(l)));
  line.say("Yeah, go ahead.");
  await line.settle(150);

  const acks = line.spoken.filter((l) => /^Great, thanks/.test(l)).length;
  const asks = line.spoken.filter((l) => /Priya Sharma/.test(l)).length;
  check("the acknowledgement is spoken once", acks === 1, `${acks} time(s)`);
  check("the name is read back once", asks === 1, `${asks} time(s): ${line.spoken.join(" | ")}`);
  check("a yes that predates the read-back does not confirm it", engine.state.form.get("full_name")?.state !== "confirmed", String(engine.state.form.get("full_name")?.state));
  check("no line overlapped another", line.overlaps === 0, `${line.overlaps} overlap(s)`);

  line.say("Yes.");
  await line.settle(150);
  check("the yes after the read-back confirms it", engine.state.form.get("full_name")?.state === "confirmed", String(engine.state.form.get("full_name")?.state));
  await engine.finalise("incomplete");
}

// ---------------------------------------------------------------------------
console.log("\n-- a second final while the first is being answered does not ask twice");
{
  const { line, engine } = scenario("two-finals", THROUGH_SUPPLY);
  await engine.begin();
  check("the walk reaches the fuel type question", await walkTo(line, /electricity, gas, or both/i), line.last());

  line.speakMs = 40;
  const before = line.spoken.length;
  line.say("Electricity.");
  await sleep(15);
  // The customer was still talking when the first transcript committed: this
  // began well before the NMI question could have been heard.
  line.say("Yeah, electricity.", 0.9, { startedAt: Date.now() - 500 });
  await line.settle(150);

  const since = line.spoken.slice(before);
  check("the NMI question is asked exactly once, and nothing else is said", since.length === 1 && /NMI/.test(since[0] ?? ""), since.join(" | "));
  check("fuel type is confirmed", engine.state.form.get("fuel_type")?.value === "electricity", String(engine.state.form.get("fuel_type")?.value));
  check("no attempt is charged against the NMI", (engine.state.form.get("nmi")?.attempts ?? 0) <= 1, `attempts=${engine.state.form.get("nmi")?.attempts}`);
  check("no line overlapped another", line.overlaps === 0, `${line.overlaps} overlap(s)`);
  await engine.finalise("incomplete");
}

// ---------------------------------------------------------------------------
console.log("\n-- an aside that cuts a question off gets the question asked again");
{
  const { line, engine } = scenario("aside", THROUGH_SUPPLY);
  await engine.begin();
  // One short of the fuel type question, so the last yes is what puts it on the
  // line and it can be cut off mid-flight.
  await walkTo(line, /that's in NSW/i);
  line.speakMs = 40;
  line.say("Yes.");
  await until(() => /electricity, gas, or both/i.test(line.last()));
  // Two words into the question: "hang on, am I talking to a robot?"
  line.say("Hang on, am I talking to a robot?", 0.9, { cuts: true });
  await line.settle(150);

  const tail = line.spoken.slice(-2);
  check("the robot question is answered honestly", /automated assistant/i.test(tail[0] ?? ""), tail.join(" | "));
  check("then the question they never heard is asked again, word for word", /^Is this for electricity, gas, or both\?$/.test(tail[1] ?? ""), tail.join(" | "));
  check("no attempt is charged for the aside", engine.state.form.get("fuel_type")?.attempts === 1, `attempts=${engine.state.form.get("fuel_type")?.attempts}`);
  const agentLines = engine.state.transcript.filter((t) => t.speaker === "agent").map((t) => t.text).slice(-2);
  check("the transcript records what was heard, not what was cut off", /automated assistant/i.test(agentLines[0] ?? "") && /electricity, gas, or both/i.test(agentLines[1] ?? ""), agentLines.join(" | "));
  check("no line overlapped another", line.overlaps === 0, `${line.overlaps} overlap(s)`);
  await engine.finalise("incomplete");
}

// ---------------------------------------------------------------------------
console.log("\n-- the filler and the reply behind it do not talk over each other");
{
  // The filler covers a slow extraction and is deliberately not awaited, so the
  // turn continues underneath it. The reply was therefore handed to the transport
  // while "Okay." was still playing, and both went out at once.
  const { line, engine } = scenario("filler", THROUGH_SUPPLY, {
    extract: async () => {
      // Slow enough for the filler to be due, quick enough to land while it plays.
      await sleep(60);
      return { accepted: [], rejected: [], intent: "unclear" as const, ms: 60, usage: null };
    },
  });
  await engine.begin();
  check("the walk reaches the fuel type question", await walkTo(line, /electricity, gas, or both/i), line.last());

  // Now lines take time to play, and the filler is due before extraction lands.
  line.speakMs = 100;
  const fillerAfter = env.fillerAfterMs;
  env.fillerAfterMs = 40;
  const before = line.spoken.length;
  line.say("Uh, twenty minutes.", 0.3);
  await line.settle(220);
  env.fillerAfterMs = fillerAfter;

  const since = line.spoken.slice(before);
  const fillerAt = since.findIndex((l) => /^(Got it|Right|Okay|Thanks)\.$/.test(l));
  const reaskAt = since.findIndex((l) => /sorry - electricity, gas, or both/i.test(l));
  check("the filler covers the slow extraction", fillerAt >= 0, since.join(" | "));
  check("the reply follows it rather than landing on top of it", reaskAt > fillerAt, since.join(" | "));
  check("no line overlapped another", line.overlaps === 0, `${line.overlaps} overlap(s)`);
  await engine.finalise("incomplete");
}

// ---------------------------------------------------------------------------
console.log("\n-- a turn is measured from transcript in hand to audio on the wire");
{
  // The defect this whole thing exists for: latency.turn was wired for
  // EchoEngine only, so the median the rehearsal checklist asserts on had never
  // been recorded on a journey call.
  const { line, engine, captured } = scenario("timing", IDENTITY_AND_CONTACT);
  await engine.begin();
  // The opener is not a customer turn and is not measured. Start from empty
  // anyway, so this case cannot pass on something begin() happened to leave.
  captured.timings.length = 0;

  line.say("my name is Priya Sharma");
  await line.settle();

  check("one timing event per reply", captured.timings.length === 1, `got ${captured.timings.length}`);
  const t = captured.timings[0];
  if (!t) {
    check("a measured turn reports its stages", false, "no timing event to inspect");
  } else {
    check(
      "the three tiling stages sum to first audio",
      t.think_ms + t.wire_wait_ms + t.tts_ttfb_ms === t.first_audio_ms,
      `${t.think_ms} + ${t.wire_wait_ms} + ${t.tts_ttfb_ms} vs ${t.first_audio_ms}`
    );
    // The fake line plays instantly, so every stage here is zero. Positive is
    // not a claim this harness can make; negative is a real defect.
    check(
      "no stage is negative",
      t.think_ms >= 0 && t.wire_wait_ms >= 0 && t.tts_ttfb_ms >= 0 && t.first_audio_ms >= 0,
      `${t.think_ms} / ${t.wire_wait_ms} / ${t.tts_ttfb_ms} / ${t.first_audio_ms}`
    );
    check("a mocked model reports no token count", t.prompt_tokens === null && t.completion_tokens === null);
    check("a sim line is not counted as live synthesis", t.kind === "cached_line", t.kind);
  }

  await engine.finalise("incomplete");
}

// ---------------------------------------------------------------------------
console.log("\n-- a turn that never reached the wire reports nothing");
{
  // Driven against the clock directly rather than through the engine: the fake
  // line stamps first audio the instant speak() is called, so there is no
  // moment in a scenario at which a barge-in could land before it.
  const cut = new TurnClock();
  cut.markDecided();
  cut.markWireFree();
  check("a turn cut before any audio emits no timing", cut.finish() === null);

  const whole = new TurnClock();
  whole.markDecided();
  whole.markWireFree();
  whole.markFirstAudio();
  const t = whole.finish();
  check("a fully marked clock reports a timing", t !== null);
  if (t) {
    check(
      "its stages tile the turn exactly",
      t.think_ms + t.wire_wait_ms + t.tts_ttfb_ms === t.first_audio_ms,
      `${t.think_ms} + ${t.wire_wait_ms} + ${t.tts_ttfb_ms} vs ${t.first_audio_ms}`
    );
    check(
      "no stage is negative",
      t.think_ms >= 0 && t.wire_wait_ms >= 0 && t.tts_ttfb_ms >= 0,
      `${t.think_ms} / ${t.wire_wait_ms} / ${t.tts_ttfb_ms}`
    );
  }
}

console.log(failures ? `\n${failures} failure(s).` : "\nAll dialogue checks pass.");
process.exit(failures ? 1 : 0);

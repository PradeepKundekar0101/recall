import type { CallOutcome, EscalationSignal, FieldValue, Journey, JourneyField, Lead } from "@recall/shared";
import { env } from "../env.js";
import { log } from "../log.js";
import { spellOut } from "../voice/tts.js";
import { streamSentences } from "../voice/llm.js";
import { JourneyState } from "./journey-state.js";
import type { Form } from "./fact-bus.js";
import { EscalationDetector, angerPatternMatched, looksLikeDontKnow, redactDigits, ruleIntent, type SignalReading } from "./escalation.js";
import { extract } from "./extract.js";
import { normalise, normaliseBool, speakableValue } from "./normalise.js";
import { submitFinal, submitSection } from "../sandbox/submit.js";
import type { SpeakResult, Transport, TransportEndReason } from "./transport.js";

/**
 * The per-call loop.
 *
 * Plain TypeScript on purpose. The shape is
 *
 *     onTranscript(final) -> extract() -> decide() -> speak()
 *
 * with an EscalationDetector running in parallel on every turn that can call
 * handoff() from anywhere, including mid-utterance. A graph framework would put a
 * scheduler between a signal firing and the TTS socket being cancelled, and that
 * gap is the one this product cannot afford.
 *
 * Two invariants hold everywhere below:
 *
 *   - Every confirmed field is persisted the moment it is confirmed, never at the
 *     end. A call that drops after section three has to leave three sections of
 *     real data behind, because a dropped line is the normal case on a mobile, not
 *     an exceptional one.
 *   - finalise() is idempotent. It is reached from the media stream's `stop`, from
 *     Twilio's `completed` status callback, and from the engine's own close path,
 *     and those race by design.
 */

export type EngineHooks = {
  onAgentLine: (text: string) => void;
  onCustomerLine: (text: string, confidence: number | null) => void;
  onPartial: (speaker: "agent" | "customer", text: string) => void;
  onFieldChange: (fieldId: string) => void;
  onSection: (section: string, field: string | null) => void;
  onSignals: (readings: SignalReading[]) => void;
  onHandoff: (reason: EscalationSignal, evidence: string) => void;
  onGuardrail: (guardrail: string, detail: string) => void;
  onOutcome: (outcome: CallOutcome) => void;
  onSubmit: (step: string, status: number, body: unknown) => void;
  /** Called the instant a field reaches `confirmed`, for the audit trail. */
  persistField: (fieldId: string) => void;
};

export class DialogueEngine {
  readonly state: JourneyState;
  private detector: EscalationDetector;

  /** Cancels the in-flight LLM stream and TTS socket. Barge-in fires this. */
  private turn: AbortController | null = null;

  private silenceTimers: NodeJS.Timeout[] = [];

  /**
   * One line on the wire at a time.
   *
   * The filler is fire-and-forget on purpose - the turn continues underneath it -
   * so the reply used to be handed to the transport while "Okay." was still
   * playing. The transport refuses to overlap them now, but the engine is what
   * decides the order, and the order is the thing that has to be right.
   */
  private playback: Promise<unknown> = Promise.resolve();

  private fillerTimer: NodeJS.Timeout | null = null;
  /** False once the turn no longer needs covering, even if the filler is due. */
  private fillerWanted = false;
  private fillerIndex = 0;
  private nudges = 0;
  private finalised = false;

  /**
   * Customer turns run one at a time, in order. Two transcripts a breath apart
   * used to run concurrently through extract() and decide(), and both would
   * reach askNext() for the same field - the same question twice, or a "yes"
   * confirming a read-back that was only asked because of the turn before it.
   */
  private running = false;
  private queue: { raw: string; confidence: number | null; startedAt: number | null }[] = [];

  /** The last thing the customer was asked, for "can you say that again?". */
  private lastQuestion: string | null = null;
  /** When that question became audible, and whether it played to the end. */
  private questionAudibleAt = 0;
  private questionDelivered = true;
  /** Questions asked so far, so a turn can tell whether it asked one. */
  private asks = 0;
  /** A committed transcript that stopped mid-thought, waiting for the rest. */
  private fragment: { text: string; confidence: number | null; startedAt: number | null } | null = null;
  private fragmentTimer: NodeJS.Timeout | null = null;

  constructor(
    readonly callId: string,
    journey: Journey,
    lead: Lead,
    private transport: Transport,
    private hooks: EngineHooks,
    /**
     * Injected by `pnpm dialogue:check`, which needs an extraction it can slow
     * down: the filler exists only to cover a slow one.
     */
    private extractor: typeof extract = extract
  ) {
    this.state = new JourneyState(callId, journey, lead);

    this.detector = new EscalationDetector((reading) => {
      void this.handoff(reading.signal, reading.evidence);
    });

    this.state.form.on("change", ({ field, after }) => {
      this.hooks.onFieldChange(field);
      if (after.state === "confirmed") this.hooks.persistField(field);
    });

    transport.onPartial((text) => {
      this.hooks.onPartial("customer", text);
      // A partial is the customer talking. The silence clock restarts from here,
      // so an answer that takes a while - an email spelled out letter by letter -
      // is never interrupted with "are you still there?" because the STT has
      // not committed it yet.
      this.deferSilence();
    });
    transport.onUtterance((text, confidence, meta) => this.onTranscript(text, confidence, meta?.startedAt ?? null));
    transport.onBargeIn(() => this.cancelTurn("barge-in"));
    transport.onEnded((reason) => void this.onTransportEnded(reason));
  }

  // ---------------------------------------------------------------- lifecycle

  /** Opener and consent. Nothing can enter a field state before this returns. */
  async begin(): Promise<void> {
    const { scripts } = this.state.journey;

    // The phase moves to `consent` before the opener is spoken, not after.
    //
    // A customer can answer while the opener is still playing - barge-in exists
    // precisely because they do - and the reply is then handled in whatever phase
    // is current at that moment. Setting it afterwards left a window where an
    // answer arrived in phase `opener`, which neither the consent branch nor the
    // anger suppression recognises, so "Fine, but be quick" was read as hostility
    // and the call was handed to a human on turn one. It also made the whole
    // suite flaky, since whether the window was hit depended on timing.
    this.state.phase = "consent";
    await this.exclusive(() => this.askLine(this.state.render(scripts.opener)));
    this.armSilence();
  }

  /**
   * One customer turn.
   *
   * Extraction and escalation run concurrently, so a handoff can interrupt a reply
   * that is already being composed.
   */
  private onTranscript(raw: string, confidence: number | null, startedAt: number | null): void {
    if (this.finalised || this.detector.hasFired) return;

    // A commit that stops mid-thought is held for the rest of the sentence.
    //
    // Scribe marks a cut-off with a trailing dash, and a dangling "it's the"
    // says the same thing. The server's VAD floor is half a second, and people
    // pause longer than that in the middle of an address: on the second real
    // call "Uh, it's-" was taken as the whole answer, the field was re-asked,
    // and "HSR Layout, Bangalore" arrived after the handoff had fired.
    if (this.fragment) {
      const held = this.fragment;
      this.dropFragment();
      raw = `${held.text.replace(/[-\u2013\u2026]+$/, "")} ${raw}`;
      confidence =
        held.confidence === null || confidence === null
          ? (confidence ?? held.confidence)
          : Math.min(held.confidence, confidence);
      startedAt = held.startedAt ?? startedAt;
    } else if (looksCutOff(raw)) {
      this.fragment = { text: raw, confidence, startedAt };
      this.fragmentTimer = setTimeout(() => {
        const held = this.fragment;
        this.dropFragment();
        if (held) this.enqueue(held.text, held.confidence, held.startedAt);
      }, env.fragmentHoldMs);
      return;
    }

    this.enqueue(raw, confidence, startedAt);
  }

  private enqueue(raw: string, confidence: number | null, startedAt: number | null): void {
    this.queue.push({ raw, confidence, startedAt });
    if (this.running) {
      // A second utterance while a reply is still being composed cancels the
      // first; the turn itself waits its go.
      this.cancelTurn("new utterance");
      return;
    }
    void this.drain();
  }

  private drain(): Promise<void> {
    return this.exclusive(async () => {
      for (let next = this.queue.shift(); next; next = this.queue.shift()) {
        await this.handleTurn(next.raw, next.confidence, next.startedAt);
      }
    });
  }

  /** One thing on the line at a time: the opener, or a run of queued turns. */
  private async exclusive(fn: () => Promise<void>): Promise<void> {
    this.running = true;
    try {
      await fn();
    } finally {
      this.running = false;
    }
    if (this.queue.length) void this.drain();
  }

  private dropFragment(): void {
    if (this.fragmentTimer) clearTimeout(this.fragmentTimer);
    this.fragmentTimer = null;
    this.fragment = null;
  }

  private async handleTurn(raw: string, confidence: number | null, startedAt: number | null): Promise<void> {
    if (this.finalised || this.detector.hasFired) return;
    this.clearSilence();
    this.nudges = 0;

    // Which line this was said to. An utterance that began before the current
    // question could be heard was said over the line before it - "yeah, go
    // ahead" over "Great, thanks" is not a yes to the read-back that followed.
    const predates = startedAt !== null && startedAt < this.questionAudibleAt + env.answerReactionMs;
    // Whether the customer was asked something they never got to hear.
    const cutBefore = !this.questionDelivered;
    const asksBefore = this.asks;

    // Guardrail 3: a digit run never reaches the transcript, the log or a screen.
    //
    // The redacted copy is for display and storage only. Redacting before
    // detection meant the SENSITIVE detector never saw the card number it exists
    // to catch - the digits were already [REDACTED] by the time it looked - so
    // reading a card out ended the call as a decline instead of a handoff.
    const text = redactDigits(raw);
    if (text !== raw) {
      this.hooks.onGuardrail("NO_CARD_DATA", "digit run redacted from the transcript");
    }
    this.state.say("customer", text, confidence);
    this.hooks.onCustomerLine(text, confidence);

    try {
      // Rule-based intent runs before the model and before the detector. A decline
      // has to outrank every escalation signal: transferring someone who just asked
      // not to be called is the opposite of respecting "no". These paths also have
      // to work when the LLM is slow or unreachable, which is when they matter most.
      const rule = ruleIntent(text);
      if (rule === "decline") return await this.decline();
      if (rule === "busy") return await this.callback(text);
      if (rule === "ask_human") return await this.handoff("ASKS", text);
      if (rule === "robot_check") await this.robotCheck();
      else if (rule === "repeat") await this.repeatQuestion();
      else if (predates && isBareYesNo(text)) {
        // A yes or no to the line before this question. That line has already
        // been dealt with, and this question has not been answered.
        log.call(this.callId, `ignored "${text}" - said before the question on the line`);
      } else await this.answer(text, raw, confidence, predates);

      await this.resumeQuestion(cutBefore, asksBefore);
    } catch (err) {
      log.call(this.callId, `turn failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.clearFiller();
      if (!this.finalised && !this.detector.hasFired) this.armSilence();
    }
  }

  /** The model-backed part of a turn: extraction and escalation, then the decision. */
  private async answer(text: string, raw: string, confidence: number | null, predates: boolean): Promise<void> {
    const asking = this.state.asking ? (this.state.fieldById(this.state.asking) ?? null) : null;

    // The line must not go quiet while the model thinks. Measured against a
    // gateway, extraction can take over a second, which on a phone reads as the
    // agent having hung up. A short pre-rendered acknowledgement covers it and
    // costs nothing, because it is already ulaw on disk.


    /**
     * Whether this turn needs the model at all.
     *
     * A closed field answered with a recognisable yes/no or enum value is
     * resolved in code further down, so calling the extractor first buys
     * nothing and costs the slowest part of the turn - measured at ~1.4s
     * against a 250ms budget. Roughly a third of the journey's questions are
     * closed, so on those turns this is the difference between a conversation
     * and a walkie-talkie.
     *
     * Natural and spelled fields still go to the model: those are the turns
     * where a customer volunteers three fields in one breath, and the whole
     * efficiency argument lives there.
     */
    /**
     * A short yes to a read-back, to the consent question or at the review
     * gate is decided in code too. Sending "Okay." to the extractor bought a
     * filler and a model round trip on every prefilled confirmation - the
     * second real call went "Okay." / "Right." / next question, five times.
     * A "no" still goes to the model, because it usually carries the
     * corrected value.
     */
    const bareYes =
      (this.state.awaitingConfirm.length > 0 || this.state.phase === "consent" || this.state.phase === "review") &&
      text.length < 20 &&
      normaliseBool(text) === true;

    // An utterance said over the previous line cannot be the answer to this
    // one, so it always goes to the model for whatever it volunteered.
    const resolvableInCode =
      !predates &&
      (bareYes ||
        (asking?.capture === "closed" &&
          (asking.type === "bool"
            ? normaliseBool(text) !== null
            : asking.type === "enum"
              ? normalise(asking, text).ok
              : false)));

    // Only when something slow is about to happen. A closed field resolved in
    // code answers in single-digit milliseconds, and a filler in front of that
    // is not covering a pause, it is adding chatter.
    if (!resolvableInCode) this.armFiller();

    const [extraction, readings] = await Promise.all([
      resolvableInCode
        ? Promise.resolve({ accepted: [], rejected: [], intent: "answer" as const, ms: 0 })
        : this.extractor({
            journey: this.state.journey,
            form: this.state.form,
            utterance: text,
            asking,
            sttConfidence: confidence,
          }),
      this.detector.evaluate({
        // Raw, not redacted: this is the only consumer that needs the digits.
        utterance: raw,
        intent: "answer",
        sttConfidence: confidence,
        attempts: asking ? (this.state.form.get(asking.id)?.attempts ?? 0) : 0,
        maxAttempts: asking?.max_attempts ?? 2,
        // A short yes/no to a closed question, or a yes to a read-back, is an
        // answer rather than a mood.
        // A yes or no is an answer wherever it appears: to a closed field, to a
        // read-back, or to the consent question. "Fine, but be quick" was being
        // rated as anger and handing off on turn one, when it is simply
        // someone agreeing while telling you they are busy.
        closedAnswer:
          (asking?.capture === "closed" ||
            this.state.awaitingConfirm.length > 0 ||
            this.state.phase === "consent") &&
          normaliseBool(text) !== null &&
          text.length < 40,
      }).then((r) => {
        this.hooks.onSignals(r);
        return r;
      }),
    ]);

    // Now that extraction has landed, the detector can tell venting from
    // answering and decide ANGER accordingly.
    this.detector.resolveAnger(readings, {
      producedAnswers: extraction.accepted.length > 0,
      patternMatched: angerPatternMatched(text),
    });

    this.clearFiller();
    if (this.detector.hasFired || this.finalised) return;
    await this.decide(text, extraction, predates);
  }

  /**
   * A question the customer talked over was never asked, whatever the script
   * says. Once the interruption has been dealt with, if this turn did not ask
   * anything else, it goes again - word for word, at no cost to the attempt count.
   */
  private async resumeQuestion(cutBefore: boolean, asksBefore: number): Promise<void> {
    if (!cutBefore || this.asks !== asksBefore) return;
    if (this.finalised || this.detector.hasFired || !this.lastQuestion) return;
    log.call(this.callId, "asking again the question that was talked over");
    await this.repeatQuestion();
  }

  /**
   * Routes the turn: consent, an exit path, a confirmation, or the next field.
   *
   * `predates` means the utterance began before the current question could be
   * heard. It can still volunteer values; it cannot answer, confirm or fail the
   * question, and it never moves the journey past it.
   */
  private async decide(text: string, extraction: Awaited<ReturnType<typeof extract>>, predates: boolean): Promise<void> {
    const { scripts } = this.state.journey;

    // A yes or no to a closed question is an answer, decided here and not by the
    // model.
    //
    // "No." to "do you hold a concession card" was ending the call: the extractor
    // returned no patch and guessed intent=decline, and the engine believed it.
    // The commonest turn in the whole journey should not depend on a model's
    // reading of a two-letter utterance stripped of its question - so it is
    // resolved directly, which is both safer and one round trip cheaper.
    const askingField = this.state.asking ? this.state.fieldById(this.state.asking) : undefined;
    if (!predates && askingField?.capture === "closed" && (askingField.type === "bool" || askingField.type === "enum")) {
      const result =
        askingField.type === "bool"
          ? (() => {
              const said = normaliseBool(text);
              return said === null ? null : said;
            })()
          : (() => {
              const r = normalise(askingField, text);
              return r.ok ? r.value : null;
            })();

      if (result !== null) {
        this.state.form.set(askingField.id, {
          state: askingField.confirm === "none" ? "confirmed" : "captured",
          value: result,
          confidence: 1,
          evidence: text.slice(0, 80),
        });
        return askingField.confirm === "none" ? this.askNext() : this.confirm([askingField.id]);
      }
    }

    // The model's intent is only trusted when the turn produced nothing.
    //
    // "No." is the correct answer to "do you hold a concession card", and a
    // classifier reading it without the question in front of it returns
    // intent=decline - which ends the call on a customer who was answering
    // perfectly well. The unambiguous phrasings ("not interested", "stop
    // calling") are caught by ruleIntent before this, and those are trusted
    // regardless; this switch only sees the model's guess.
    const answeredSomething = extraction.accepted.length > 0;

    switch (answeredSomething ? "answer" : extraction.intent) {
      // decline and busy are deliberately absent.
      //
      // Both end the call, and decline also adds a permanent opt-out, so they
      // are the two outcomes least tolerable to get wrong. The model returned
      // intent=decline for an angry customer mid-journey and for someone reading
      // out a card number - neither was hanging up. Those paths are driven by
      // ruleIntent's explicit phrasings instead, which cost a missed hint at
      // worst; a customer who genuinely wants to go says so unmistakably, and
      // usually twice.
      case "ask_human":
        return this.handoff("ASKS", text);
      case "question": {
        // The detector runs in parallel with extraction, so it never sees this
        // intent - which is why OFF_SCRIPT could not fire from it, and the agent
        // deflected an advice question without ever handing off. Tripped
        // explicitly here, now that the intent is known.
        this.hooks.onGuardrail("NO_ADVICE", "advice question deflected, handing to a human");
        await this.speak(scripts.no_advice);
        this.detector.trip("OFF_SCRIPT", text);
        return;
      }
      default:
        break;
    }

    // The review gate. A yes here is the last thing standing between the form and
    // the sandbox, so it is handled before anything else that could reinterpret it.
    if (this.state.phase === "review") {
      if (predates) return;
      const said = normaliseBool(text);
      if (said === true) return this.submit();
      if (said === false) {
        // They named something wrong. Re-open whichever field they mentioned, or
        // ask which one if the turn did not make it clear.
        const named = this.state.journey.fields.find((f) =>
          text.toLowerCase().includes(f.label.toLowerCase())
        );
        if (named) {
          this.state.form.reject(named.id);
          this.state.phase = "section";
          return this.askField(named, { reask: true });
        }
        this.state.phase = "section";
        await this.speak("No problem - which part should I change?");
        return;
      }
      return this.askLine(this.state.render(this.state.journey.scripts.review));
    }

    if (this.state.phase === "consent") {
      if (predates) return;
      const said = normaliseBool(text);
      if (said === false) return this.decline();
      if (said !== true) {
        await this.askLine(this.state.render(scripts.opener));
        return;
      }
      this.grantConsent();
      await this.speak(scripts.consent_yes);
      return this.askNext();
    }

    // A pending read-back is answered before anything else is considered.
    if (this.state.awaitingConfirm.length) {
      const pending = this.state.awaitingConfirm;
      const fieldId = pending[0] as string;
      const said = normaliseBool(text);
      const patch = extraction.accepted.find((p) => p.field === fieldId);
      // Said over the line before the read-back: only a value for the field
      // being read back means anything, and the read-back stands otherwise.
      if (predates && !patch) return;
      this.state.awaitingConfirm = [];

      if (said === true && !predates) {
        for (const id of pending) this.state.form.set(id, { state: "confirmed" });
        return this.askNext();
      }

      // People answer a confirmation with the value instead of a yes: asked "is
      // this still your number?" they read out a different one, and asked to
      // confirm a prefilled name they simply say the name. Taking that as a "no"
      // and re-asking makes the agent look like it was not listening.
      if (patch) {
        // Saying the value back instead of "yes" is a yes.
        if (sameValue(patch.value, this.state.form.get(fieldId)?.value)) {
          for (const id of pending) this.state.form.set(id, { state: "confirmed" });
          return this.askNext();
        }
        // A different value, heard by voice, gets its own read-back before it
        // counts. The second real call wrote a garbled correction straight
        // into the form with no read-back at all.
        this.state.form.set(fieldId, {
          state: "captured",
          value: patch.value,
          confidence: patch.confidence,
          evidence: patch.evidence,
        });
        return this.confirm([fieldId]);
      }

      if (said === false) {
        // A "no" to a batch clears the whole batch. Which value was wrong is not
        // knowable from "no", and keeping two of three would silently confirm
        // something the customer just rejected.
        for (const id of pending) this.state.form.reject(id);
        return this.askField(this.state.fieldById(fieldId), { reask: true });
      }

      // Neither a yes, a no, nor a value. Ask once more rather than guessing.
      for (const id of pending) this.state.form.reject(id);
      return this.askField(this.state.fieldById(fieldId), { reask: true });
    }

    for (const patch of extraction.accepted) {
      this.state.form.set(patch.field, {
        state: patch.needsConfirm ? "captured" : "confirmed",
        value: patch.value,
        confidence: patch.confidence,
        evidence: patch.evidence,
      });
    }

    const needsConfirm = extraction.accepted.filter((p) => p.needsConfirm).map((p) => p.field);
    if (needsConfirm.length) return this.confirm(needsConfirm);

    // The question on the line is still waiting for its answer.
    if (predates && this.state.asking && !extraction.accepted.some((p) => p.field === this.state.asking)) return;

    if (!extraction.accepted.length && this.state.asking) {
      const asked = this.state.fieldById(this.state.asking);

      // An optional field the customer does not have is answered, not unanswered.
      // Recorded as confirmed-with-no-value so it leaves the queue and shows on
      // the console as handled rather than sitting amber for the rest of the call.
      if (asked && !asked.required && looksLikeDontKnow(text)) {
        this.state.form.set(asked.id, { state: "confirmed", value: null, evidence: text.slice(0, 80) });
        return this.askNext();
      }

      return this.askField(asked, { reask: true });
    }

    return this.askNext();
  }

  /** Consent gate. Entering a field phase without it throws rather than coercing. */
  private grantConsent(): void {
    if (this.state.phase !== "consent") {
      throw new Error(`consent can only be granted in the consent phase, not ${this.state.phase}`);
    }
    this.state.consentAt = Date.now();
    this.hooks.onGuardrail("CONSENT_FIRST", "consent recorded before any field was asked");
  }

  /**
   * "Am I talking to a bot?"
   *
   * Answered honestly, with a human offered, at any point in the call. Not routed
   * through the model: this is the one answer that must never be improvised.
   */
  private async robotCheck(): Promise<void> {
    this.hooks.onGuardrail("CONSENT_FIRST", "disclosed automated assistant on request");
    await this.speak(this.state.journey.scripts.robot_disclosure);
  }

  /** "Can you say that again?" - the question, word for word, at no cost to the attempt count. */
  private async repeatQuestion(): Promise<void> {
    await this.speak(this.lastQuestion ?? this.state.render(this.state.journey.scripts.opener));
  }

  /** Speaks a line the customer is expected to answer, and remembers it for a repeat. */
  private async askLine(text: string): Promise<void> {
    this.lastQuestion = text;
    this.asks++;
    this.questionAudibleAt = Infinity;
    this.questionDelivered = false;
    const result = await this.speak(text, {
      onFirstAudio: () => {
        this.questionAudibleAt = Date.now();
      },
    });
    // Nothing reached the wire. Do not leave every later answer "predating" it.
    if (this.questionAudibleAt === Infinity) this.questionAudibleAt = Date.now();
    this.questionDelivered = result.completed;
  }

  private async askNext(): Promise<void> {
    if (!this.state.consent) throw new Error("consent gate: cannot ask a field before consent");

    const field = this.state.nextField();
    if (!field) return this.review();

    const section = field.section;

    // A completed section goes to the sandbox immediately rather than waiting for
    // the final POST. This is the whole reason for doing it incrementally: a call
    // that escalates at Supply has already saved Identity and Contact, so the
    // human picks up a journey that is genuinely further along instead of one
    // that exists only in memory.
    this.flushCompletedSections();

    if (this.state.phase !== "section" || this.state.currentSection() !== section) {
      const intro = this.state.journey.sections.find((s) => s.id === section)?.intro;
      this.state.phase = "section";
      if (intro) await this.speak(intro);
    }
    this.hooks.onSection(section, field.id);
    return this.askField(field);
  }

  private async askField(field: JourneyField | undefined, opts: { reask?: boolean } = {}): Promise<void> {
    if (!field) return this.askNext();

    // A sensitive field is never asked for. There are none in Energy; the rule
    // exists so adding one cannot turn into the agent requesting card details.
    if (field.sensitive) {
      this.hooks.onGuardrail("NO_CARD_DATA", `refused to ask for sensitive field ${field.id}`);
      return this.askNext();
    }

    // A field the lead already carries is confirmed, not asked. Its script is
    // phrased as a confirmation ("Is this number the best one to reach you on?"),
    // so the customer's yes resolves it and the engine must not go looking for a
    // new value in a turn that contains none. This is what the efficiency number
    // is measuring: a dropped-off lead should not re-answer what it already gave.
    const existing = this.state.form.get(field.id);
    const prefilled = existing?.state === "prefilled" && existing.value !== null ? existing.value : null;

    this.state.asking = field.id;
    this.state.form.set(field.id, { state: "asking" });

    const attempts = this.state.form.get(field.id)?.attempts ?? 0;
    if (attempts > field.max_attempts) {
      // The one place CONFUSION is decided. The detector reports the count for
      // the meter but never fires on it: deciding there judged the answer to a
      // re-ask before it had been heard, so on the first real call the second
      // attempt at a name was handed off before extraction had even run.
      const evidence = `${field.id} asked ${attempts} times`;
      this.hooks.onSignals([{ signal: "CONFUSION", score: 1, evidence, fired: true }]);
      return this.handoff("CONFUSION", evidence);
    }

    if (prefilled !== null && !opts.reask) {
      // Confirmed, not asked. A yes/no read-back is a closed turn: one word for
      // the line to carry, matched in code, no model - which is what survives a
      // bad mobile connection. The first real call asked "Can I start with your
      // full name?" for a name the lead already held, misheard the answer twice,
      // and handed off with nothing captured.
      this.state.awaitingConfirm = [field.id];
      const spoken = speakableValue(field, prefilled);
      await this.askLine(
        this.state.render(prefilledLine(field), {
          value: spoken,
          value_spelled: field.confirm === "letters" ? spellOut(String(prefilled)) : spoken,
        })
      );
      return;
    }

    await this.askLine(this.state.render(opts.reask ? field.script.reask : field.script.ask));
  }

  /**
   * Reads values back before they count as confirmed.
   *
   * Takes a list because a single turn can fill several fields. Three fields
   * volunteered together get one "I have 42 Wattle Street, Parramatta, 2150. Is
   * that right?" rather than three separate read-backs, which is both faster and
   * what a person would actually do.
   */
  private async confirm(fieldIds: string[]): Promise<void> {
    const pending = fieldIds.filter((id) => {
      const field = this.state.fieldById(id);
      const value = this.state.form.get(id)?.value;
      return field?.script.confirm && value !== null && value !== undefined;
    });

    // Nothing worth reading back; accept and move on.
    if (!pending.length) {
      for (const id of fieldIds) this.state.form.set(id, { state: "confirmed" });
      return this.askNext();
    }

    this.state.awaitingConfirm = pending;

    if (pending.length === 1) {
      const id = pending[0] as string;
      const field = this.state.fieldById(id) as JourneyField;
      const value = this.state.form.get(id)?.value as NonNullable<ReturnType<Form["get"]>>["value"];
      const spoken = speakableValue(field, value);
      return this.askLine(
        this.state.render(field.script.confirm as string, {
          value: spoken,
          value_spelled: field.confirm === "letters" ? spellOut(String(value)) : spoken,
        })
      );
    }

    const values = pending
      .map((id) => {
        const field = this.state.fieldById(id) as JourneyField;
        return speakableValue(field, this.state.form.get(id)?.value ?? null);
      })
      .filter(Boolean);

    return this.askLine(`I have ${values.join(", ")}. Is that right?`);
  }

  private async review(): Promise<void> {
    const missing = this.state.form.missing();
    if (missing.length) return this.askField(this.state.fieldById(missing[0] as string));
    this.state.phase = "review";
    await this.askLine(this.state.render(this.state.journey.scripts.review));
  }

  /**
   * Sends any section that has just become complete.
   *
   * Deliberately not awaited. A sandbox that is slow or down must not add latency
   * to the next question or stall the call - the final POST is the gate that
   * decides whether the journey counts, and this is an optimisation on top of it.
   */
  private flushCompletedSections(): void {
    for (const section of this.state.journey.sections) {
      if (this.state.submittedSections.has(section.id)) continue;
      if (!this.state.sectionComplete(section.id)) continue;

      this.state.submittedSections.add(section.id);
      void submitSection({
        lead: this.state.lead,
        form: this.state.form.snapshot(),
        section: section.id,
        consentAt: this.state.consentAt ?? Date.now(),
      })
        .then((result) => this.hooks.onSubmit(result.step, result.status, result.body))
        .catch((err) => {
          // Logged, not surfaced: a failed partial save is recoverable by the
          // final POST, and the customer should never hear about it.
          log.call(this.callId, `section ${section.id} PUT failed: ${String(err)}`);
          this.state.submittedSections.delete(section.id);
        });
    }
  }

  /**
   * Builds the payload and sends it.
   *
   * The engine refuses to submit while any required, applicable field is
   * unconfirmed - the review read-back is the last human gate, this is the last
   * machine one. A rejection is spoken rather than swallowed, because a silent
   * failure here is a call the customer believes succeeded.
   */
  private async submit(): Promise<void> {
    this.state.phase = "submit";
    const form = this.state.form.snapshot();

    try {
      const result = await submitFinal({
        lead: this.state.lead,
        form,
        consentAt: this.state.consentAt ?? Date.now(),
        requiredFields: this.state.journey.fields
          .filter((f) => f.required && this.state.form.applies(f.id))
          .map((f) => f.id),
      });
      this.hooks.onSubmit(result.step, result.status, result.body);

      if (result.status >= 200 && result.status < 300) {
        for (const id of Object.keys(form)) {
          if (this.state.form.get(id)?.state === "confirmed") {
            this.state.form.set(id, { state: "submitted" });
          }
        }
        this.state.phase = "close";
        await this.speak(this.state.render(this.state.journey.scripts.close));
        return this.finalise("submitted");
      }

      log.call(this.callId, `sandbox rejected: ${result.status} ${JSON.stringify(result.body).slice(0, 200)}`);
      await this.speak("Sorry, something went wrong saving that. Let me get a colleague to finish it off.");
      return this.handoff("SENSITIVE", `sandbox returned ${result.status}`);
    } catch (err) {
      log.call(this.callId, `submit failed: ${err instanceof Error ? err.message : String(err)}`);
      await this.speak("Sorry, something went wrong saving that. Let me get a colleague to finish it off.");
      return this.handoff("SENSITIVE", "submit failed");
    }
  }

  // -------------------------------------------------------------- exit paths

  private async decline(): Promise<void> {
    log.call(this.callId, `DECLINE triggered by: "${this.state.transcript.at(-1)?.text ?? "?"}"`);
    this.state.phase = "decline";
    this.hooks.onGuardrail("RESPECT_NO", "declined; opted out, no second ask");
    await this.speak(this.state.journey.scripts.decline);
    await this.finalise("declined");
  }

  private async callback(text: string): Promise<void> {
    this.state.phase = "callback";
    this.state.callbackWindow = text.slice(0, 120);
    await this.speak(this.state.journey.scripts.busy);
    await this.finalise("incomplete");
  }

  /**
   * Warm handoff. Callable from anywhere, including mid-utterance.
   *
   * The in-flight reply is cancelled first, so the bridging line does not queue
   * behind a sentence the customer has already stopped listening to.
   */
  async handoff(reason: EscalationSignal, evidence: string): Promise<void> {
    if (this.finalised || this.state.phase === "handoff") return;
    this.cancelTurn("handoff");
    this.state.phase = "handoff";
    this.state.handoffReason = reason;
    // Whatever is complete goes to the sandbox before the line changes hands.
    this.flushCompletedSections();
    log.call(this.callId, `handoff: ${reason} - ${evidence.slice(0, 60)}`);

    this.hooks.onHandoff(reason, evidence);
    // Heard whole. Cut short by a customer still finishing their sentence, it
    // left them with "I'm going to" and then a transfer they had no warning of.
    await this.speak(this.state.journey.scripts.handoff_bridge, { interruptible: false });

    if (env.handoffNumber) {
      try {
        await this.transport.transfer(
          env.handoffNumber,
          `Recovery call, ${this.state.lead.first_name}, escalated for ${reason}.`
        );
      } catch (err) {
        // The documented fallback: end after the bridging line and let the human
        // console show "call back now" with the packet already on screen.
        log.call(this.callId, `transfer failed, falling back to call-back: ${String(err)}`);
      }
    }
    await this.finalise("handoff");
  }

  // ------------------------------------------------------------------ speech

  /**
   * Speaks a line, streaming it into TTS.
   *
   * Fixed lines are pre-rendered, so they play from disk with no round trip. Free
   * lines stream sentence by sentence out of the model and into the TTS socket, so
   * first audio costs one short synthesis rather than the whole reply.
   */
  private async speak(
    text: string,
    opts: { generate?: boolean; interruptible?: boolean; onFirstAudio?: () => void } = {}
  ): Promise<SpeakResult> {
    if (this.finalised) return { completed: false, heard: "" };
    const controller = new AbortController();
    this.turn = controller;

    try {
      // Verbatim is the default, and the LLM is the exception.
      //
      // Scripts are the source of truth for what gets asked. Routing a read-back
      // through the model produced "Yep, that's right mate." in place of "I have
      // Priya Sharma. Is that right?" - the model answered the question instead of
      // speaking the line, and a read-back the customer never heard is a confirmed
      // field that was never confirmed.
      //
      // Keeping the model out of the speech path also takes it off the critical
      // path entirely: a turn now costs one extraction call, not two round trips.
      if (!opts.generate || env.mockVoice) {
        // The transcript is written inside the queue, so it reads in the order
        // the customer heard it rather than the order the engine decided it.
        return await this.onTheWire(async () => {
          const line = this.state.say("agent", text, null);
          this.hooks.onAgentLine(text);
          const result = await this.transport.speak(text, {
            interruptible: opts.interruptible,
            onFirstAudio: opts.onFirstAudio,
          });
          // The record keeps what was heard, not what was scripted.
          if (!result.completed) this.state.cut(line, result.heard);
          return result;
        });
      }

      const spoken = await this.onTheWire(() =>
        this.transport.speakStream(
          streamSentences({
            system:
              "You are a concise Australian call-centre assistant. Say the given line in one or two short " +
              "sentences. Never give advice, never invent details, never ask for information you were not given.",
            messages: [{ role: "user", content: text }],
            signal: controller.signal,
          }),
          controller.signal
        )
      );
      if (!controller.signal.aborted) {
        this.state.say("agent", spoken || text, null);
        this.hooks.onAgentLine(spoken || text);
      }
      return { completed: !controller.signal.aborted, heard: spoken };
    } finally {
      if (this.turn === controller) this.turn = null;
    }
  }

  /** Waits for whatever is playing, then runs `fn`. Never wedges on a rejection. */
  private onTheWire<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.playback.then(fn, fn);
    this.playback = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  /** Barge-in and handoff both land here: kill the LLM stream and the TTS socket. */
  private cancelTurn(why: string): void {
    if (!this.turn) return;
    log.call(this.callId, `cancelling in-flight turn (${why})`);
    // Aborting the controller cancels both halves: streamSentences stops pulling
    // tokens, and the transport's synthesize() call drops its TTS socket.
    this.turn?.abort();
    this.turn = null;
  }

  // ----------------------------------------------------------------- silence

  /**
   * Silence on an open question.
   *
   * Two nudges, then close as abandoned. Armed after every agent line and cleared
   * by any transcript, so a customer who is thinking is not talked over.
   */
  /**
   * Plays a filler if the model has not come back in time.
   *
   * Deliberately fire-and-forget: the turn continues underneath it, and the
   * filler is short enough that the real reply follows naturally rather than
   * queueing behind a long line.
   */
  private armFiller(): void {
    this.clearFiller();
    this.fillerWanted = true;
    this.fillerTimer = setTimeout(() => {
      this.fillerTimer = null;
      void this.onTheWire(async () => {
        // Checked here rather than when the timer fires: by the time the wire is
        // free the reply may already be composed, and a filler then adds chatter
        // and delay instead of covering a pause.
        if (!this.fillerWanted || this.finalised || this.detector.hasFired) return;
        const filler = JourneyState.FILLERS[this.fillerIndex % JourneyState.FILLERS.length] as string;
        this.fillerIndex++;
        this.hooks.onAgentLine(filler);
        await this.transport.speak(filler);
      }).catch(() => undefined);
    }, env.fillerAfterMs);
  }

  private clearFiller(): void {
    this.fillerWanted = false;
    if (this.fillerTimer) clearTimeout(this.fillerTimer);
    this.fillerTimer = null;
  }

  private armSilence(): void {
    this.clearSilence();
    if (this.finalised) return;

    this.silenceTimers.push(
      setTimeout(() => void this.nudge(), env.silenceNudgeMs),
      setTimeout(() => void this.nudge(), env.silenceSecondNudgeMs),
      setTimeout(() => {
        log.call(this.callId, "abandoned after two nudges");
        void this.endPolitely();
      }, env.silenceAbandonMs)
    );
  }

  private clearSilence(): void {
    for (const timer of this.silenceTimers) clearTimeout(timer);
    this.silenceTimers = [];
  }

  /** Restarts the silence clock if it is running. Every partial transcript lands here. */
  private deferSilence(): void {
    if (this.silenceTimers.length) this.armSilence();
  }

  private async nudge(): Promise<void> {
    if (this.finalised || this.running) return;
    this.nudges++;
    await this.speak("Sorry, are you still there?");
  }

  private async endPolitely(): Promise<void> {
    await this.speak("I'll let you go for now. Thanks for your time.");
    await this.finalise("abandoned");
  }

  // -------------------------------------------------------------- finalising

  /**
   * Maps a transport's end reason onto an outcome.
   *
   * `hangup` and `failed` become `disconnected` only when the call was still in
   * progress; if the engine had already decided an outcome, that one stands - a
   * customer hanging up after "thanks, have a good one" completed the call.
   */
  private async onTransportEnded(reason: TransportEndReason): Promise<void> {
    if (this.state.outcome) return void (await this.finalise(this.state.outcome));

    const mapped: CallOutcome =
      reason === "transferred"
        ? "handoff"
        : reason === "no_answer" || reason === "busy" || reason === "voicemail"
          ? "no_answer"
          : reason === "completed"
            ? this.state.form.complete()
              ? "submitted"
              : "incomplete"
            : "disconnected";

    await this.finalise(mapped);
  }

  /**
   * Idempotent. Reached from the media stream's `stop`, from Twilio's `completed`
   * status callback and from the engine's own exits, and those race by design -
   * on a real call the websocket close and the status webhook arrive within
   * milliseconds of each other and in no guaranteed order.
   */
  async finalise(outcome: CallOutcome): Promise<void> {
    if (this.finalised) return;
    this.finalised = true;
    this.clearSilence();
    this.clearFiller();
    this.dropFragment();
    this.cancelTurn("finalise");

    this.state.outcome = outcome;
    this.state.phase = "ended";
    log.call(this.callId, `outcome ${outcome} after ${this.state.durationSeconds}s`);
    this.hooks.onOutcome(outcome);

    try {
      await this.transport.hangup(outcome);
    } catch {
      /* the line may already be gone, which is the common case here */
    }
  }

  get isFinalised(): boolean {
    return this.finalised;
  }
}

function sameValue(a: FieldValue, b: FieldValue | undefined): boolean {
  if (b === undefined || b === null) return false;
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

/** Words a sentence does not end on. A commit ending here has more coming. */
const DANGLING = new Set([
  "the", "a", "an", "my", "it's", "its", "is", "at", "of", "to", "and", "let",
  "uh", "um", "er", "ah", "hmm", "mm",
]);

/**
 * Whether a committed transcript stopped mid-thought.
 *
 * Scribe writes a trailing dash when the speaker was cut off ("Uh, it's-"), and
 * a final word that nothing ends on ("no, it's the") means the same. Both are
 * held for the rest of the sentence rather than answered.
 */
/** A short yes or no and nothing else - the shape of a word said over the previous line. */
function isBareYesNo(text: string): boolean {
  return text.length < 20 && normaliseBool(text) !== null;
}

export function looksCutOff(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (/[-\u2013\u2026]$/.test(trimmed)) return true;
  const words = trimmed
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  const last = words.at(-1);
  return last !== undefined && DANGLING.has(last);
}

/**
 * The line for a field the lead already carries.
 *
 * An explicit `prefilled` script wins. Without one, a closed field's ask is
 * already a yes/no or a choice ("Is this number the best one to reach you on?")
 * and stands as it is; anything else falls back to the read-back template,
 * which is phrased as a confirmation by definition.
 */
function prefilledLine(field: JourneyField): string {
  if (field.script.prefilled) return field.script.prefilled;
  if (field.capture === "closed") return field.script.ask;
  return field.script.confirm ?? field.script.ask;
}

/** Convenience for the eval harness and the API route. */
export function createEngine(opts: {
  callId: string;
  journey: Journey;
  lead: Lead;
  transport: Transport;
  hooks: EngineHooks;
  extract?: typeof extract;
}): DialogueEngine {
  return new DialogueEngine(opts.callId, opts.journey, opts.lead, opts.transport, opts.hooks, opts.extract);
}

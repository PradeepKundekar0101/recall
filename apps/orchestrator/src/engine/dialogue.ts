import type { CallOutcome, EscalationSignal, Journey, JourneyField, Lead } from "@recall/shared";
import { env } from "../env.js";
import { log } from "../log.js";
import { spellOut } from "../voice/tts.js";
import { streamSentences } from "../voice/llm.js";
import { JourneyState } from "./journey-state.js";
import { EscalationDetector, redactDigits, ruleIntent, type SignalReading } from "./escalation.js";
import { extract } from "./extract.js";
import { normaliseBool } from "./normalise.js";
import type { Transport, TransportEndReason } from "./transport.js";

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
  /** Called the instant a field reaches `confirmed`, for the audit trail. */
  persistField: (fieldId: string) => void;
};

export class DialogueEngine {
  readonly state: JourneyState;
  private detector: EscalationDetector;

  /** Cancels the in-flight LLM stream and TTS socket. Barge-in fires this. */
  private turn: AbortController | null = null;

  private silenceTimers: NodeJS.Timeout[] = [];
  private nudges = 0;
  private finalised = false;
  private busy = false;

  constructor(
    readonly callId: string,
    journey: Journey,
    lead: Lead,
    private transport: Transport,
    private hooks: EngineHooks
  ) {
    this.state = new JourneyState(callId, journey, lead);

    this.detector = new EscalationDetector((reading) => {
      void this.handoff(reading.signal, reading.evidence);
    });

    this.state.form.on("change", ({ field, after }) => {
      this.hooks.onFieldChange(field);
      if (after.state === "confirmed") this.hooks.persistField(field);
    });

    transport.onPartial((text) => this.hooks.onPartial("customer", text));
    transport.onUtterance((text, confidence) => void this.onTranscript(text, confidence));
    transport.onBargeIn(() => this.cancelTurn("barge-in"));
    transport.onEnded((reason) => void this.onTransportEnded(reason));
  }

  // ---------------------------------------------------------------- lifecycle

  /** Opener and consent. Nothing can enter a field state before this returns. */
  async begin(): Promise<void> {
    const { scripts } = this.state.journey;
    this.state.phase = "opener";
    await this.speak(this.state.render(scripts.opener), { fixed: true });
    this.state.phase = "consent";
    this.armSilence();
  }

  /**
   * One customer turn.
   *
   * Extraction and escalation run concurrently, so a handoff can interrupt a reply
   * that is already being composed.
   */
  private async onTranscript(raw: string, confidence: number | null): Promise<void> {
    if (this.finalised || this.detector.hasFired) return;
    this.clearSilence();
    this.nudges = 0;

    // Guardrail 3: a digit run never reaches the transcript, the log or a screen.
    const text = redactDigits(raw);
    if (text !== raw) {
      this.hooks.onGuardrail("NO_CARD_DATA", "digit run redacted from the transcript");
    }
    this.hooks.onCustomerLine(text, confidence);

    // A second utterance while a reply is still being composed cancels the first.
    if (this.busy) this.cancelTurn("new utterance");
    this.busy = true;

    try {
      // Rule-based intent runs before the model and before the detector. A decline
      // has to outrank every escalation signal: transferring someone who just asked
      // not to be called is the opposite of respecting "no". These paths also have
      // to work when the LLM is slow or unreachable, which is when they matter most.
      const rule = ruleIntent(text);
      if (rule === "decline") return await this.decline();
      if (rule === "busy") return await this.callback(text);
      if (rule === "ask_human") return await this.handoff("ASKS", text);
      if (rule === "robot_check") return await this.robotCheck();

      const asking = this.state.asking ? (this.state.fieldById(this.state.asking) ?? null) : null;

      const [extraction] = await Promise.all([
        extract({
          journey: this.state.journey,
          form: this.state.form,
          utterance: text,
          asking,
          sttConfidence: confidence,
        }),
        this.detector.evaluate({
          utterance: text,
          intent: "answer",
          sttConfidence: confidence,
          attempts: asking ? (this.state.form.get(asking.id)?.attempts ?? 0) : 0,
          maxAttempts: asking?.max_attempts ?? 2,
        }).then((readings) => this.hooks.onSignals(readings)),
      ]);

      if (this.detector.hasFired || this.finalised) return;
      await this.decide(text, extraction);
    } catch (err) {
      log.call(this.callId, `turn failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.busy = false;
      if (!this.finalised && !this.detector.hasFired) this.armSilence();
    }
  }

  /** Routes the turn: consent, an exit path, a confirmation, or the next field. */
  private async decide(text: string, extraction: Awaited<ReturnType<typeof extract>>): Promise<void> {
    const { scripts } = this.state.journey;

    switch (extraction.intent) {
      case "decline":
        return this.decline();
      case "busy":
        return this.callback(text);
      case "ask_human":
        return this.handoff("ASKS", text);
      case "question":
        // NO ADVICE lives on the OFF_SCRIPT path; the detector decides whether it
        // was an advice question, so anything still here is answerable small talk.
        this.hooks.onGuardrail("NO_ADVICE", "off-journey question deflected");
        await this.speak(scripts.no_advice, { fixed: true });
        return;
      default:
        break;
    }

    if (this.state.phase === "consent") {
      const said = normaliseBool(text);
      if (said === false) return this.decline();
      if (said !== true) {
        await this.speak(this.state.render(scripts.opener), { fixed: true });
        return;
      }
      this.grantConsent();
      await this.speak(scripts.consent_yes, { fixed: true });
      return this.askNext();
    }

    // A pending read-back is answered before anything else is considered.
    if (this.state.awaitingConfirm) {
      const said = normaliseBool(text);
      const fieldId = this.state.awaitingConfirm;
      this.state.awaitingConfirm = null;
      if (said === true) {
        this.state.form.set(fieldId, { state: "confirmed" });
        return this.askNext();
      }
      this.state.form.reject(fieldId);
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

    const needsConfirm = extraction.accepted.find((p) => p.needsConfirm);
    if (needsConfirm) return this.confirm(needsConfirm.field);

    if (!extraction.accepted.length && this.state.asking) {
      return this.askField(this.state.fieldById(this.state.asking), { reask: true });
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
    await this.speak(this.state.journey.scripts.robot_disclosure, { fixed: true });
  }

  private async askNext(): Promise<void> {
    if (!this.state.consent) throw new Error("consent gate: cannot ask a field before consent");

    const field = this.state.nextField();
    if (!field) return this.review();

    const section = field.section;
    if (this.state.phase !== "section" || this.state.currentSection() !== section) {
      const intro = this.state.journey.sections.find((s) => s.id === section)?.intro;
      this.state.phase = "section";
      if (intro) await this.speak(intro, { fixed: true });
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

    this.state.asking = field.id;
    this.state.form.set(field.id, { state: "asking" });

    const attempts = this.state.form.get(field.id)?.attempts ?? 0;
    if (attempts > field.max_attempts) {
      return this.handoff("CONFUSION", `${field.id} asked ${attempts} times`);
    }

    await this.speak(this.state.render(opts.reask ? field.script.reask : field.script.ask), { fixed: !opts.reask });
  }

  private async confirm(fieldId: string): Promise<void> {
    const field = this.state.fieldById(fieldId);
    const value = this.state.form.get(fieldId)?.value;
    if (!field?.script.confirm || value === null || value === undefined) {
      this.state.form.set(fieldId, { state: "confirmed" });
      return this.askNext();
    }

    this.state.awaitingConfirm = fieldId;
    const spoken = String(value);
    await this.speak(
      this.state.render(field.script.confirm, {
        value: spoken,
        value_spelled: field.confirm === "letters" ? spellOut(spoken) : spoken,
      })
    );
  }

  private async review(): Promise<void> {
    const missing = this.state.form.missing();
    if (missing.length) return this.askField(this.state.fieldById(missing[0] as string));
    this.state.phase = "review";
    await this.speak(this.state.render(this.state.journey.scripts.review), { fixed: false });
  }

  // -------------------------------------------------------------- exit paths

  private async decline(): Promise<void> {
    this.state.phase = "decline";
    this.hooks.onGuardrail("RESPECT_NO", "declined; opted out, no second ask");
    await this.speak(this.state.journey.scripts.decline, { fixed: true });
    await this.finalise("declined");
  }

  private async callback(text: string): Promise<void> {
    this.state.phase = "callback";
    this.state.callbackWindow = text.slice(0, 120);
    await this.speak(this.state.journey.scripts.busy, { fixed: true });
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
    log.call(this.callId, `handoff: ${reason} - ${evidence.slice(0, 60)}`);

    this.hooks.onHandoff(reason, evidence);
    await this.speak(this.state.journey.scripts.handoff_bridge, { fixed: true });

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
  private async speak(text: string, opts: { fixed?: boolean } = {}): Promise<void> {
    if (this.finalised) return;
    const controller = new AbortController();
    this.turn = controller;

    try {
      // A fixed line is already ulaw on disk. Sending it straight avoids paying a
      // model round trip to rephrase words that must not be rephrased anyway -
      // the consent disclosure and the bridging line are compliance text.
      if (opts.fixed || env.mockVoice) {
        this.hooks.onAgentLine(text);
        await this.transport.speak(text);
        return;
      }

      const spoken = await this.transport.speakStream(
        streamSentences({
          system:
            "You are a concise Australian call-centre assistant. Say the given line in one or two short " +
            "sentences. Never give advice, never invent details, never ask for information you were not given.",
          messages: [{ role: "user", content: text }],
          signal: controller.signal,
        }),
        controller.signal
      );
      if (!controller.signal.aborted) this.hooks.onAgentLine(spoken || text);
    } finally {
      if (this.turn === controller) this.turn = null;
    }
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

  private async nudge(): Promise<void> {
    if (this.finalised || this.busy) return;
    this.nudges++;
    await this.speak("Sorry, are you still there?", { fixed: true });
  }

  private async endPolitely(): Promise<void> {
    await this.speak("I'll let you go for now. Thanks for your time.", { fixed: true });
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

/** Convenience for the eval harness and the API route. */
export function createEngine(opts: {
  callId: string;
  journey: Journey;
  lead: Lead;
  transport: Transport;
  hooks: EngineHooks;
}): DialogueEngine {
  return new DialogueEngine(opts.callId, opts.journey, opts.lead, opts.transport, opts.hooks);
}

import type { CallOutcome, Journey, JourneyField, Lead, TranscriptLine } from "@recall/shared";
import { Form } from "./fact-bus.js";
import { speakableValue } from "./normalise.js";

/**
 * Everything one call knows about itself.
 *
 * Deliberately a plain object with a Form inside it rather than a graph framework:
 * the call is a linear walk over a field list with a handful of exits, and a
 * framework would add a scheduler between an escalation firing and the TTS socket
 * being cancelled. That gap is the one place this product cannot afford latency.
 */

export type DialoguePhase =
  | "opener"
  | "consent"
  | "section"
  | "review"
  | "submit"
  | "close"
  | "decline"
  | "callback"
  | "handoff"
  | "ended";

export class JourneyState {
  readonly form: Form;
  readonly startedAt = Date.now();

  phase: DialoguePhase = "opener";
  consentAt: number | null = null;
  outcome: CallOutcome | null = null;
  handoffReason: string | null = null;

  /** Field currently being asked. Drives the console and the CONFUSION counter. */
  asking: string | null = null;
  /**
   * Fields awaiting a yes/no on their read-back.
   *
   * A list, not a single field, because a customer who says "42 Wattle Street,
   * Parramatta, 2150" has answered three questions at once and should hear one
   * confirmation rather than three - which is the difference the efficiency
   * number is measuring.
   */
  awaitingConfirm: string[] = [];
  /** Agreed callback window, when the customer asked to be rung later. */
  callbackWindow: string | null = null;

  private cursor = 0;

  /**
   * What was said, in order.
   *
   * Held on the call rather than only streamed, because the handoff packet needs
   * the last few lines and a human joining the call has no other way to see them.
   * Capped because a long call should not grow without bound; the cap is well
   * past any realistic call length.
   */
  readonly transcript: TranscriptLine[] = [];

  /** Sections already sent to the sandbox, so a section is never PUT twice. */
  readonly submittedSections = new Set<string>();

  constructor(
    readonly callId: string,
    readonly journey: Journey,
    readonly lead: Lead
  ) {
    this.form = new Form(journey, callId);
    this.form.applyLead(lead);
  }

  say(speaker: "agent" | "customer", text: string, confidence: number | null): TranscriptLine {
    const line: TranscriptLine = { at: Date.now(), speaker, text, confidence, final: true };
    this.transcript.push(line);
    if (this.transcript.length > 500) this.transcript.shift();
    return line;
  }

  /**
   * The line was talked over. The record keeps what the customer heard, marked
   * the way Scribe marks a cut-off, and drops the line entirely if nothing was.
   */
  cut(line: TranscriptLine, heard: string): void {
    if (heard) {
      line.text = `${heard} -`;
      return;
    }
    const at = this.transcript.indexOf(line);
    if (at >= 0) this.transcript.splice(at, 1);
  }

  /**
   * A section is complete when every applicable field in it is confirmed.
   *
   * Optional fields count once they have been asked and resolved, including the
   * ones the customer did not have - those are recorded confirmed with no value.
   */
  sectionComplete(sectionId: string): boolean {
    const fields = this.journey.fields.filter((f) => f.section === sectionId && this.form.applies(f.id));
    if (!fields.length) return false;
    return fields.every((f) => {
      const state = this.form.get(f.id)?.state;
      return state === "confirmed" || state === "submitted";
    });
  }

  get consent(): boolean {
    return this.consentAt !== null;
  }

  get durationSeconds(): number {
    return Math.round((Date.now() - this.startedAt) / 1000);
  }

  /**
   * The next field to ask for: the first applicable, unfilled field in journey
   * order. Conditionals that do not apply are skipped, and fields the customer
   * volunteered early are already captured, so they fall through to confirmation.
   */
  nextField(): JourneyField | null {
    for (let i = this.cursor; i < this.journey.fields.length; i++) {
      const field = this.journey.fields[i] as JourneyField;
      if (!this.form.applies(field.id)) continue;
      const state = this.form.get(field.id)?.state;
      if (state === "confirmed" || state === "submitted" || state === "redacted") continue;
      this.cursor = i;
      return field;
    }
    return null;
  }

  fieldById(id: string): JourneyField | undefined {
    return this.journey.fields.find((f) => f.id === id);
  }

  currentSection(): string | null {
    return this.nextField()?.section ?? null;
  }

  /** Renders a script line, substituting the lead's and the form's values. */
  render(template: string, extra: Record<string, string> = {}): string {
    const vars: Record<string, string> = {
      first_name: this.lead.first_name,
      full_name: this.lead.full_name,
      plan_name: this.lead.plan_name ?? "the plan you were looking at",
      when: this.lead.started_at,
      email: String(this.form.get("email")?.value ?? "your email"),
      summary: this.reviewSummary(),
      ...extra,
    };
    return template.replace(/\{(\w+)\}/g, (match, key: string) => vars[key] ?? match);
  }

  /**
   * The review read-back.
   *
   * Spoken to a person at the end of a three-minute call, so it is a sentence
   * rather than a dump of every stored value. Bare booleans are the problem: a
   * list containing "yes, no, no" tells the customer nothing, so they are spoken
   * with their label ("no concession") and dropped when they are false and
   * uninteresting. The phone number is skipped because it was confirmed a minute
   * earlier and reading digits back twice is what makes these calls feel long.
   */
  reviewSummary(): string {
    const parts: string[] = [];

    for (const field of this.journey.fields) {
      if (!field.required || !this.form.applies(field.id)) continue;
      if (field.id === "phone") continue;

      const value = this.form.get(field.id)?.value;
      if (value === null || value === undefined || value === "") continue;

      if (field.type === "bool") {
        // "no life support" is worth saying; "yes account holder" is not.
        if (value === true && field.id !== "account_holder") parts.push(field.label.toLowerCase());
        if (value === false) parts.push(`no ${field.label.toLowerCase()}`);
        continue;
      }
      // The plan id is what the payload needs; the plan name is what the customer
      // recognises. Reading "PLAN-EN-0331" back to someone is not a confirmation.
      if (field.id === "plan_id" && this.lead.plan_name) {
        parts.push(this.lead.plan_name);
        continue;
      }
      parts.push(speakableValue(field, value));
    }

    return parts.join(", ");
  }

  /**
   * Short acknowledgements played while the model is still thinking.
   *
   * Rotated rather than fixed, because hearing the identical "Got it." after every
   * single answer is its own kind of robotic. Pre-rendered like every other fixed
   * line, so they cost nothing to play.
   */
  static readonly FILLERS = ["Got it.", "Right.", "Okay.", "Thanks."];

  /** Every fixed line this call can speak, for pre-rendering at boot. */
  static fixedLines(journey: Journey): string[] {
    return [
      ...Object.values(journey.scripts),
      ...journey.sections.map((s) => s.intro),
      ...JourneyState.FILLERS,
      "Sorry, are you still there?",
      "Sorry, I didn't catch that.",
      "I'll let you go for now. Thanks for your time.",
    ];
  }
}

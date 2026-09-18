import type { CallOutcome, Journey, JourneyField, Lead } from "@recall/shared";
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
  /** Field awaiting a yes/no on its read-back. */
  awaitingConfirm: string | null = null;
  /** Agreed callback window, when the customer asked to be rung later. */
  callbackWindow: string | null = null;

  private cursor = 0;

  constructor(
    readonly callId: string,
    readonly journey: Journey,
    readonly lead: Lead
  ) {
    this.form = new Form(journey, callId);
    this.form.applyLead(lead);
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
      "I'll let you go for now. Thanks for your time.",
    ];
  }
}

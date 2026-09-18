import type { CallOutcome, Journey, JourneyField, Lead } from "@recall/shared";
import { Form } from "./fact-bus.js";
import { newDetectorState, type DetectorState } from "./escalation.js";
import type { Transport } from "./transport.js";

/**
 * The slot-filling dialogue manager.
 *
 * Replaces buildin-hours' negotiation core entirely. The call is a state machine
 * over the journey's sections; scripts are the source of truth for what gets asked,
 * and the model only rephrases acknowledgements and clarifications - never what
 * data is sought.
 *
 *   dnc -> opener -> consent -> section* -> review -> submit -> close
 *                       |          |
 *                       |          +-> handoff   (escalation signal)
 *                       +-> decline / callback
 *
 * The consent gate is enforced here rather than in a prompt. No field state can be
 * entered until consent is true, so no script and no model output can bypass it -
 * which is the point of the Guardrails criterion.
 */

export type DialogueState =
  | "dnc"
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

export type DialogueContext = {
  callId: string;
  journey: Journey;
  lead: Lead;
  form: Form;
  transport: Transport;
  detector: DetectorState;
};

const TERMINAL: DialogueState[] = ["ended"];

/**
 * Transitions the state machine allows. Anything not listed is a bug, and throwing
 * on it is how a consent bypass shows up in a test rather than on stage.
 */
const ALLOWED: Record<DialogueState, DialogueState[]> = {
  dnc: ["opener", "ended"],
  opener: ["consent", "ended"],
  consent: ["section", "decline", "callback", "handoff", "ended"],
  section: ["section", "review", "handoff", "decline", "callback", "ended"],
  review: ["submit", "section", "handoff", "ended"],
  submit: ["close", "review", "ended"],
  close: ["ended"],
  decline: ["close", "ended"],
  callback: ["close", "ended"],
  handoff: ["ended"],
  ended: [],
};

export class Dialogue {
  private _state: DialogueState = "dnc";
  private _consent = false;
  private _cursor = 0;
  readonly startedAt = Date.now();
  outcome: CallOutcome | null = null;

  constructor(readonly ctx: DialogueContext) {}

  get state(): DialogueState {
    return this._state;
  }

  get consent(): boolean {
    return this._consent;
  }

  get done(): boolean {
    return TERMINAL.includes(this._state);
  }

  get durationSeconds(): number {
    return Math.round((Date.now() - this.startedAt) / 1000);
  }

  /**
   * The consent gate.
   *
   * Entering `section` without consent throws rather than being coerced, because a
   * silent coercion is indistinguishable from the bug it is hiding.
   */
  transition(next: DialogueState): void {
    if (!ALLOWED[this._state].includes(next)) {
      throw new Error(`illegal dialogue transition: ${this._state} -> ${next}`);
    }
    if (next === "section" && !this._consent) {
      throw new Error("consent gate: cannot enter a field state before consent is given");
    }
    this._state = next;
  }

  grantConsent(): void {
    if (this._state !== "consent") {
      throw new Error(`consent can only be granted in the consent state, not ${this._state}`);
    }
    this._consent = true;
  }

  /**
   * The next field to ask for: the first applicable, unfilled field in journey
   * order. Conditionals that do not apply are skipped, and fields the customer
   * volunteered early are already captured so they fall through to confirmation.
   */
  nextField(): JourneyField | null {
    const { journey, form } = this.ctx;
    for (let i = this._cursor; i < journey.fields.length; i++) {
      const field = journey.fields[i] as JourneyField;
      if (!form.applies(field.id)) continue;
      const state = form.get(field.id)?.state;
      if (state === "confirmed" || state === "submitted" || state === "redacted") continue;
      this._cursor = i;
      return field;
    }
    return null;
  }

  currentSection(): string | null {
    const field = this.nextField();
    return field ? field.section : null;
  }

  /** Renders a script line, substituting the lead's and the form's values. */
  render(template: string, extra: Record<string, string> = {}): string {
    const { lead, form } = this.ctx;
    const vars: Record<string, string> = {
      first_name: lead.first_name,
      full_name: lead.full_name,
      plan_name: lead.plan_name ?? "the plan you were looking at",
      when: lead.started_at,
      email: String(form.get("email")?.value ?? "your email"),
      ...extra,
    };
    return template.replace(/\{(\w+)\}/g, (match, key: string) => vars[key] ?? match);
  }

  /** One-line read-back of the confirmed form, for the review gate. */
  reviewSummary(): string {
    const { journey, form } = this.ctx;
    return journey.fields
      .filter((f) => f.required && form.applies(f.id))
      .map((f) => form.get(f.id)?.value)
      .filter((v) => v !== null && v !== undefined && v !== "")
      .join(", ");
  }
}

export function newDialogue(
  ctx: Omit<DialogueContext, "form" | "detector"> & { form?: Form }
): Dialogue {
  const form = ctx.form ?? new Form(ctx.journey, ctx.callId);
  form.applyLead(ctx.lead);
  return new Dialogue({ ...ctx, form, detector: newDetectorState() });
}

/**
 * Drives one customer turn: extract, detect, decide, speak.
 *
 * Build block 0:15-1:30. The pieces it composes - extract(), detect(), decide(),
 * the Form transitions and the script templates - are all in place and typed, so
 * this is assembly rather than design.
 */
export async function runTurn(_dialogue: Dialogue, _utterance: string, _confidence: number | null): Promise<void> {
  throw new Error("engine/dialogue.ts: turn loop not implemented yet (build block 0:15-1:30)");
}

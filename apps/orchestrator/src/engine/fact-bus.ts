import { EventEmitter } from "node:events";
import type { FieldState, FieldValue, FormField, FormState, Journey, Lead } from "@recall/shared";

/**
 * The form.
 *
 * buildin-hours called this the fact bus, and the pub/sub shape carries over, but
 * the model does not: that bus was built around a hero metric, leverage lines and
 * dedup keys, all of which are negotiation concepts. Here every fact is a journey
 * field moving through a lifecycle, and the console renders that lifecycle as
 * colour. The thing worth preserving is the discipline, which is that a value is
 * never written without the evidence span and confidence it came from.
 *
 * The state machine:
 *
 *   empty -> asking -> captured -> confirmed -> submitted
 *              ^   \         |
 *              |    +--------+------> confirmed   (confirm mode "none")
 *              +-------------+  (read-back rejected, or validation failed)
 *
 *   prefilled -> confirmed      (carried in on the lead, confirmed in one line)
 *   any       -> redacted       (sensitive data intercepted)
 *
 * Illegal transitions throw rather than being silently coerced: a field that
 * reaches the payload without passing through `confirmed` is the exact failure
 * the audit trail exists to rule out.
 */

const ALLOWED: Record<FieldState, FieldState[]> = {
  // A field can be filled without ever being asked, and both routes matter here:
  // the customer volunteering "42 Wattle Street, Parramatta 2150" fills suburb and
  // postcode while street was the question, and state is inferred from the
  // postcode rather than asked at all. Both are the efficiency number in action.
  empty: ["asking", "prefilled", "captured", "confirmed", "redacted"],
  prefilled: ["asking", "confirmed", "captured", "redacted"],
  // asking -> confirmed is legitimate and common: a field with confirm "none"
  // has no read-back to wait for, so every closed yes/no answer lands here.
  asking: ["captured", "confirmed", "asking", "empty", "redacted"],
  captured: ["confirmed", "asking", "empty", "redacted"],
  confirmed: ["submitted", "asking", "redacted"],
  submitted: ["redacted"],
  redacted: [],
};

export type FormEvent = {
  field: string;
  before: FieldState;
  after: FormField;
};

export class Form extends EventEmitter {
  private fields = new Map<string, FormField>();

  constructor(
    private journey: Journey,
    readonly callId: string
  ) {
    super();
    for (const field of journey.fields) {
      this.fields.set(field.id, {
        id: field.id,
        state: "empty",
        value: null,
        confidence: null,
        evidence: null,
        attempts: 0,
        updated_at: Date.now(),
      });
    }
  }

  /**
   * Loads what the customer already gave the web journey before dropping out.
   *
   * These land as `prefilled`, not `confirmed`: the agent confirms them in one
   * sentence rather than re-asking, which is the difference the efficiency number
   * is measuring, but nothing reaches the payload unconfirmed.
   */
  applyLead(lead: Lead): void {
    for (const [id, value] of Object.entries(lead.prefill)) {
      if (!this.fields.has(id)) continue;
      this.set(id, { state: "prefilled", value, confidence: null, evidence: "lead prefill" });
    }
  }

  get(id: string): FormField | undefined {
    return this.fields.get(id);
  }

  snapshot(): FormState {
    return Object.fromEntries([...this.fields].map(([id, f]) => [id, { ...f }]));
  }

  /** Transitions a field and announces it. Throws on an illegal transition. */
  set(
    id: string,
    patch: { state: FieldState; value?: FieldValue; confidence?: number | null; evidence?: string | null }
  ): FormField {
    const current = this.fields.get(id);
    if (!current) throw new Error(`unknown field "${id}"`);

    if (current.state !== patch.state && !ALLOWED[current.state].includes(patch.state)) {
      throw new Error(`illegal transition for "${id}": ${current.state} -> ${patch.state}`);
    }

    const next: FormField = {
      ...current,
      state: patch.state,
      value: patch.value !== undefined ? patch.value : current.value,
      confidence: patch.confidence !== undefined ? patch.confidence : current.confidence,
      evidence: patch.evidence !== undefined ? patch.evidence : current.evidence,
      // A re-ask is the CONFUSION signal's counter, so count entries into `asking`
      // rather than every mutation.
      attempts: patch.state === "asking" ? current.attempts + 1 : current.attempts,
      updated_at: Date.now(),
    };

    this.fields.set(id, next);
    this.emit("change", { field: id, before: current.state, after: next } satisfies FormEvent);
    return next;
  }

  /** Clears a value back to unasked, keeping the attempt count. A "no" on read-back lands here. */
  reject(id: string): FormField {
    return this.set(id, { state: "empty", value: null, confidence: null, evidence: null });
  }

  /** Guardrail 3: intercepted card data never sits in the form or the transcript. */
  redact(id: string): FormField {
    return this.set(id, { state: "redacted", value: null, confidence: null, evidence: "[REDACTED]" });
  }

  /**
   * Whether a conditional field applies right now.
   *
   * `move_in_date` is only asked when the connection is a move-in, so an unasked
   * conditional must not block the review gate.
   */
  applies(fieldId: string): boolean {
    const def = this.journey.fields.find((f) => f.id === fieldId);
    if (!def?.ask_when) return true;
    const dependency = this.fields.get(def.ask_when.field);
    return dependency?.value === def.ask_when.equals;
  }

  /** Required, applicable fields that are not yet confirmed. The review gate's list. */
  missing(): string[] {
    return this.journey.fields
      .filter((f) => f.required && this.applies(f.id))
      .filter((f) => {
        const state = this.fields.get(f.id)?.state;
        return state !== "confirmed" && state !== "submitted";
      })
      .map((f) => f.id);
  }

  complete(): boolean {
    return this.missing().length === 0;
  }

  /**
   * The 25% criterion: fields captured without an operator typing anything.
   *
   * Prefilled fields are excluded - they came from the web journey, so counting
   * them would inflate the number the demo says out loud.
   */
  handsFree(): { captured: number; total: number } {
    const applicable = this.journey.fields.filter((f) => this.applies(f.id));
    const captured = applicable.filter((f) => {
      const field = this.fields.get(f.id);
      if (!field) return false;
      const done = field.state === "confirmed" || field.state === "submitted";
      return done && field.evidence !== "lead prefill";
    });
    return { captured: captured.length, total: applicable.length };
  }
}

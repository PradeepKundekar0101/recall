import type { FormField, FormState, Lead } from "@recall/shared";

/**
 * Journey field ids to the sandbox's payload keys.
 *
 * This is the only file that changes when CIMET's real schema lands, which is the
 * whole reason the journey config, the console and the payload are all generated
 * from one field list rather than hand-maintained in three places.
 */

export type SandboxPayload = {
  lead_id: string;
  vertical: string;
  channel: string;
  consent: { recorded: boolean; ts: string };
  customer: Record<string, unknown>;
  supply: Record<string, unknown>;
  connection: Record<string, unknown>;
  eligibility: Record<string, unknown>;
  plan_id: unknown;
  /**
   * Our addition: per-field confidence and confirmation. If CIMET's schema rejects
   * unknown keys this is dropped from the POST and kept in our log only - it is the
   * answer to "what if it captured something wrong?", so it is worth keeping
   * somewhere even when it cannot be sent.
   */
  provenance: Record<string, { confidence: number | null; confirmed: boolean; ts: number }>;
};

function value(form: FormState, id: string): unknown {
  return form[id]?.value ?? null;
}

export function buildPayload(opts: {
  lead: Lead;
  form: FormState;
  consentAt: number;
}): SandboxPayload {
  const { lead, form } = opts;

  const provenance: SandboxPayload["provenance"] = {};
  for (const [id, field] of Object.entries(form)) {
    if (field.state !== "confirmed" && field.state !== "submitted") continue;
    provenance[id] = {
      confidence: field.confidence,
      confirmed: true,
      ts: field.updated_at,
    };
  }

  return {
    lead_id: lead.id,
    vertical: "energy",
    channel: "ai_voice_recovery",
    consent: { recorded: true, ts: new Date(opts.consentAt).toISOString() },
    customer: {
      full_name: value(form, "full_name"),
      dob: value(form, "dob"),
      email: value(form, "email"),
      phone: value(form, "phone"),
      account_holder: value(form, "account_holder"),
    },
    supply: {
      street: value(form, "street"),
      suburb: value(form, "suburb"),
      state: value(form, "state"),
      postcode: value(form, "postcode"),
      fuel_type: value(form, "fuel_type"),
      nmi: value(form, "nmi"),
    },
    connection: {
      type: value(form, "connection_type"),
      move_in_date: value(form, "move_in_date"),
    },
    eligibility: {
      concession: value(form, "concession"),
      concession_type: value(form, "concession_type"),
      life_support: value(form, "life_support"),
    },
    plan_id: value(form, "plan_id"),
    provenance,
  };
}

/**
 * One field's save body.
 *
 * A field is saved the moment it is confirmed, so this is the unit the sandbox
 * sees most often. It carries the provenance beside the value rather than in a
 * separate block: the whole point of saving per field is that the receiving
 * system learns *when* and *how sure* as it goes, not at the end.
 *
 * `source` is derived rather than stored. A field with no evidence span was never
 * heard on this call - it came in on the lead from the web journey, and the read-back
 * only confirmed it.
 */
export type FieldSave = {
  lead_id: string;
  field: string;
  section: string;
  value: unknown;
  confidence: number | null;
  confirmed: boolean;
  source: "voice" | "web_journey";
  evidence: string | null;
  captured_at: string;
};

export function buildFieldSave(opts: {
  lead: Lead;
  field: FormField;
  section: string;
}): FieldSave {
  const { lead, field } = opts;
  return {
    lead_id: lead.id,
    field: field.id,
    section: opts.section,
    value: field.value,
    confidence: field.confidence,
    confirmed: true,
    source: field.evidence ? "voice" : "web_journey",
    evidence: field.evidence,
    captured_at: new Date(field.updated_at).toISOString(),
  };
}

/** Which payload section a journey section maps to. */
export const SECTION_TO_STEP: Record<string, string> = {
  identity: "customer",
  contact: "customer",
  supply: "supply",
  connection: "connection",
  eligibility: "eligibility",
  plan: "plan",
};

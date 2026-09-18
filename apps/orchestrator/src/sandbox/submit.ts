import type { FormState, Lead } from "@recall/shared";
import { env } from "../env.js";
import { log } from "../log.js";
import { buildPayload, SECTION_TO_STEP, type SandboxPayload } from "./mapping.js";

/**
 * Sandbox submission.
 *
 * Incremental, then final: each confirmed section is PUT as a partial step,
 * mirroring the multi-step web journey, and a final POST marks completion. If the
 * sandbox turns out to be a single final POST, the incremental calls become no-ops.
 *
 * Incremental is the safer shape for this product: a call that escalates after the
 * supply section has already saved identity, contact and supply, so the human picks
 * up a journey that is genuinely three sections further along.
 */

export type SubmitResult = {
  step: string;
  status: number;
  body: unknown;
};

function headers(): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (env.sandboxAuthHeader) {
    const [name, ...rest] = env.sandboxAuthHeader.split(":");
    if (name && rest.length) h[name.trim()] = rest.join(":").trim();
  }
  return h;
}

export async function submitSection(opts: {
  lead: Lead;
  form: FormState;
  section: string;
  consentAt: number;
}): Promise<SubmitResult> {
  const step = SECTION_TO_STEP[opts.section] ?? opts.section;
  const payload = buildPayload(opts);
  const body = (payload as unknown as Record<string, unknown>)[step] ?? {};

  const response = await fetch(`${env.sandboxUrl}/journeys/${opts.lead.id}/steps/${step}`, {
    method: "PUT",
    headers: headers(),
    body: JSON.stringify({ lead_id: opts.lead.id, step, data: body }),
  });
  const parsed = await readBody(response);
  log.info(`sandbox PUT ${step} -> ${response.status}`);
  return { step, status: response.status, body: parsed };
}

/**
 * The final POST.
 *
 * `validate()` is the gate: the engine refuses to send unless every required,
 * applicable field is confirmed. The review read-back is the last human gate before
 * this one.
 */
export async function submitFinal(opts: {
  lead: Lead;
  form: FormState;
  consentAt: number;
  requiredFields: string[];
}): Promise<SubmitResult> {
  const missing = validate(opts.form, opts.requiredFields);
  if (missing.length) {
    throw new Error(`refusing to submit: ${missing.length} required field(s) unconfirmed: ${missing.join(", ")}`);
  }

  const payload = buildPayload(opts);
  const response = await fetch(`${env.sandboxUrl}/journeys`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(payload),
  });
  const parsed = await readBody(response);
  log.info(`sandbox POST final -> ${response.status}`);
  return { step: "final", status: response.status, body: parsed };
}

/** Required fields that are not confirmed. Empty means safe to send. */
export function validate(form: FormState, requiredFields: string[]): string[] {
  return requiredFields.filter((id) => {
    const state = form[id]?.state;
    return state !== "confirmed" && state !== "submitted";
  });
}

export function previewPayload(opts: { lead: Lead; form: FormState; consentAt: number }): SandboxPayload {
  return buildPayload(opts);
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

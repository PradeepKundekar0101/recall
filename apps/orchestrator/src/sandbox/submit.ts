import type { FormField, FormState, Lead } from "@recall/shared";
import { env } from "../env.js";
import { log } from "../log.js";
import { buildFieldSave, buildPayload, type SandboxPayload } from "./mapping.js";

/**
 * Sandbox submission.
 *
 * Incremental, then final: every field is PUT the moment it is confirmed, and a
 * final POST marks the journey complete.
 *
 * Per field rather than per section because that is the unit the customer actually
 * confirms. A call that escalates halfway through Supply has already saved the
 * street it just heard, so the human picks up a journey that is genuinely as far
 * along as the conversation was - not one rounded down to the last whole section.
 *
 * Every call returns what went over the wire and what came back, so the console
 * can show the operator the request and the response rather than a claim that a
 * save happened.
 */

export type SubmitResult = {
  /** The field id for an incremental save, `"final"` for the closing POST. */
  step: string;
  method: "PUT" | "POST";
  /** Path only, so the console shows `/journeys/L-1042/fields/dob` rather than a hostname. */
  path: string;
  request: unknown;
  status: number;
  body: unknown;
  ms: number;
  /** Set when the request never reached a server. `status` is 0 in that case. */
  error?: string;
};

function headers(): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (env.sandboxAuthHeader) {
    const [name, ...rest] = env.sandboxAuthHeader.split(":");
    if (name && rest.length) h[name.trim()] = rest.join(":").trim();
  }
  return h;
}

/**
 * One request, timed, with the failure folded into the result rather than thrown.
 *
 * A save that could not be made is still something the operator needs to see, so a
 * network error comes back as a result with status 0 instead of an exception that
 * only reaches the log.
 */
async function send(opts: {
  step: string;
  method: "PUT" | "POST";
  path: string;
  request: unknown;
}): Promise<SubmitResult> {
  const startedAt = Date.now();
  try {
    const response = await fetch(`${env.sandboxUrl}${opts.path}`, {
      method: opts.method,
      headers: headers(),
      body: JSON.stringify(opts.request),
    });
    const body = await readBody(response);
    const ms = Date.now() - startedAt;
    log.info(`sandbox ${opts.method} ${opts.path} -> ${response.status} (${ms} ms)`);
    return { ...opts, status: response.status, body, ms };
  } catch (err) {
    const ms = Date.now() - startedAt;
    const error = err instanceof Error ? err.message : String(err);
    log.warn(`sandbox ${opts.method} ${opts.path} failed after ${ms} ms: ${error}`);
    return { ...opts, status: 0, body: null, ms, error };
  }
}

/** Saves one confirmed field. Called once per field, the instant it turns green. */
export async function submitField(opts: {
  lead: Lead;
  field: FormField;
  section: string;
}): Promise<SubmitResult> {
  return send({
    step: opts.field.id,
    method: "PUT",
    path: `/journeys/${opts.lead.id}/fields/${opts.field.id}`,
    request: buildFieldSave(opts),
  });
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

  return send({
    step: "final",
    method: "POST",
    path: "/journeys",
    request: buildPayload(opts),
  });
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

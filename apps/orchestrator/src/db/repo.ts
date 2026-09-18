import type { CallEvent, CallOutcome, CallStatus, Lead } from "@recall/shared";
import { sb } from "./supabase.js";
import { log } from "../log.js";

/**
 * The audit trail.
 *
 * Every write is best-effort: a Supabase outage must never take the call down,
 * because the call is the demo and the log is the paperwork. Failures are warned
 * about once and swallowed.
 */

export async function openCall(opts: {
  callId: string;
  lead: Lead;
  journeyId: string;
  testRun: boolean;
}): Promise<void> {
  const client = sb();
  if (!client) return;
  const { error } = await client.from("calls").insert({
    id: opts.callId,
    lead_id: opts.lead.id,
    phone: opts.lead.phone,
    journey_id: opts.journeyId,
    status: "queued" satisfies CallStatus,
    test_run: opts.testRun,
  });
  if (error) log.warn(`repo.openCall: ${error.message}`);
}

export async function setStatus(callId: string, status: CallStatus): Promise<void> {
  const client = sb();
  if (!client) return;
  const { error } = await client.from("calls").update({ status }).eq("id", callId);
  if (error) log.warn(`repo.setStatus: ${error.message}`);
}

export async function closeCall(opts: {
  callId: string;
  outcome: CallOutcome;
  handoffReason?: string;
  durationS: number;
  fieldsHandsFree: number;
  fieldsTotal: number;
  recordingUrl?: string;
  consentAt?: number;
}): Promise<void> {
  const client = sb();
  if (!client) return;
  const { error } = await client
    .from("calls")
    .update({
      status: "ended" satisfies CallStatus,
      outcome: opts.outcome,
      handoff_reason: opts.handoffReason ?? null,
      ended_at: new Date().toISOString(),
      duration_s: opts.durationS,
      fields_hands_free: opts.fieldsHandsFree,
      fields_total: opts.fieldsTotal,
      recording_url: opts.recordingUrl ?? null,
      consent_at: opts.consentAt ? new Date(opts.consentAt).toISOString() : null,
    })
    .eq("id", opts.callId);
  if (error) log.warn(`repo.closeCall: ${error.message}`);
}

/** Mirrors an SSE event into the audit log. Called for every event on the bus. */
export async function recordEvent(event: CallEvent): Promise<void> {
  const client = sb();
  if (!client) return;
  const { call_id, ts, type, ...payload } = event as CallEvent & Record<string, unknown>;
  const { error } = await client.from("call_events").insert({
    call_id,
    at: new Date(ts).toISOString(),
    type,
    payload,
  });
  if (error) log.warn(`repo.recordEvent: ${error.message}`);
}

export async function recordSubmission(opts: {
  callId: string;
  step: string;
  statusCode: number;
  request: unknown;
  response: unknown;
}): Promise<void> {
  const client = sb();
  if (!client) return;
  const { error } = await client.from("submissions").insert({
    call_id: opts.callId,
    step: opts.step,
    status_code: opts.statusCode,
    request: opts.request,
    response: opts.response,
  });
  if (error) log.warn(`repo.recordSubmission: ${error.message}`);
}

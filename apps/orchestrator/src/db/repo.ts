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
  /** False only when a phone actually rang: pstn transport with real voice. */
  simulated: boolean;
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
    simulated: opts.simulated,
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
/**
 * Closes calls left open by an orchestrator that is no longer here.
 *
 * A call lives in one process: its transport, its engine and its silence timers
 * all die with it. A row still marked live on boot therefore belongs to a
 * process that is gone - most often `tsx watch` restarting on a source edit
 * while a call was up - and nothing will ever close it. The console then reads
 * that row back and shows a call that has been live for hours.
 *
 * Only ever called once this process owns the port. A second orchestrator that
 * loses the bind must not close the calls the first one is still running.
 */
export async function closeOrphanedCalls(): Promise<string[]> {
  const client = sb();
  if (!client) return [];
  const open: CallStatus[] = ["queued", "dialling", "answered", "live", "handoff"];
  const { data, error } = await client
    .from("calls")
    .update({
      status: "ended" satisfies CallStatus,
      outcome: "disconnected" satisfies CallOutcome,
      ended_at: new Date().toISOString(),
    })
    .in("status", open)
    .select("id");
  if (error) {
    log.warn(`repo.closeOrphanedCalls: ${error.message}`);
    return [];
  }
  return (data ?? []).map((row) => String(row.id));
}

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

/** A `calls` row, as the history list and the replay need it. */
export type CallRow = {
  id: string;
  lead_id: string;
  status: CallStatus;
  outcome: CallOutcome | null;
  handoff_reason: string | null;
  started_at: string;
  ended_at: string | null;
  duration_s: number | null;
  fields_hands_free: number | null;
  fields_total: number | null;
  recording_url: string | null;
  test_run: boolean;
  simulated: boolean;
};

const CALL_COLUMNS =
  "id, lead_id, status, outcome, handoff_reason, started_at, ended_at, duration_s, fields_hands_free, fields_total, recording_url, test_run, simulated";

/** Only a real id reaches Postgres: a uuid column rejects anything else with an error, not an empty result. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Newest first. */
export async function listCalls(limit = 100): Promise<CallRow[]> {
  const client = sb();
  if (!client) return [];
  const { data, error } = await client
    .from("calls")
    .select(CALL_COLUMNS)
    .order("started_at", { ascending: false })
    .limit(limit);
  if (error) {
    log.warn(`repo.listCalls: ${error.message}`);
    return [];
  }
  return (data ?? []) as CallRow[];
}

export async function getCallRow(callId: string): Promise<CallRow | null> {
  const client = sb();
  if (!client || !UUID.test(callId)) return null;
  const { data, error } = await client.from("calls").select(CALL_COLUMNS).eq("id", callId).maybeSingle();
  if (error) {
    log.warn(`repo.getCallRow: ${error.message}`);
    return null;
  }
  return (data as CallRow | null) ?? null;
}

/**
 * Everything the console was shown during a call, in order, rebuilt into the
 * events it was shown as. This is what lets a call be opened again after the
 * orchestrator that ran it is gone.
 */
export async function callEvents(callId: string): Promise<CallEvent[]> {
  const client = sb();
  if (!client || !UUID.test(callId)) return [];
  const { data, error } = await client
    .from("call_events")
    .select("call_id, at, type, payload")
    .eq("call_id", callId)
    .order("at", { ascending: true })
    .order("id", { ascending: true });
  if (error) {
    log.warn(`repo.callEvents: ${error.message}`);
    return [];
  }
  return (data ?? []).map(
    (row) =>
      ({
        ...(row.payload as Record<string, unknown>),
        call_id: String(row.call_id),
        ts: Date.parse(String(row.at)),
        type: String(row.type),
      }) as CallEvent
  );
}

/**
 * Twilio's recording callback usually lands after the call has ended, by which
 * point closeCall has already written the row without it. So the url is written
 * on its own, whenever it arrives.
 */
export async function setRecording(callId: string, url: string): Promise<void> {
  const client = sb();
  if (!client || !UUID.test(callId)) return;
  const { error } = await client.from("calls").update({ recording_url: url }).eq("id", callId);
  if (error) log.warn(`repo.setRecording: ${error.message}`);
}

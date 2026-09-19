import { Router } from "express";
import { randomUUID } from "node:crypto";
import { bus } from "../events.js";
import { env, has, bootReport } from "../env.js";
import { log } from "../log.js";
import { loadJourney, requiredFields } from "../journey/index.js";
import { loadLeads, leadById } from "../leads/index.js";
import { applySetup, parseSetup } from "../leads/setup.js";
import { addToDnc, canDial, dncList, optOutList, onDncRegister } from "../policy.js";
import { liveTwilioTransports, escapeXml } from "../transports/twilio.js";
import { latencyMedian } from "../voice/llm.js";
import { startCall, getCall } from "../calls.js";
import { DialogueEngine } from "../engine/dialogue.js";
import { cachedLineCount } from "../voice/tts.js";
import { Readable } from "node:stream";
import type { CallEvent, CallSummary } from "@recall/shared";
import { callEvents, getCallRow, listCalls, setRecording, type CallRow } from "../db/repo.js";
import { loadAnalytics } from "../analytics/query.js";
import type { AnalyticsSource, AnalyticsWindow } from "../analytics/types.js";

export const api = Router();

/**
 * The orchestrator's HTTP surface.
 *
 * Four groups: health and config the console reads once, the lead list and the
 * dial button, the SSE stream the console lives on, and Twilio's webhooks.
 */

api.get("/health", (_req, res) => {
  res.json({
    ok: true,
    transport: env.transport,
    call_mode: env.callMode,
    mock_voice: env.mockVoice,
    providers: { stt: env.sttProvider, llm: env.llmProvider },
    integrations: {
      stt: has.stt(),
      tts: has.tts(),
      llm: has.llm(),
      twilio: has.twilio(),
      supabase: has.supabase(),
      handoff: has.handoff(),
    },
    latency_median_ms: latencyMedian(),
    prerendered_lines: cachedLineCount(),
    boot: bootReport(),
  });
});

/** The console renders its form straight from this, so the two cannot drift. */
api.get("/journey", (_req, res) => {
  try {
    res.json(loadJourney());
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

api.get("/leads", (_req, res) => {
  const leads = loadLeads().map((lead) => ({
    ...lead,
    // Surfaced so the console can grey out the Dial button and show why.
    dial: canDial(lead.phone),
    on_dnc: onDncRegister(lead.phone),
  }));
  res.json({ leads, test_numbers: env.testNumbers });
});

/**
 * The DNC demo: add a lead's number to the register, then press Dial and watch it
 * refuse. The check itself lives in `policy.canDial`, ahead of Twilio.
 */
api.post("/dnc", (req, res) => {
  const phone = String(req.body?.phone ?? "");
  if (!phone) return res.status(400).json({ error: "phone required" });
  addToDnc(phone);
  log.warn(`added ${phone} to the DNC register`);
  res.json({ ok: true, dnc: dncList() });
});

api.get("/policy", (_req, res) => {
  res.json({ dnc: dncList(), opt_out: optOutList(), test_numbers: env.testNumbers });
});

/**
 * Start a call.
 *
 * The guardrail check runs before a call id is even minted, so a refused dial
 * produces a clean 403 the console can render rather than a half-open call.
 */
api.post("/calls", async (req, res) => {
  const leadId = String(req.body?.lead_id ?? "");
  const lead = leadById(leadId);
  if (!lead) return res.status(404).json({ error: `unknown lead ${leadId}` });

  const decision = canDial(lead.phone);
  if (!decision.allowed) {
    log.warn(`dial refused: ${decision.reason}`);
    return res.status(403).json({ error: decision.reason, guardrail: decision.reason.split(":")[0] });
  }

  void randomUUID; // ids are minted inside startCall, alongside the call row

  const journey = loadJourney();
  // What the operator set up on the console: fields seeded or removed, and a
  // brief for how the agent should talk. Refused whole rather than partly
  // applied, so the call never runs on a setup the operator did not see.
  const setup = parseSetup(req.body, journey);
  if (!setup.ok) return res.status(400).json({ error: setup.error });
  const call = await startCall({
    lead: applySetup(lead, setup.setup),
    journey,
    personaId: req.body?.persona,
    agentBrief: setup.setup.agentBrief,
  });
  log.call(call.callId, `dialling ${lead.phone} in ${call.mode} mode over ${env.transport}`);

  // `simulated` is spelled out rather than left to be inferred from
  // transport:"sim". A simulated dial returns a perfectly healthy 201 and rings
  // nothing, which is indistinguishable from a real call that failed to connect
  // unless the response says so plainly.
  res.status(201).json({
    call_id: call.callId,
    mode: call.mode,
    transport: env.transport,
    simulated: env.transport !== "pstn" || env.mockVoice,
    dialled: env.transport === "pstn" && !env.mockVoice ? lead.phone : null,
    ...(env.transport !== "pstn" || env.mockVoice
      ? { note: "No phone was dialled. Set TRANSPORT=pstn and MOCK_VOICE=0 for a real call." }
      : {}),
  });
});

/** Hang up a live call from the console. */
api.post("/calls/:callId/hangup", async (req, res) => {
  const call = getCall(req.params.callId);
  if (!call) return res.status(404).json({ error: "no such live call" });
  await call.finish("incomplete");
  res.json({ ok: true });
});

/**
 * Pull a handoff back, at the operator's request.
 *
 * The window is the bridging line - it plays to the end before the redirect
 * goes out, and it is uninterruptible, so there are several seconds in which
 * this can still be answered. After that the `<Connect><Stream>` has been torn
 * down by the redirect and there is no line left to resume on, which is a 409
 * and an honest sentence rather than a silent no-op.
 */
api.post("/calls/:callId/handoff/cancel", (req, res) => {
  const call = getCall(req.params.callId);
  if (!call) return res.status(404).json({ error: "no such live call" });
  if (!(call.engine instanceof DialogueEngine)) {
    return res.status(400).json({ error: "this call is not running the journey engine" });
  }

  const result = call.engine.cancelHandoff();
  if (!result.ok) return res.status(409).json({ error: result.reason });
  log.call(call.callId, "operator cancelled the handoff");
  res.json({ ok: true });
});

/** The console's whole data path. Replays from the start, so a late tab sees it all. */
api.get("/calls/:callId/events", async (req, res) => {
  const callId = req.params.callId;

  // A call this process never ran - it was run before the last restart - is
  // replayed out of the audit trail first. The stream then stays open on the
  // bus like any other, because things still happen to a finished call:
  // Twilio's recording callback lands a minute after the hangup. A call nobody
  // has heard of is a 404, which the browser's EventSource treats as final
  // rather than something to retry every two seconds.
  const inMemory = getCall(callId) !== undefined || bus.replay(callId).some((e) => e.type === "call.hello");
  let fromAudit: CallEvent[] = [];
  let row: CallRow | null = null;
  if (!inMemory) {
    [row, fromAudit] = await Promise.all([getCallRow(callId), callEvents(callId)]);
    if (!row && fromAudit.length === 0) return res.status(404).json({ error: "no such call" });
  }

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    // nginx and some tunnels buffer SSE into uselessness without this.
    "x-accel-buffering": "no",
  });
  res.write("retry: 2000\n\n");

  const send = (event: unknown) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  if (!inMemory) {
    for (const event of fromAudit) send(event);
    // A row closed without its closing events - an orphan swept on boot, or a
    // restart mid-write - is finished off from the row, so the board never
    // waits for an end that is not coming.
    const last = fromAudit.at(-1);
    const ts = last ? last.ts + 1 : Date.parse(row?.ended_at ?? row?.started_at ?? "") || Date.now();
    if (!fromAudit.some((e) => e.type === "call.status" && e.status === "ended")) {
      send({ call_id: callId, ts, type: "call.status", status: "ended", outcome: row?.outcome ?? "disconnected" });
    }
    if (row?.duration_s != null && !fromAudit.some((e) => e.type === "metrics.update")) {
      send({
        call_id: callId,
        ts,
        type: "metrics.update",
        fields_hands_free: row.fields_hands_free ?? 0,
        fields_total: row.fields_total ?? 0,
        duration_s: row.duration_s,
        manual_baseline_s: 0,
      });
    }
    if (row?.recording_url && !fromAudit.some((e) => e.type === "call.recording")) {
      send({ call_id: callId, ts, type: "call.recording", available: true });
    }
  }

  // Replays whatever the bus holds, then follows the call live. For a call
  // replayed from the audit trail that is at most a late recording notice.
  const unsubscribe = bus.subscribe(callId, send);

  // Comment frames keep the tunnel from reaping an idle stream between turns.
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 15_000);

  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

api.get("/calls/:callId/replay", (req, res) => {
  res.json(bus.replay(req.params.callId));
});

api.get("/journey/required", (_req, res) => {
  res.json(requiredFields(loadJourney()).map((f) => f.id));
});

/**
 * Whisper TwiML, fetched by Twilio when the human answers a transferred call.
 * It plays on their leg only, so the customer never hears it.
 */
api.all("/twilio/whisper", (req, res) => {
  const text = String(req.query.text ?? "Recovery call escalated.");
  res.type("text/xml").send(`<Response><Say voice="Polly.Nicole">${escapeXml(text)}</Say></Response>`);
});

/**
 * What happens when the warm transfer ends, answered or not.
 *
 * The `<Dial>` is the last verb in the document the transfer redirects to, so
 * without an action URL the customer's call falls off the end of its TwiML the
 * moment the Dial finishes. On the seventh journey call the human did not pick
 * up, the Dial ended after a second, and the customer was hung up on in silence
 * - one second after being told a colleague was coming.
 *
 * `completed` means the human took the call and it is over, so there is nothing
 * left to say. Anything else means nobody was reached, and the customer is owed
 * an honest sentence before the line goes down. The escalation packet is
 * already on the human console with the transcript, which is what "we'll call
 * you back" is promising.
 */
api.post("/twilio/handoff-result/:callId", (req, res) => {
  const status = String(req.body?.DialCallStatus ?? "");
  log.call(req.params.callId, `handoff dial ended: ${status || "no status"}`);

  if (status === "completed") return res.type("text/xml").send(`<Response><Hangup/></Response>`);

  return res
    .type("text/xml")
    .send(
      `<Response><Say voice="Polly.Nicole">` +
        `I'm sorry - I couldn't reach a colleague just now. Someone will call you straight back. Thanks for your time.` +
        `</Say><Hangup/></Response>`
    );
});

api.post("/twilio/amd/:callId", (req, res) => {
  const transport = liveTwilioTransports.get(req.params.callId);
  transport?.notifyAmd(String(req.body?.AnsweredBy ?? ""));
  res.sendStatus(204);
});

/**
 * Twilio's status callback.
 *
 * This and the media stream's `stop` message race on every real call, and neither
 * ordering is guaranteed. Both route into the same idempotent finish(), so
 * whichever arrives second is a no-op rather than a double-close.
 */
api.post("/twilio/status/:callId", async (req, res) => {
  const callId = req.params.callId;
  const status = String(req.body?.CallStatus ?? "");
  liveTwilioTransports.get(callId)?.notifyStatus(status);

  if (status === "completed" || status === "failed" || status === "no-answer" || status === "busy") {
    const call = getCall(callId);
    if (call) await call.finish(status === "completed" ? "incomplete" : "no_answer");
  }
  res.sendStatus(204);
});

api.post("/twilio/recording/:callId", (req, res) => {
  const callId = req.params.callId;
  const url = String(req.body?.RecordingUrl ?? "");
  if (url) {
    // This usually lands after the call has ended and its transport is gone, so
    // the url is kept here and in the audit row rather than only on the transport.
    liveTwilioTransports.get(callId)?.notifyRecording(url);
    recordings.set(callId, url);
    void setRecording(callId, url);
    bus.emitEvent(callId, { type: "call.recording", available: true });
  }
  res.sendStatus(204);
});

// ------------------------------------------------------------------ history

/** Recording urls by call, for calls that ended before Twilio's callback arrived. */
const recordings = new Map<string, string>();

/**
 * A call as the history lists it, rebuilt from what the console was shown.
 * Fresher than the audit row for anything this process is still running.
 */
function summaryFromEvents(callId: string, events: CallEvent[]): CallSummary | null {
  const first = events[0];
  if (!first) return null;
  const summary: CallSummary = {
    id: callId,
    lead_id: "",
    lead_name: null,
    status: "queued",
    outcome: null,
    handoff_reason: null,
    started_at: new Date(first.ts).toISOString(),
    ended_at: null,
    duration_s: null,
    fields_hands_free: null,
    fields_total: null,
    has_recording: false,
    test_run: true,
    simulated: true,
    live: getCall(callId) !== undefined,
  };
  for (const event of events) {
    switch (event.type) {
      case "call.hello":
        summary.lead_id = event.lead.id;
        summary.lead_name = event.lead.full_name;
        summary.test_run = event.test_run;
        summary.simulated = event.simulated ?? true;
        break;
      case "call.status":
        summary.status = event.status;
        if (event.outcome) summary.outcome = event.outcome;
        if (event.status === "ended") summary.ended_at = new Date(event.ts).toISOString();
        break;
      case "escalation.handoff":
        summary.handoff_reason = event.reason;
        break;
      case "metrics.update":
        summary.duration_s = event.duration_s;
        summary.fields_hands_free = event.fields_hands_free;
        summary.fields_total = event.fields_total;
        break;
      case "call.recording":
        summary.has_recording = event.available;
        break;
    }
  }
  return summary;
}

function summaryFromRow(row: CallRow): CallSummary {
  return {
    id: row.id,
    lead_id: row.lead_id,
    lead_name: leadById(row.lead_id)?.full_name ?? null,
    status: row.status,
    outcome: row.outcome,
    handoff_reason: (row.handoff_reason as CallSummary["handoff_reason"]) ?? null,
    started_at: row.started_at,
    ended_at: row.ended_at,
    duration_s: row.duration_s,
    fields_hands_free: row.fields_hands_free,
    fields_total: row.fields_total,
    has_recording: Boolean(row.recording_url) || recordings.has(row.id),
    test_run: row.test_run,
    simulated: row.simulated,
    live: getCall(row.id) !== undefined,
  };
}

/**
 * Every call, newest first: the audit table for anything persisted, and this
 * process's own buffer for anything it has run since it booted. The buffer wins
 * for a call in both, because it is the one still moving.
 */
api.get("/calls", async (req, res) => {
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
  const byId = new Map<string, CallSummary>();
  for (const row of await listCalls(limit)) byId.set(row.id, summaryFromRow(row));
  for (const id of bus.ids()) {
    const summary = summaryFromEvents(id, bus.replay(id));
    if (!summary) continue;
    const persisted = byId.get(id);
    if (persisted?.has_recording) summary.has_recording = true;
    if (persisted && !summary.lead_name) summary.lead_name = persisted.lead_name;
    byId.set(id, summary);
  }
  const calls = [...byId.values()]
    .sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at))
    .slice(0, limit);
  res.json({ calls });
});

const WINDOWS: AnalyticsWindow[] = ["24h", "7d", "30d", "all"];

/**
 * The whole analytics dashboard in one response.
 *
 * One request rather than four, because the page is one screen: a single
 * loading state and no waterfall. Everything is computed from the audit trail,
 * so this endpoint is read-only and cannot affect a call.
 */
api.get("/analytics", async (req, res) => {
  const windowParam = String(req.query.window ?? "7d");
  const window = (WINDOWS as string[]).includes(windowParam) ? (windowParam as AnalyticsWindow) : "7d";
  const source: AnalyticsSource = String(req.query.source ?? "dialled") === "all" ? "all" : "dialled";

  try {
    res.json(await loadAnalytics(window, source));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // 503 rather than 500: the orchestrator is fine, its audit database is not,
    // and the page says exactly that instead of rendering zeroes that read as
    // real measurements.
    res.status(503).json({ error: `analytics unavailable: ${message}` });
  }
});

/**
 * The audio, streamed through from Twilio with the account's credentials, so
 * the browser never holds them. Range requests pass straight through, which is
 * what lets the player seek.
 */
api.get("/calls/:callId/recording", async (req, res) => {
  const callId = req.params.callId;
  const url =
    liveTwilioTransports.get(callId)?.recordingUrl ?? recordings.get(callId) ?? (await getCallRow(callId))?.recording_url;
  if (!url) return res.status(404).json({ error: "no recording for this call" });
  if (!env.twilioSid || !env.twilioToken) return res.status(501).json({ error: "Twilio is not configured" });

  const headers: Record<string, string> = {
    authorization: `Basic ${Buffer.from(`${env.twilioSid}:${env.twilioToken}`).toString("base64")}`,
  };
  const range = req.headers.range;
  if (typeof range === "string") headers.range = range;

  let upstream: Response;
  try {
    upstream = await fetch(`${url}.mp3`, { headers });
  } catch (err) {
    return res.status(502).json({ error: `could not reach Twilio: ${err instanceof Error ? err.message : String(err)}` });
  }
  if (!upstream.ok && upstream.status !== 206) {
    return res.status(upstream.status === 404 ? 404 : 502).json({ error: `Twilio answered ${upstream.status}` });
  }

  res.status(upstream.status);
  for (const name of ["content-type", "content-length", "content-range", "accept-ranges"]) {
    const value = upstream.headers.get(name);
    if (value) res.setHeader(name, value);
  }
  res.setHeader("cache-control", "private, no-store");
  if (!upstream.body) return res.end();
  Readable.fromWeb(upstream.body as never).pipe(res);
});

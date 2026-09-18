import { Router } from "express";
import { randomUUID } from "node:crypto";
import { bus } from "../events.js";
import { env, has, bootReport } from "../env.js";
import { log } from "../log.js";
import { loadJourney, requiredFields } from "../journey/index.js";
import { loadLeads, leadById } from "../leads/index.js";
import { addToDnc, canDial, dncList, optOutList, onDncRegister } from "../policy.js";
import { liveTwilioTransports, escapeXml } from "../transports/twilio.js";
import { latencyMedian } from "../voice/llm.js";

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
    mock_voice: env.mockVoice,
    integrations: {
      deepgram: has.deepgram(),
      elevenlabs: has.elevenLabs(),
      llm: has.llm(),
      twilio: has.twilio(),
      supabase: has.supabase(),
      handoff: has.handoff(),
    },
    latency_median_ms: latencyMedian(),
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
api.post("/calls", (req, res) => {
  const leadId = String(req.body?.lead_id ?? "");
  const lead = leadById(leadId);
  if (!lead) return res.status(404).json({ error: `unknown lead ${leadId}` });

  const decision = canDial(lead.phone);
  if (!decision.allowed) {
    log.warn(`dial refused: ${decision.reason}`);
    return res.status(403).json({ error: decision.reason, guardrail: decision.reason.split(":")[0] });
  }

  const callId = randomUUID();
  // Build block 0:15-1:30 wires the dialogue engine in here. The route, the
  // guardrail gate and the event stream are already the shape it needs.
  res.status(501).json({
    call_id: callId,
    error: "call orchestration not implemented yet (build block 0:15-1:30)",
  });
});

/** The console's whole data path. Replays from the start, so a late tab sees it all. */
api.get("/calls/:callId/events", (req, res) => {
  const callId = req.params.callId;
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    // nginx and some tunnels buffer SSE into uselessness without this.
    "x-accel-buffering": "no",
  });
  res.write("retry: 2000\n\n");

  const unsubscribe = bus.subscribe(callId, (event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  });

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

api.post("/twilio/amd/:callId", (req, res) => {
  const transport = liveTwilioTransports.get(req.params.callId);
  if (req.body?.AnsweredBy?.startsWith("machine")) transport?.notifyVoicemail();
  res.sendStatus(204);
});

api.post("/twilio/status/:callId", (req, res) => {
  liveTwilioTransports.get(req.params.callId)?.notifyStatus(String(req.body?.CallStatus ?? ""));
  res.sendStatus(204);
});

api.post("/twilio/recording/:callId", (req, res) => {
  const url = String(req.body?.RecordingUrl ?? "");
  if (url) liveTwilioTransports.get(req.params.callId)?.notifyRecording(url);
  res.sendStatus(204);
});

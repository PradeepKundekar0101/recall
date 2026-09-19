import express from "express";
import cors from "cors";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { api } from "./api/routes.js";
import { attachMediaStream } from "./transports/twilio.js";
import { loadJourney } from "./journey/index.js";
import { JourneyState } from "./engine/journey-state.js";
import { prerender } from "./voice/tts.js";
import { loadLeads } from "./leads/index.js";
import { bus } from "./events.js";
import { closeOrphanedCalls, recordEvent } from "./db/repo.js";
import { env, bootReport, has } from "./env.js";
import { log } from "./log.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false })); // Twilio webhooks post form-encoded
app.use(api);

const server = createServer(app);

/**
 * Twilio opens one media-stream socket per call at /media/:callId. We hand it to
 * the transport that is already waiting on that id.
 */
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const match = (req.url ?? "").match(/^\/media\/([\w-]+)/);
  if (!match) {
    socket.destroy();
    return;
  }
  const callId = match[1] as string;
  wss.handleUpgrade(req, socket, head, (ws) => {
    // `pnpm twilio:check` probes this path to prove the tunnel allows websocket
    // upgrades. Twilio reports a rejected upgrade only as error 31920, so it is
    // worth being able to test it without placing a call.
    if (callId === "preflight") {
      ws.send(JSON.stringify({ event: "preflight-ok" }));
      setTimeout(() => ws.close(1000, "preflight complete"), 400);
      log.info("websocket preflight probe accepted");
      return;
    }

    if (!attachMediaStream(callId, ws)) {
      log.warn(`media stream for unknown call ${callId}, closing`);
      ws.close();
      return;
    }
    log.info(`media stream attached for ${callId.slice(0, 8)}`);
  });
});

// Every event that reaches the console is also written to the audit trail. The
// console is fed directly from the bus, so a Supabase outage slows the paperwork
// and never the call.
if (has.supabase()) {
  bus.subscribeAll((event) => {
    // Defensive on purpose. The audit trail is paperwork and the call is the
    // demo, so nothing on this path is allowed to reach the event loop as a
    // throw - a Supabase wobble must not end a call that is on speakerphone in
    // front of judges.
    try {
      void recordEvent(event).catch((err) => log.warn(`audit write failed: ${String(err)}`));
    } catch (err) {
      log.warn(`audit write threw: ${String(err)}`);
    }
  });
}

// Last line of defence. An unhandled rejection anywhere must not take the
// orchestrator down mid-call.
process.on("unhandledRejection", (reason) => log.error(`unhandled rejection: ${String(reason)}`));
process.on("uncaughtException", (err) => log.error(`uncaught exception: ${err.message}`));

/**
 * Validate the journey before listening.
 *
 * A config error found at boot is a restart; the same error found at dial time is
 * a dead demo, so this deliberately refuses to start.
 */
let journeyLine: string;
try {
  const journey = loadJourney();
  journeyLine = `journey    ${journey.id} v${journey.version} - ${journey.sections.length} sections, ${journey.fields.length} fields`;
} catch (err) {
  log.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

const leads = loadLeads();

// A second orchestrator used to die on the port bind without saying why, and
// `tsx watch` kept its watcher alive afterwards. Those watchers restart on any
// source edit and race for :8080, so the process that answers the next dial can
// be one started hours earlier from a shell carrying TRANSPORT=sim - which
// outranks .env - and the console then runs the simulator while the operator
// waits for a phone to ring. Seventeen of them had accumulated. Say what
// happened and take the watcher down with us.
server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    log.error(
      `port ${env.port} is already in use - another orchestrator is running. ` +
        `Stop it first: pkill -f "tsx watch src/index.ts"`
    );
  } else {
    log.error(err.message);
  }
  process.exit(1);
});

server.listen(env.port, () => {
  log.info(`RECALL orchestrator on :${env.port}`);
  // Only now: the bind succeeded, so no other orchestrator is serving, and any
  // call still marked live belongs to a process that is gone.
  void closeOrphanedCalls().then((ids) => {
    if (ids.length) log.warn(`closed ${ids.length} call(s) left live by a previous run: ${ids.join(", ")}`);
  });
  for (const line of bootReport()) log.info(`  ${line}`);
  log.info(`  ${journeyLine}`);
  log.info(`  leads      ${leads.length} synthetic${env.testNumbers[0] ? ` -> ${env.testNumbers[0]}` : " (NO TEST NUMBER SET)"}`);

  // Pre-render the fixed lines after the port is open, not before. A cold TTS
  // cache costs one synthesis on the first call; a boot that blocks on ElevenLabs
  // costs the whole demo if their API is having a moment.
  void prerender(JourneyState.fixedLines(loadJourney())).catch((err) =>
    log.warn(`pre-render failed, fixed lines will synthesise on demand: ${String(err)}`)
  );
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    log.info("shutting down");
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}

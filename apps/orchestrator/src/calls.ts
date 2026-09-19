import { randomUUID } from "node:crypto";
import type { CallOutcome, Journey, Lead } from "@recall/shared";
import { env } from "./env.js";
import { log } from "./log.js";
import { bus } from "./events.js";
import { DialogueEngine } from "./engine/dialogue.js";
import { EchoEngine } from "./engine/echo.js";
import { TwilioTransport, liveTwilioTransports } from "./transports/twilio.js";
import { SimTransport } from "./transports/sim.js";
import { personaById } from "./eval/personas.js";
import type { Transport } from "./engine/transport.js";
import { closeCall, openCall, setStatus } from "./db/repo.js";

/**
 * Call orchestration: builds a transport, builds an engine, and wires both to the
 * event bus the consoles live on.
 *
 * Finalisation is registered here rather than inside either engine, because the
 * webhooks that can end a call arrive on HTTP routes that know nothing about
 * engines. `finish()` is idempotent and every path routes through it.
 */

export type LiveCall = {
  callId: string;
  lead: Lead;
  mode: "echo" | "journey";
  transport: Transport;
  engine: DialogueEngine | EchoEngine;
  startedAt: number;
  finish: (outcome: CallOutcome) => Promise<void>;
};

const live = new Map<string, LiveCall>();

export function getCall(callId: string): LiveCall | undefined {
  return live.get(callId);
}

export function liveCallIds(): string[] {
  return [...live.keys()];
}

export async function startCall(opts: {
  lead: Lead;
  journey: Journey;
  personaId?: string;
  /** The operator's brief for how the agent should talk. Null when none was written. */
  agentBrief?: string | null;
}): Promise<LiveCall> {
  const callId = randomUUID();
  const { lead, journey } = opts;
  const mode = env.callMode;

  const transport: Transport =
    env.transport === "pstn"
      ? new TwilioTransport({ journey, lead, callId })
      : new SimTransport({
          journey,
          lead,
          callId,
          // Journey personas gate their turns on journey questions, so they say
          // nothing at all to the echo loop. Pick the matching probe by mode.
          persona:
            personaById(opts.personaId ?? (mode === "echo" ? "echo" : "cooperative")) ??
            personaById("cooperative")!,
        });

  if (transport instanceof TwilioTransport) liveTwilioTransports.set(callId, transport);

  // The calls row is written before any event references it. call_events has a
  // foreign key onto it, so emitting first meant every event on a new call failed
  // its insert - the audit trail was losing the opening of every single call.
  await openCall({
    callId,
    lead,
    journeyId: journey.id,
    testRun: true,
    simulated: env.transport !== "pstn" || env.mockVoice,
  });

  bus.emitEvent(callId, {
    type: "call.hello",
    lead,
    journey_id: journey.id,
    test_run: true,
    dial_target: lead.phone,
    simulated: env.transport !== "pstn" || env.mockVoice,
    ...(opts.agentBrief ? { agent_brief: opts.agentBrief } : {}),
  });
  bus.emitEvent(callId, { type: "call.status", status: "dialling" });

  let finished = false;
  const startedAt = Date.now();

  const finish = async (outcome: CallOutcome): Promise<void> => {
    if (finished) return;
    finished = true;
    const durationS = Math.round((Date.now() - startedAt) / 1000);

    const handsFree =
      call.engine instanceof DialogueEngine ? call.engine.state.form.handsFree() : { captured: 0, total: 0 };

    bus.emitEvent(callId, { type: "call.status", status: "ended", outcome });
    bus.emitEvent(callId, {
      type: "metrics.update",
      fields_hands_free: handsFree.captured,
      fields_total: handsFree.total,
      duration_s: durationS,
      // Measured from CIMET's recording once it arrives; zero until then rather
      // than a number invented to make the comparison look good.
      manual_baseline_s: 0,
    });

    await closeCall({
      callId,
      outcome,
      handoffReason: call.engine instanceof DialogueEngine ? (call.engine.state.handoffReason ?? undefined) : undefined,
      durationS,
      fieldsHandsFree: handsFree.captured,
      fieldsTotal: handsFree.total,
      recordingUrl: transport.recordingUrl,
      consentAt: call.engine instanceof DialogueEngine ? (call.engine.state.consentAt ?? undefined) : undefined,
    });

    live.delete(callId);
    liveTwilioTransports.delete(callId);
    log.call(callId, `call closed as ${outcome}`);
  };

  const engine =
    mode === "echo"
      ? new EchoEngine(callId, transport, {
          onAgentLine: (text) => emitFinal(callId, "agent", text, null),
          onCustomerLine: (text, confidence) => emitFinal(callId, "customer", text, confidence),
          onPartial: (speaker, text) => bus.emitEvent(callId, { type: "transcript.interim", speaker, text }),
          onOutcome: (outcome) => void finish(outcome),
          onTurnMeasured: (ms, text) =>
            bus.emitEvent(callId, {
              type: "latency.turn",
              ms,
              utterance: text.slice(0, 80),
              over_budget: ms > 1000,
            }),
        })
      : new DialogueEngine(callId, journey, lead, transport, {
          onAgentLine: (text) => emitFinal(callId, "agent", text, null),
          onCustomerLine: (text, confidence) => emitFinal(callId, "customer", text, confidence),
          onPartial: (speaker, text) => bus.emitEvent(callId, { type: "transcript.interim", speaker, text }),
          onFieldChange: (fieldId) => {
            const field = (engine as DialogueEngine).state.form.get(fieldId);
            if (!field) return;
            bus.emitEvent(callId, {
              type: "field.update",
              field: fieldId,
              state: field.state,
              value: field.value,
              confidence: field.confidence,
              evidence: field.evidence,
              attempts: field.attempts,
            });
          },
          onSection: (section, field) => bus.emitEvent(callId, { type: "script.section", section, field }),
          onTurnTiming: (timing) => {
            bus.emitEvent(callId, { type: "turn.timing", ...timing });
            // The journey engine has never emitted this. `first_audio_ms` is
            // exactly the number the rehearsal checklist asserts a median on,
            // and until now it was measured on echo calls only.
            bus.emitEvent(callId, {
              type: "latency.turn",
              ms: timing.first_audio_ms,
              utterance: "",
              over_budget: timing.first_audio_ms > 1000,
            });
          },
          onSignals: (readings) => {
            for (const r of readings) {
              bus.emitEvent(callId, {
                type: "escalation.signal",
                signal: r.signal,
                score: r.score,
                evidence: r.evidence,
                fired: r.fired,
              });
            }
          },
          onHandoff: (reason, evidence) => {
            const state = (engine as DialogueEngine).state;
            bus.emitEvent(callId, {
              type: "escalation.handoff",
              reason,
              packet: {
                call_id: callId,
                lead_id: lead.id,
                reason,
                evidence,
                fields: state.form.snapshot(),
                next_field: state.nextField()?.id ?? null,
                // The last five lines, which is what the human console renders.
                // This is the panel that proves the customer does not repeat
                // themselves, so shipping it empty defeated the whole feature.
                transcript: state.transcript.slice(-5),
                duration_s: state.durationSeconds,
              },
            });
            bus.emitEvent(callId, { type: "call.status", status: "handoff" });
          },
          onGuardrail: (guardrail, detail) =>
            bus.emitEvent(callId, {
              type: "guardrail.trigger",
              guardrail: guardrail as never,
              detail,
            }),
          onOutcome: (outcome) => void finish(outcome),
          onSubmit: (step, status, body) => bus.emitEvent(callId, { type: "submit.result", step, status, body }),
          persistField: () => {
            /* the bus subscriber in index.ts mirrors every event into call_events */
          },
        }, undefined, { brief: opts.agentBrief ?? null });

  const call: LiveCall = { callId, lead, mode, transport, engine, startedAt, finish };
  live.set(callId, call);

  // Dialling happens after the engine is wired, so a customer who answers on the
  // first ring cannot beat the transcript handler into existence.
  void (async () => {
    try {
      await transport.start();
      bus.emitEvent(callId, { type: "call.status", status: "live" });
      await setStatus(callId, "live");
      await engine.begin();
    } catch (err) {
      log.call(callId, `call failed to start: ${err instanceof Error ? err.message : String(err)}`);
      await finish("no_answer");
    }
  })();

  return call;
}

function emitFinal(callId: string, speaker: "agent" | "customer", text: string, confidence: number | null): void {
  bus.emitEvent(callId, { type: "transcript.final", speaker, text, confidence });
}

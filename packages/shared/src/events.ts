import type {
  CallOutcome,
  CallStatus,
  EscalationSignal,
  FieldState,
  FieldValue,
  GuardrailId,
  HandoffPacket,
  Lead,
  TurnTiming,
} from "./call.js";

/**
 * The SSE contract.
 *
 * One stream from the orchestrator per call, no polling. This union is the reason
 * `packages/shared` exists: the operator console and the engine drift apart
 * silently otherwise, and you find out on stage.
 *
 * Deliberately plain SSE rather than Supabase Realtime - the events originate in
 * the orchestrator, so routing them through the database and back adds a hop, a
 * schema, and a failure mode on the one surface the judges actually watch.
 */

type Base = { call_id: string; ts: number };

export type CallEvent =
  /** Replayed first to a browser that connects mid-call, so it can build the board. */
  | (Base & { type: "call.hello"; lead: Lead; journey_id: string; test_run: boolean; dial_target: string; agent_brief?: string; /** True when no phone rang: sim transport or mocked voice. */ simulated?: boolean })
  | (Base & { type: "call.status"; status: CallStatus; outcome?: CallOutcome })
  /** Twilio has the audio. Fired when its recording callback lands, which is usually after the call has ended. */
  | (Base & { type: "call.recording"; available: boolean })
  | (Base & { type: "transcript.interim"; speaker: "agent" | "customer"; text: string })
  | (Base & {
      type: "transcript.final";
      speaker: "agent" | "customer";
      text: string;
      confidence: number | null;
    })
  | (Base & {
      type: "field.update";
      field: string;
      state: FieldState;
      value: FieldValue;
      confidence: number | null;
      evidence: string | null;
      attempts: number;
    })
  | (Base & { type: "script.section"; section: string; field: string | null })
  | (Base & {
      type: "escalation.signal";
      signal: EscalationSignal;
      /** -1 to +1 for ANGER, 0 to 1 for the rest. Drives the on-screen meter. */
      score: number;
      evidence: string;
      /** False while pressure is building, true on the turn it trips. */
      fired: boolean;
    })
  | (Base & { type: "escalation.handoff"; reason: EscalationSignal; packet: HandoffPacket })
  | (Base & { type: "guardrail.trigger"; guardrail: GuardrailId; detail: string })
  | (Base & {
      type: "submit.result";
      /** Incremental section PUTs land here too, so the drawer can show progress. */
      step: string;
      status: number;
      body: unknown;
    })
  /**
   * One turn's measured round trip, customer end-of-speech to agent audio.
   * Echo mode emits one per turn; the journey engine emits one per reply. The
   * rehearsal checklist asserts a median under 800 ms on these.
   */
  | (Base & { type: "latency.turn"; ms: number; utterance: string; over_budget: boolean })
  /**
   * One turn's stage split, emitted once per agent reply.
   *
   * Flattened rather than nested so the audit mirror can be aggregated with
   * `payload->>'first_audio_ms'` instead of a nested path.
   */
  | (Base & { type: "turn.timing" } & TurnTiming)
  /** Top-right counter: the 25% criterion, said out loud during the demo. */
  | (Base & {
      type: "metrics.update";
      fields_hands_free: number;
      fields_total: number;
      duration_s: number;
      manual_baseline_s: number;
    });

export type CallEventType = CallEvent["type"];

/** Narrows a replayed event to one variant without a hand-written type guard. */
export function isEvent<T extends CallEventType>(
  event: CallEvent,
  type: T
): event is Extract<CallEvent, { type: T }> {
  return event.type === type;
}

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
  /**
   * A committed transcript the engine refused to treat as a turn.
   *
   * Dropping is silent to the customer by design - no re-ask, no state change,
   * nothing on the wire - which from the operator's chair is indistinguishable
   * from the agent not having heard anything at all. This event is the
   * difference: the room can see the agent's own voice arriving back off a
   * speakerphone and being thrown away, which is the whole point of the gate.
   */
  | (Base & {
      type: "transcript.dropped";
      text: string;
      /**
       * `echo` - it arrived while we were talking, or inside the tail after it,
       * and did not clear the bar for a barge-in.
       * `low_conf` - mean word confidence below the answer gate's floor.
       * `too_short` - not enough words, or not enough speech, to be an answer.
       * `no_intent` - the extractor found neither a value nor an answer in it.
       */
      reason: "echo" | "low_conf" | "too_short" | "no_intent";
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
  /**
   * One request to the receiving system, with what was sent and what came back.
   *
   * Emitted per confirmed field as well as for the final POST, which is what the
   * console's API logs pane renders: the operator sees the save happen rather than
   * being told it did. `status: 0` means the request never reached a server, and
   * `error` says why.
   */
  | (Base & {
      type: "submit.result";
      /** The field id for an incremental save, `"final"` for the closing POST. */
      step: string;
      status: number;
      body: unknown;
      method: "PUT" | "POST";
      /** Path only - no hostname, so it stays readable on a projector. */
      path: string;
      request: unknown;
      /** Round trip in milliseconds. */
      ms: number;
      error?: string;
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

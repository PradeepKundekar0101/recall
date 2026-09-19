"use client";

import { useEffect, useRef, useState } from "react";
import type {
  CallEvent,
  CallOutcome,
  CallStatus,
  EscalationSignal,
  FormState,
  HandoffPacket,
  Journey,
  Lead,
  TranscriptLine,
  TurnTiming,
} from "@recall/shared";
import { API } from "./api";

/**
 * Folds the orchestrator's event stream into the console's state.
 *
 * The stream replays from the start on connect, so a browser opened mid-call still
 * sees the whole story - which matters when a judge looks up halfway through and
 * wants to find the consent line at 00:0x.
 */

export type SignalState = { score: number; evidence: string; fired: boolean };

export type CallState = {
  connected: boolean;
  /**
   * Whether the stream ever opened. Before it has, `connected: false` only means
   * the console has not finished connecting; after it has, it means the console
   * lost the orchestrator and no longer knows what the call is doing.
   */
  everConnected: boolean;
  status: CallStatus;
  outcome: CallOutcome | null;
  lead: Lead | null;
  testRun: boolean;
  dialTarget: string;
  form: FormState;
  transcript: TranscriptLine[];
  /** The in-flight interim line, replaced on every partial and cleared on final. */
  interim: { speaker: "agent" | "customer"; text: string } | null;
  section: string | null;
  askingField: string | null;
  signals: Partial<Record<EscalationSignal, SignalState>>;
  handoff: { reason: EscalationSignal; packet: HandoffPacket } | null;
  guardrails: { guardrail: string; detail: string; at: number }[];
  /**
   * Every request made to the receiving system, oldest first: one per confirmed
   * field, then the final POST. This is what the API logs pane renders.
   */
  submissions: ApiCall[];
  metrics: { handsFree: number; total: number; durationS: number; baselineS: number } | null;
  /** Per-turn round trips, newest last. The demo quotes the median out loud. */
  latencies: number[];
  /**
   * The same turns broken into their stages, oldest first.
   *
   * Kept beside `latencies` rather than replacing it: that one is the single
   * number the header quotes every second on a live call, and this one is the
   * breakdown the timing panel draws. A call that ran before the orchestrator
   * measured stages carries the first and not the second.
   */
  timings: TurnTiming[];
  /** The operator's brief for this call, as the agent received it. */
  agentBrief: string | null;
  /** Whether a phone rang. Null until the call's first event says. */
  simulated: boolean | null;
  /** Twilio holds audio for this call. */
  recording: boolean;
  /** The stream was refused outright: nothing is known about this call id. */
  missing: boolean;
};

/** One request to the receiving system, as the console shows it. */
export type ApiCall = {
  /** The field id that was saved, or `"final"` for the closing POST. */
  step: string;
  method: "PUT" | "POST";
  path: string;
  request: unknown;
  /** 0 when the request never reached a server; `error` says why. */
  status: number;
  body: unknown;
  ms: number;
  error: string | null;
  at: number;
};

const EMPTY: CallState = {
  connected: false,
  everConnected: false,
  status: "queued",
  outcome: null,
  lead: null,
  testRun: true,
  dialTarget: "",
  form: {},
  transcript: [],
  interim: null,
  section: null,
  askingField: null,
  signals: {},
  handoff: null,
  guardrails: [],
  submissions: [],
  metrics: null,
  latencies: [],
  timings: [],
  agentBrief: null,
  simulated: null,
  recording: false,
  missing: false,
};

export function useCallStream(callId: string | null, journey: Journey | null): CallState {
  const [state, setState] = useState<CallState>(EMPTY);
  const journeyRef = useRef(journey);
  journeyRef.current = journey;

  useEffect(() => {
    if (!callId) {
      setState(EMPTY);
      return;
    }

    setState({ ...EMPTY, form: blankForm(journeyRef.current) });

    const source = new EventSource(`${API}/calls/${callId}/events`);
    let received = false;
    // Every connection starts with a full replay, so every open starts the
    // board again from blank: a reconnect after a blip must not append the
    // whole call a second time. The stream is never closed from this side -
    // a finished call still gets its recording notice a minute after the end,
    // and the metrics that follow the closing status in the same breath.
    source.onopen = () =>
      setState((s) => ({ ...EMPTY, form: blankForm(journeyRef.current), connected: true, everConnected: true }));
    source.onerror = () => {
      // A refused stream - a 404 for an id nobody knows - closes for good, and
      // the browser will not retry it. Say so rather than "connecting" forever.
      const refused = source.readyState === EventSource.CLOSED && !received;
      setState((s) => ({ ...s, connected: false, missing: refused }));
    };
    source.onmessage = (message) => {
      let event: CallEvent;
      try {
        event = JSON.parse(message.data) as CallEvent;
      } catch {
        return;
      }
      received = true;
      setState((prev) => reduce(prev, event));
    };

    return () => source.close();
  }, [callId]);

  return state;
}

/** Median rather than mean: one slow turn should not define the number. */
export function medianLatency(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? (sorted[mid] as number)
    : Math.round(((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2);
}

export function blankForm(journey: Journey | null): FormState {
  if (!journey) return {};
  return Object.fromEntries(
    journey.fields.map((f) => [
      f.id,
      { id: f.id, state: "empty" as const, value: null, confidence: null, evidence: null, attempts: 0, updated_at: 0 },
    ])
  );
}

function reduce(prev: CallState, event: CallEvent): CallState {
  switch (event.type) {
    case "call.hello":
      return {
        ...prev,
        lead: event.lead,
        testRun: event.test_run,
        dialTarget: event.dial_target,
        agentBrief: event.agent_brief ?? null,
        simulated: event.simulated ?? null,
      };

    case "call.status":
      return { ...prev, status: event.status, outcome: event.outcome ?? prev.outcome };

    case "call.recording":
      return { ...prev, recording: event.available };

    case "transcript.interim":
      return { ...prev, interim: { speaker: event.speaker, text: event.text } };

    case "transcript.final":
      return {
        ...prev,
        interim: null,
        transcript: [
          ...prev.transcript,
          { at: event.ts, speaker: event.speaker, text: event.text, confidence: event.confidence, final: true },
        ],
      };

    case "field.update":
      return {
        ...prev,
        form: {
          ...prev.form,
          [event.field]: {
            id: event.field,
            state: event.state,
            value: event.value,
            confidence: event.confidence,
            evidence: event.evidence,
            attempts: event.attempts,
            updated_at: event.ts,
          },
        },
      };

    case "script.section":
      return { ...prev, section: event.section, askingField: event.field };

    case "escalation.signal":
      return {
        ...prev,
        signals: {
          ...prev.signals,
          [event.signal]: { score: event.score, evidence: event.evidence, fired: event.fired },
        },
      };

    case "escalation.handoff":
      return { ...prev, handoff: { reason: event.reason, packet: event.packet }, status: "handoff" };

    case "guardrail.trigger":
      return {
        ...prev,
        guardrails: [...prev.guardrails, { guardrail: event.guardrail, detail: event.detail, at: event.ts }],
      };

    case "submit.result":
      return {
        ...prev,
        submissions: [
          ...prev.submissions,
          {
            step: event.step,
            method: event.method,
            path: event.path,
            request: event.request,
            status: event.status,
            body: event.body,
            ms: event.ms,
            error: event.error ?? null,
            at: event.ts,
          },
        ],
      };

    case "latency.turn":
      return { ...prev, latencies: [...prev.latencies, event.ms] };

    // The event is a TurnTiming flattened into the envelope, so it is already the
    // shape the panel reads and is stored whole. The array's type is what keeps
    // the envelope's own fields out of the panel's reach.
    case "turn.timing":
      return { ...prev, timings: [...prev.timings, event] };

    case "metrics.update":
      return {
        ...prev,
        metrics: {
          handsFree: event.fields_hands_free,
          total: event.fields_total,
          durationS: event.duration_s,
          baselineS: event.manual_baseline_s,
        },
      };

    default:
      return prev;
  }
}

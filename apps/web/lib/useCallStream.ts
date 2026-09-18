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
  submissions: { step: string; status: number; body: unknown }[];
  metrics: { handsFree: number; total: number; durationS: number; baselineS: number } | null;
  /** Per-turn round trips, newest last. The demo quotes the median out loud. */
  latencies: number[];
};

const EMPTY: CallState = {
  connected: false,
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
    source.onopen = () => setState((s) => ({ ...s, connected: true }));
    source.onerror = () => setState((s) => ({ ...s, connected: false }));
    source.onmessage = (message) => {
      let event: CallEvent;
      try {
        event = JSON.parse(message.data) as CallEvent;
      } catch {
        return;
      }
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
      return { ...prev, lead: event.lead, testRun: event.test_run, dialTarget: event.dial_target };

    case "call.status":
      return { ...prev, status: event.status, outcome: event.outcome ?? prev.outcome };

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
      return { ...prev, submissions: [...prev.submissions, { step: event.step, status: event.status, body: event.body }] };

    case "latency.turn":
      return { ...prev, latencies: [...prev.latencies, event.ms] };

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

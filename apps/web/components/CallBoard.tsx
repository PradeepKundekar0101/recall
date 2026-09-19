"use client";

import { useEffect, useState } from "react";
import type { Journey } from "@recall/shared";
import { API } from "../lib/api";
import { blankForm, medianLatency, useCallStream } from "../lib/useCallStream";
import { sectionTitle } from "../lib/journey";
import { JourneyForm } from "./JourneyForm";
import { Transcript, customerOf } from "./Transcript";
import { EscalationPanel } from "./EscalationPanel";
import { PayloadDrawer } from "./PayloadDrawer";
import { ApiLogs } from "./ApiLogs";
import { Orb } from "./Orb";
import { Portrait } from "./Portrait";
import { CallTiming } from "./analytics/CallTiming";

/**
 * One call, live or replayed: the two parties and the telemetry across the top,
 * then transcript, journey and escalation side by side, then the requests made to
 * the receiving system, and the payload below.
 * Everything on it comes off the call's event stream, so a call that ended an
 * hour ago and a call that is ringing right now are the same screen.
 */
export function CallBoard({ callId, journey }: { callId: string; journey: Journey | null }) {
  const call = useCallStream(callId, journey);
  const [elapsed, setElapsed] = useState(0);
  const [selectedField, setSelectedField] = useState<string | null>(null);

  useEffect(() => {
    if (call.status !== "live" && call.status !== "answered") return;
    const timer = setInterval(() => setElapsed((v) => v + 1), 1000);
    return () => clearInterval(timer);
  }, [call.status]);

  const lead = call.lead;
  const median = medianLatency(call.latencies);
  // 800ms is the budget; past a second the call stops feeling like a conversation.
  const overBudget = median !== null && median > 1000;
  const form = Object.keys(call.form).length ? call.form : blankForm(journey);
  const customer = customerOf(lead);
  const over = call.status === "ended";
  // The stream opened once and then went away while the call was still on:
  // the console no longer knows what the call is doing, and says so instead
  // of freezing on the last thing it heard.
  const lost = call.everConnected && !call.connected && !over;
  const shown = lost ? "lost" : call.status;
  // A replayed call shows the duration it had, not a stopwatch that never ran.
  const clock = over && call.metrics ? call.metrics.durationS : elapsed;

  if (call.missing) {
    return (
      <section className="step-body" aria-label="Call">
        <div className="intro">
          <h1 className="intro-title">No call with that id</h1>
          <p className="intro-sub">
            Nothing was recorded under {callId}. It may belong to an orchestrator that ran without an audit trail.
          </p>
        </div>
      </section>
    );
  }

  return (
    // The call's own scrolling column, the same one the other standing views
    // use. Without it every card below the pane row takes its height out of the
    // pane row - it is the only child that flexes - and on a short screen the
    // transcript is squeezed down to its header while the cards below it stay
    // whole. Bounded here, the row keeps its floor and the column scrolls.
    <div className="callboard">
      <section className="callhead" aria-label="Call">
        <div className="parties">
          <Orb status={shown} speaking={call.interim?.speaker ?? null} size={52} />
          <Portrait id={lead?.id} name={lead?.full_name ?? "Customer"} size={52} />
        </div>
        <div className="callhead-lead">
          <h1 className="lead-name">{lead ? lead.full_name : "Connecting"}</h1>
          <div className="lead-sub">
            {lead ? `${lead.id} · dropped at ${sectionTitle(journey, lead.last_completed_step)}` : callId}
          </div>
        </div>

        <div className="stats">
          <div className="stat stat-status">
            <span className="stat-label">Status</span>
            <span className="stat-value">
              <span className={`status-dot status-${shown}`} />
              {shown}
              {!lost && call.outcome && call.outcome !== call.status ? ` · ${call.outcome}` : ""}
            </span>
          </div>
          <div className="stat">
            <span className="stat-label">{over ? "Duration" : "Elapsed"}</span>
            <span className="stat-value">{mmss(clock)}</span>
          </div>
          <div className="stat">
            <span className="stat-label">Turn latency</span>
            <span className={`stat-value ${overBudget ? "stat-over" : ""}`}>
              {median === null ? "-" : `${median} ms`}
            </span>
          </div>
          <div className="stat">
            <span className="stat-label">Hands-free</span>
            <span className="stat-value">
              {call.metrics ? `${call.metrics.handsFree}/${call.metrics.total}` : "0/0"}
            </span>
          </div>
        </div>
      </section>

      {call.simulated && (
        <div className="notice" role="status">
          No phone was dialled - this call was simulated.
        </div>
      )}

      <div className="panes">
        <section className="pane" aria-label="Transcript">
          <div className="pane-head">
            <span className="pane-title">Transcript</span>
            {call.recording ? (
              <audio
                className="player"
                controls
                preload="none"
                src={`${API}/calls/${callId}/recording`}
                aria-label="Call recording"
              />
            ) : (
              <span className="pane-meta">{over ? "Ended" : call.connected ? "Streaming" : "Connecting"}</span>
            )}
          </div>
          <div className="pane-body">
            <Transcript
              lines={call.transcript}
              interim={call.interim}
              guardrails={call.guardrails}
              customer={customer}
              brief={call.agentBrief}
            />
          </div>
        </section>

        <section className="pane" aria-label="Journey form">
          <div className="pane-head">
            <span className="pane-title">Journey</span>
            <span className="pane-meta">
              {journey ? `${journey.sections.length} sections · ${journey.fields.length} fields` : ""}
            </span>
          </div>
          <div className="pane-body">
            <JourneyForm
              journey={journey}
              form={form}
              onSelect={setSelectedField}
              selected={selectedField}
              activeSection={over ? null : call.section}
            />
          </div>
        </section>

        <section className="pane" aria-label="Escalation">
          <div className="pane-head">
            <span className="pane-title">Escalation</span>
            <span className="pane-meta">{call.handoff ? "Handed off" : over ? "Ended" : "Monitoring"}</span>
          </div>
          <div className="pane-body">
            <EscalationPanel
              signals={call.signals}
              handoff={call.handoff}
              section={call.section}
              askingField={call.askingField}
            />
          </div>
        </section>
      </div>

      <ApiLogs calls={call.submissions} leadId={lead?.id ?? null} />

      {/* Draws nothing until a turn has been measured, so a call recorded before
          the orchestrator timed its stages shows no panel rather than an empty
          one promising numbers that were never taken. */}
      <CallTiming timings={call.timings} />

      <PayloadDrawer payload={{ lead_id: lead?.id ?? null, form }} submissions={call.submissions} />
    </div>
  );
}

function mmss(seconds: number): string {
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

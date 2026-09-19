"use client";

import { useEffect, useState } from "react";
import type { Journey, Lead } from "@recall/shared";
import { getJson, postJson } from "../lib/api";
import { blankForm, medianLatency, useCallStream } from "../lib/useCallStream";
import { JourneyForm } from "../components/JourneyForm";
import { Transcript, customerOf } from "../components/Transcript";
import { EscalationPanel } from "../components/EscalationPanel";
import { PayloadDrawer } from "../components/PayloadDrawer";
import { Orb } from "../components/Orb";

type LeadRow = Lead & { dial: { allowed: boolean; reason?: string }; on_dnc: boolean };

export default function OperatorConsole() {
  const [journey, setJourney] = useState<Journey | null>(null);
  const [leads, setLeads] = useState<LeadRow[]>([]);
  const [selectedLead, setSelectedLead] = useState<string | null>(null);
  const [callId, setCallId] = useState<string | null>(null);
  const [selectedField, setSelectedField] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  /** Whether the call on screen actually rang a phone. Null before the first dial. */
  const [simulated, setSimulated] = useState<boolean | null>(null);

  const call = useCallStream(callId, journey);

  useEffect(() => {
    void getJson<Journey>("/journey").then(setJourney).catch(() => setNotice("Orchestrator is not reachable."));
    void getJson<{ leads: LeadRow[] }>("/leads")
      .then((data) => {
        setLeads(data.leads);
        setSelectedLead(data.leads[0]?.id ?? null);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (call.status !== "live" && call.status !== "answered") return;
    const timer = setInterval(() => setElapsed((v) => v + 1), 1000);
    return () => clearInterval(timer);
  }, [call.status]);

  const lead = leads.find((l) => l.id === selectedLead) ?? null;
  const median = medianLatency(call.latencies);
  // 800ms is the budget; past a second the call stops feeling like a conversation.
  const overBudget = median !== null && median > 1000;
  const form = Object.keys(call.form).length ? call.form : blankForm(journey);
  // Before the first dial the stream is at rest, and "queued" would read as a
  // call waiting to happen. Nothing is waiting; the console is idle.
  const status = callId ? call.status : "idle";
  const customer = customerOf(call.lead?.full_name ?? lead?.full_name);
  const droppedAt = lead
    ? journey?.sections.find((s) => s.id === lead.last_completed_step)?.title ?? lead.last_completed_step
    : null;

  async function dial() {
    if (!lead) return;
    setNotice(null);
    const { status, data } = await postJson<{
      call_id?: string;
      error?: string;
      simulated?: boolean;
      note?: string;
    }>("/calls", { lead_id: lead.id });
    if (status === 403 || status === 404 || status === 501) {
      setNotice(data.error ?? `Dial refused (${status}).`);
      return;
    }
    if (data.call_id) {
      // A simulated dial answers 201 and streams a whole scripted conversation
      // while no phone ever rings. On screen that is indistinguishable from a
      // real call, so the orchestrator spells the fact out and the console has
      // to say so - otherwise the operator is watching a fake call believing
      // the handset is about to ring.
      setSimulated(data.simulated ?? false);
      if (data.simulated) setNotice(data.note ?? "No phone was dialled - this call is simulated.");
      setCallId(data.call_id);
      setElapsed(0);
    }
  }

  async function addToDnc() {
    if (!lead) return;
    await postJson("/dnc", { phone: lead.phone });
    const refreshed = await getJson<{ leads: LeadRow[] }>("/leads");
    setLeads(refreshed.leads);
    setNotice(`${lead.phone} added to the Do Not Call register.`);
  }

  return (
    <div className="console">
      <header className="nav">
        <div className="wordmark">
          <span className="wordmark-name">Recall</span>
          <span className="wordmark-sub">Recovery call</span>
        </div>

        <span className="spacer" />

        <select
          className="select"
          value={selectedLead ?? ""}
          onChange={(e) => setSelectedLead(e.target.value)}
          aria-label="Select lead"
        >
          {leads.map((l) => (
            <option key={l.id} value={l.id}>
              {l.id} · {l.full_name}
            </option>
          ))}
        </select>

        <button className="btn btn-outline" onClick={addToDnc}>
          Add to DNC
        </button>

        <button className="btn btn-primary" onClick={dial} disabled={!lead}>
          Dial
        </button>

        {/* The chip exists to make a guardrail visible. "Nothing was dialled"
            is the same class of fact and outranks it, so it takes the chip over
            for the duration of the call rather than adding a second thing to
            read. */}
        {simulated ? (
          <span className="chip chip-error">Simulated · no phone dialled</span>
        ) : (
          <span className="chip chip-warn">Test run · {lead?.phone ?? "no number"}</span>
        )}
      </header>

      {/* The person on the other end of the line is the one large thing on
          screen; the id is already carried by the picker. The orb beside them
          is the agent, and it is the call's pulse: still until the dial, ringing
          while it rings, breathing while the call is live. */}
      <section className="callhead" aria-label="Call">
        <Orb status={status} speaking={call.interim?.speaker ?? null} size={52} />
        <div className="callhead-lead">
          <h1 className="lead-name">{lead ? lead.full_name : "No lead selected"}</h1>
          <div className="lead-sub">
            {lead ? `${lead.id} · dropped at ${droppedAt}` : "Pick a lead from the list to dial."}
          </div>
        </div>

        <div className="stats">
          <div className="stat stat-status">
            <span className="stat-label">Status</span>
            <span className="stat-value">
              <span className={`status-dot status-${status}`} />
              {status}
              {call.outcome && call.outcome !== status ? ` · ${call.outcome}` : ""}
            </span>
          </div>
          <div className="stat">
            <span className="stat-label">Elapsed</span>
            <span className="stat-value">{mmss(elapsed)}</span>
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

      {notice && (
        <div className="notice" role="status">
          {notice}
        </div>
      )}

      <div className="panes">
        <section className="pane" aria-label="Transcript">
          <div className="pane-head">
            <span className="pane-title">Transcript</span>
            <span className="pane-meta">
              {!callId ? "Waiting for a call" : call.connected ? "Streaming" : "Reconnecting"}
            </span>
          </div>
          <div className="pane-body">
            <Transcript
              lines={call.transcript}
              interim={call.interim}
              guardrails={call.guardrails}
              customer={customer}
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
              activeSection={call.section}
            />
          </div>
        </section>

        <section className="pane" aria-label="Escalation">
          <div className="pane-head">
            <span className="pane-title">Escalation</span>
            <span className="pane-meta">{call.handoff ? "Handed off" : "Monitoring"}</span>
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

      <PayloadDrawer payload={{ lead_id: lead?.id ?? null, form }} submissions={call.submissions} />
    </div>
  );
}

function mmss(seconds: number): string {
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

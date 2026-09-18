"use client";

import { useEffect, useState } from "react";
import type { Journey, Lead } from "@recall/shared";
import { getJson, postJson } from "../lib/api";
import { blankForm, medianLatency, useCallStream } from "../lib/useCallStream";
import { JourneyForm } from "../components/JourneyForm";
import { Transcript } from "../components/Transcript";
import { EscalationPanel } from "../components/EscalationPanel";
import { PayloadDrawer } from "../components/PayloadDrawer";

type LeadRow = Lead & { dial: { allowed: boolean; reason?: string }; on_dnc: boolean };

export default function OperatorConsole() {
  const [journey, setJourney] = useState<Journey | null>(null);
  const [leads, setLeads] = useState<LeadRow[]>([]);
  const [selectedLead, setSelectedLead] = useState<string | null>(null);
  const [callId, setCallId] = useState<string | null>(null);
  const [selectedField, setSelectedField] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);

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

  async function dial() {
    if (!lead) return;
    setNotice(null);
    const { status, data } = await postJson<{ call_id?: string; error?: string }>("/calls", {
      lead_id: lead.id,
    });
    if (status === 403 || status === 404 || status === 501) {
      setNotice(data.error ?? `Dial refused (${status}).`);
      return;
    }
    if (data.call_id) {
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
      <header className="bar">
        <div className="wordmark">
          RECALL
          <span className="wordmark-sub">recovery call</span>
        </div>

        <div>
          <div className="label">Lead</div>
          <div className="bar-id">{lead ? `${lead.id} · ${lead.full_name}` : "no lead"}</div>
        </div>

        <div className="bar-meta">
          <div className="stat">
            <span className="label">Dropped</span>
            <span className="stat-value">{lead?.last_completed_step ?? "—"}</span>
          </div>
          <div className="stat">
            <span className="label">Status</span>
            <span className="stat-value">
              <span className={`status-dot status-${call.status}`} />
              {call.status}
              {call.outcome ? ` · ${call.outcome}` : ""}
            </span>
          </div>
          <div className="stat">
            <span className="label">Elapsed</span>
            <span className="stat-value">{mmss(elapsed)}</span>
          </div>
          <div className="stat">
            <span className="label">Turn latency</span>
            <span
              className="stat-value"
              style={{ color: overBudget ? "var(--alarm)" : undefined }}
            >
              {median === null ? "—" : `${median}ms`}
            </span>
          </div>
          <div className="stat">
            <span className="label">Hands-free</span>
            <span className="stat-value">
              {call.metrics ? `${call.metrics.handsFree}/${call.metrics.total}` : "0/0"}
            </span>
          </div>
        </div>

        <span className="bar-spacer" />

        <select
          value={selectedLead ?? ""}
          onChange={(e) => setSelectedLead(e.target.value)}
          aria-label="Select lead"
          style={{
            background: "var(--panel)",
            color: "var(--ink)",
            border: "1px solid var(--rule)",
            borderRadius: "var(--radius)",
            padding: "6px 8px",
            font: "inherit",
          }}
        >
          {leads.map((l) => (
            <option key={l.id} value={l.id}>
              {l.id} · {l.full_name}
            </option>
          ))}
        </select>

        <button className="bar-btn" onClick={addToDnc}>
          Add to DNC
        </button>

        <button className="bar-btn bar-btn-go" onClick={dial} disabled={!lead}>
          Dial
        </button>

        <span className="testrun">TEST RUN · {lead?.phone ?? "no number"}</span>
      </header>

      {notice && (
        <div style={{ padding: "8px 16px", background: "rgba(255,92,92,0.1)", color: "var(--alarm)", borderBottom: "1px solid var(--rule)" }}>
          {notice}
        </div>
      )}

      <div className="panes">
        <section className="pane" aria-label="Transcript">
          <div className="pane-head">
            <span className="label">Transcript</span>
            <span className="meter-score">{call.connected ? "streaming" : "not connected"}</span>
          </div>
          <div className="pane-body">
            <Transcript lines={call.transcript} interim={call.interim} guardrails={call.guardrails} />
          </div>
        </section>

        <section className="pane" aria-label="Journey form">
          <div className="pane-head">
            <span className="label">Journey</span>
            <span className="meter-score">{journey ? `${journey.fields.length} fields` : ""}</span>
          </div>
          <div className="pane-body">
            <JourneyForm journey={journey} form={form} onSelect={setSelectedField} selected={selectedField} />
          </div>
        </section>

        <section className="pane" aria-label="Escalation">
          <div className="pane-head">
            <span className="label">Escalation</span>
            <span className="meter-score">{call.handoff ? "handed off" : "monitoring"}</span>
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

"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { CallSummary } from "@recall/shared";
import { getJson } from "../../lib/api";
import { Nav } from "../../components/Nav";
import { Portrait } from "../../components/Portrait";

/**
 * Every call the orchestrator knows about, newest first. Each row opens the
 * call at its own address, live or replayed.
 */
export default function CallHistory() {
  const [calls, setCalls] = useState<CallSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void getJson<{ calls: CallSummary[] }>("/calls")
      .then((data) => setCalls(data.calls))
      .catch(() => setError("Orchestrator is not reachable."));
  }, []);

  return (
    <div className="console">
      <Nav>
        <Link href="/" className="btn btn-primary">
          Set up a call
        </Link>
      </Nav>

      <section className="step-body" aria-label="Past calls">
        <div className="intro">
          <h1 className="intro-title">Past calls</h1>
          <p className="intro-sub">
            Everything said and captured on each call, with the recording where Twilio kept one.
          </p>
        </div>

        {error && (
          <div className="notice" role="status">
            {error}
          </div>
        )}

        {calls && calls.length === 0 && <p className="empty">No calls yet. Set one up and dial.</p>}

        {calls && calls.length > 0 && (
          <div className="call-list">
            {calls.map((call) => (
              <Link href={`/calls/${call.id}`} className="call-row" key={call.id}>
                <Portrait id={call.lead_id} name={call.lead_name ?? call.lead_id} size={40} />
                <span className="call-row-who">
                  <span className="call-row-name">{call.lead_name ?? call.lead_id}</span>
                  <span className="call-row-sub">
                    {call.lead_id} · {call.id.slice(0, 8)}
                  </span>
                </span>
                <span className="call-row-when">{when(call.started_at)}</span>
                <span className="call-row-num">{call.duration_s != null ? mmss(call.duration_s) : "-"}</span>
                <span className="call-row-num">
                  {call.fields_total != null ? `${call.fields_hands_free ?? 0}/${call.fields_total}` : "-"}
                </span>
                <span className="call-row-tags">
                  {call.has_recording && <span className="chip">Recording</span>}
                  <OutcomeChip call={call} />
                </span>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

/** The one word that says how the call went, in the colour it deserves. */
function OutcomeChip({ call }: { call: CallSummary }) {
  if (call.live || (call.status !== "ended" && !call.outcome)) {
    return <span className="chip chip-info">{call.status}</span>;
  }
  const outcome = call.outcome ?? "ended";
  const tone =
    outcome === "submitted"
      ? "chip-success"
      : outcome === "handoff"
        ? "chip-warn"
        : outcome === "declined"
          ? "chip-error"
          : "";
  const label = outcome === "handoff" && call.handoff_reason ? `Handed off · ${call.handoff_reason.replace(/_/g, " ")}` : outcome.replace(/_/g, " ");
  return <span className={`chip ${tone}`}>{label}</span>;
}

function when(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("en-AU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function mmss(seconds: number): string {
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

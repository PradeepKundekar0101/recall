"use client";

import { useEffect, useState } from "react";
import type { Journey } from "@recall/shared";
import { getJson } from "../../lib/api";
import { blankForm, useCallStream } from "../../lib/useCallStream";
import { JourneyForm } from "../../components/JourneyForm";

/**
 * The human handoff console.
 *
 * Opened on a second laptop the moment a transfer fires. It shows only the packet:
 * why the call escalated, everything collected so far, the last few lines of what
 * was said, and where to pick up. This is the screen that proves the customer never
 * repeats themselves, so it is deliberately not a second operator console - there
 * is nothing on it the human has to hunt through.
 *
 * Reached as /handoff?call=<id>. In the demo the operator console's handoff banner
 * carries the link.
 */
export default function HandoffConsole() {
  const [journey, setJourney] = useState<Journey | null>(null);
  const [callId, setCallId] = useState<string | null>(null);

  useEffect(() => {
    setCallId(new URLSearchParams(window.location.search).get("call"));
    void getJson<Journey>("/journey").then(setJourney).catch(() => undefined);
  }, []);

  const call = useCallStream(callId, journey);
  const packet = call.handoff?.packet ?? null;
  const form = Object.keys(call.form).length ? call.form : blankForm(journey);
  const recent = call.transcript.slice(-5);

  if (!callId) {
    return (
      <main className="handoff">
        <h1 className="bar-id">Handoff console</h1>
        <p className="empty">
          Open this with a call id to see its packet, for example
          <code> /handoff?call=&lt;call-id&gt;</code>. The operator console links here when a
          transfer fires.
        </p>
      </main>
    );
  }

  return (
    <main className="handoff">
      <div className="label">Handoff console</div>
      <h1 className="bar-id" style={{ margin: "4px 0 20px" }}>
        {call.lead ? `${call.lead.full_name} · ${call.lead.id}` : callId}
      </h1>

      {packet ? (
        <div className="handoff-reason">
          <div className="label" style={{ color: "inherit" }}>
            Escalated · {packet.reason.replace(/_/g, " ")}
          </div>
          <div style={{ fontSize: 15, marginTop: 6 }}>&ldquo;{packet.evidence}&rdquo;</div>
          <div className="meter-score" style={{ marginTop: 8 }}>
            {packet.duration_s}s on the line before the transfer
          </div>
        </div>
      ) : (
        <p className="empty">
          {call.connected
            ? "Connected. This fills the moment the call escalates."
            : "Connecting to the call stream."}
        </p>
      )}

      {packet?.next_field && (
        <div className="handoff-continue">
          Continue from: {labelFor(journey, packet.next_field)}
        </div>
      )}

      <div className="handoff-grid">
        <section>
          <div className="section-head">
            <span className="label">Already collected</span>
            <span className="section-rule" />
          </div>
          <JourneyForm journey={journey} form={packet?.fields ?? form} />
        </section>

        <section>
          <div className="section-head">
            <span className="label">Last five lines</span>
            <span className="section-rule" />
          </div>
          {recent.length ? (
            recent.map((line, i) => (
              <div className={`turn turn-${line.speaker}`} key={`${line.at}-${i}`}>
                <div className="turn-head">
                  <span className="turn-who">{line.speaker}</span>
                </div>
                <div className="turn-text">{line.text}</div>
              </div>
            ))
          ) : (
            <p className="empty">Nothing said yet.</p>
          )}
        </section>
      </div>
    </main>
  );
}

function labelFor(journey: Journey | null, fieldId: string): string {
  return journey?.fields.find((f) => f.id === fieldId)?.label ?? fieldId;
}

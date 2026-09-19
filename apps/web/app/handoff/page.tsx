"use client";

import { useEffect, useState } from "react";
import type { Journey } from "@recall/shared";
import { getJson } from "../../lib/api";
import { blankForm, useCallStream } from "../../lib/useCallStream";
import { JourneyForm } from "../../components/JourneyForm";
import { TurnLine, customerOf } from "../../components/Transcript";

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
  const customer = customerOf(call.lead?.full_name);

  if (!callId) {
    return (
      <main className="handoff">
        <div className="label">Handoff console</div>
        <h1 className="handoff-title">Waiting for a transfer</h1>
        <div className="handoff-idle">
          Open this with a call id to watch a call and catch its packet the moment
          one fires, for example <code>/handoff?call=&lt;call-id&gt;</code>. The operator
          console links here when a transfer fires.
        </div>
      </main>
    );
  }

  return (
    <main className="handoff">
      <div className="label">Handoff console</div>
      <h1 className="handoff-title">
        {call.lead ? `${call.lead.full_name} · ${call.lead.id}` : callId}
      </h1>

      {packet ? (
        <div className="handoff-reason">
          <div className="label">Escalated · {packet.reason.replace(/_/g, " ")}</div>
          <div className="handoff-evidence">&ldquo;{packet.evidence}&rdquo;</div>
          <div className="handoff-elapsed">{packet.duration_s}s on the line before the transfer</div>
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
        <section className="card">
          <div className="section-head">
            <span className="label">Already collected</span>
            <span className="section-rule" />
          </div>
          <JourneyForm journey={journey} form={packet?.fields ?? form} />
        </section>

        <section className="card">
          <div className="section-head">
            <span className="label">Last five lines</span>
            <span className="section-rule" />
          </div>
          {recent.length ? (
            recent.map((line, i) => (
              <TurnLine
                key={`${line.at}-${i}`}
                speaker={line.speaker}
                text={line.text}
                at={line.at}
                confidence={line.confidence}
                customer={customer}
              />
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

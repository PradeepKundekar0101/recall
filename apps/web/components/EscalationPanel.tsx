"use client";

import type { EscalationSignal, HandoffPacket } from "@recall/shared";
import type { SignalState } from "../lib/useCallStream";

/**
 * The signature panel.
 *
 * Six lanes, one per signal, each filling as pressure builds. A handoff that fires
 * out of a flat panel looks arbitrary; one that fires after the room has watched
 * ANGER climb for two turns reads as judgment. That visible build-up is what the
 * robustness criterion is actually asking to see.
 */

const SIGNALS: { id: EscalationSignal; hint: string }[] = [
  { id: "ANGER", hint: "sentiment <= -0.6 once, or <= -0.3 twice" },
  { id: "CONFUSION", hint: "same field re-asked to its limit" },
  { id: "OFF_SCRIPT", hint: "asked for advice we do not give" },
  { id: "SENSITIVE", hint: "card data or a vulnerability disclosure" },
  { id: "ASKS", hint: "asked for a person" },
  { id: "LOW_CONF", hint: "two consecutive low-confidence turns" },
];

export function EscalationPanel({
  signals,
  handoff,
  section,
  askingField,
}: {
  signals: Partial<Record<EscalationSignal, SignalState>>;
  handoff: { reason: EscalationSignal; packet: HandoffPacket } | null;
  section: string | null;
  askingField: string | null;
}) {
  const anger = signals.ANGER?.score ?? 0;

  return (
    <>
      {handoff && (
        <div className="handoff-banner">
          <div className="label" style={{ color: "inherit" }}>
            Handed off - {handoff.reason.replace(/_/g, " ")}
          </div>
          <div style={{ marginTop: 4 }}>{handoff.packet.evidence}</div>
        </div>
      )}

      <div className="meter-head">
        <span className="meter-name">Sentiment</span>
        <span className="meter-score">{anger.toFixed(2)}</span>
      </div>
      <div className="sentiment">
        <span
          className="sentiment-needle"
          style={{ left: `calc(${((anger + 1) / 2) * 100}% - 1px)` }}
        />
      </div>

      {SIGNALS.map(({ id, hint }) => {
        const signal = signals[id];
        // ANGER is the only signed signal; the rest run 0 to 1.
        const magnitude = id === "ANGER" ? Math.max(0, -(signal?.score ?? 0)) : signal?.score ?? 0;
        const fired = signal?.fired ?? false;
        return (
          <div className={`meter ${fired ? "meter-fired" : ""}`} key={id}>
            <div className="meter-head">
              <span className="meter-name" title={hint}>
                {id.replace(/_/g, " ")}
              </span>
              <span className="meter-score">{fired ? "FIRED" : magnitude.toFixed(2)}</span>
            </div>
            <div className={`lane ${fired ? "lane-fired" : ""}`}>
              <span className="lane-fill" style={{ width: `${Math.min(100, magnitude * 100)}%` }} />
            </div>
            {signal?.evidence && <div className="meter-evidence">{signal.evidence}</div>}
          </div>
        );
      })}

      <div className="section-head" style={{ marginTop: 20 }}>
        <span className="label">Script position</span>
        <span className="section-rule" />
      </div>
      <div style={{ color: "var(--ink-dim)" }}>
        {section ? `${section} / ${askingField ?? "-"}` : "not started"}
      </div>
    </>
  );
}

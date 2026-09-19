"use client";

import { useEffect, useRef } from "react";
import type { TranscriptLine } from "@recall/shared";
import { Orb } from "./Orb";
import { Portrait, initialsOf } from "./Portrait";

/**
 * Speaker-separated transcript. Interim results render grey and italic until the
 * final arrives, so the room can see the recognition settling in real time.
 *
 * The agent is marked with its orb and the customer with their face, so the
 * two voices are told apart by who they are rather than by a colour that would
 * have to be learned first.
 */

export type Customer = { id: string | null; name: string; initials: string };

/** The customer as the transcript names them: first name and face off the lead. */
export function customerOf(lead: { id: string; full_name: string } | null | undefined): Customer {
  const first = (lead?.full_name ?? "").trim().split(/\s+/)[0];
  if (!lead || !first) return { id: null, name: "Customer", initials: "C" };
  return { id: lead.id, name: first, initials: initialsOf(lead.full_name) };
}

type Tag = { guardrail: string; detail: string; at: number };

/** A committed transcript the engine refused, and why. */
export type Drop = { text: string; reason: string; confidence: number | null; at: number };

/** What each drop reason means, in the words the room would use. */
const DROP_REASON: Record<string, string> = {
  echo: "our own voice",
  low_conf: "too unclear",
  too_short: "too short",
  no_intent: "not an answer",
};

export function Transcript({
  lines,
  interim,
  guardrails,
  dropped = [],
  customer,
  brief = null,
}: {
  lines: TranscriptLine[];
  interim: { speaker: "agent" | "customer"; text: string } | null;
  guardrails: Tag[];
  /**
   * Transcripts the engine threw away. Shown in place, struck through, with
   * the reason - a drop is silent on the line, so without this the board looks
   * identical whether the agent refused the customer's speakerphone or simply
   * heard nothing.
   */
  dropped?: Drop[];
  customer: Customer;
  /** The operator's brief, shown once at the top so the room can hear it applied. */
  brief?: string | null;
}) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [lines.length, interim?.text, dropped.length]);

  const note = brief ? (
    <div className="brief-note">
      <span className="label">Brief</span>
      <p>{brief}</p>
    </div>
  ) : null;

  if (!lines.length && !interim && !dropped.length) {
    return (
      <>
        {note}
        <div className="transcript-idle">
          <Orb status="idle" size={72} />
          <p className="empty">The transcript starts when the customer picks up.</p>
        </div>
      </>
    );
  }

  /**
   * Turns and drops in one list, ordered by when they happened.
   *
   * A drop belongs where it occurred - between the question and the answer that
   * finally got through - because that is the reading that makes it
   * informative: "the agent asked, its own voice came back, it ignored it, then
   * the customer answered". Collected at the bottom instead, the same three
   * facts say nothing.
   */
  const entries = [
    ...lines.map((line, i) => ({ at: line.at, kind: "turn" as const, line, i })),
    ...dropped.map((drop) => ({ at: drop.at, kind: "drop" as const, drop })),
  ].sort((a, b) => a.at - b.at);

  return (
    <>
      {note}
      {entries.map((entry) =>
        entry.kind === "drop" ? (
          <DroppedLine key={`drop-${entry.at}`} drop={entry.drop} customer={customer} />
        ) : (
          <TurnLine
            key={`${entry.at}-${entry.i}`}
            speaker={entry.line.speaker}
            text={entry.line.text}
            at={entry.line.at}
            confidence={entry.line.confidence}
            // Guardrail triggers render inline at the turn they fired on, which
            // is what makes "the disclosure came before any question" checkable.
            tags={guardrails.filter(
              (g) => g.at >= entry.line.at && g.at < (lines[entry.i + 1]?.at ?? Number.MAX_SAFE_INTEGER)
            )}
            customer={customer}
          />
        )
      )}

      {interim && <TurnLine speaker={interim.speaker} text={interim.text} customer={customer} interim />}
      <div ref={endRef} />
    </>
  );
}

/** One line of the conversation. Shared with the handoff console's recap. */
export function TurnLine({
  speaker,
  text,
  at,
  confidence,
  tags = [],
  customer,
  interim = false,
}: {
  speaker: "agent" | "customer";
  text: string;
  at?: number;
  confidence?: number | null;
  tags?: Tag[];
  customer: Customer;
  interim?: boolean;
}) {
  return (
    <div className={`turn turn-${speaker}${interim ? " turn-interim" : ""}`}>
      {speaker === "agent" ? (
        <img className="turn-avatar" src="/brand/orb.png" alt="" width={24} height={24} draggable={false} />
      ) : (
        <Portrait id={customer.id} name={customer.name} size={24} className="turn-avatar" />
      )}
      <div className="turn-body">
        <div className="turn-head">
          <span className="turn-who">{speaker === "agent" ? "Agent" : customer.name}</span>
          {at != null && <span className="turn-at">{clock(at)}</span>}
          {confidence != null && <span className="turn-at">{Math.round(confidence * 100)}%</span>}
        </div>
        <div className="turn-text">
          {text}
          {tags.map((tag) => (
            <span className="tag tag-guardrail" key={`${tag.guardrail}-${tag.at}`} title={tag.detail}>
              {tag.guardrail.replace(/_/g, " ")}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

/** A transcript the engine refused: what was heard, struck out, and why. */
function DroppedLine({ drop, customer }: { drop: Drop; customer: Customer }) {
  return (
    <div className="turn turn-customer turn-dropped">
      <Portrait id={customer.id} name={customer.name} size={24} className="turn-avatar" />
      <div className="turn-body">
        <div className="turn-head">
          <span className="turn-who">{customer.name}</span>
          <span className="turn-at">{clock(drop.at)}</span>
          {drop.confidence != null && <span className="turn-at">{Math.round(drop.confidence * 100)}%</span>}
        </div>
        <div className="turn-text">
          <s>{drop.text}</s>
          <span className="tag tag-dropped" title={`dropped: ${drop.reason}`}>
            dropped · {DROP_REASON[drop.reason] ?? drop.reason}
          </span>
        </div>
      </div>
    </div>
  );
}

function clock(at: number): string {
  return new Date(at).toISOString().slice(14, 19);
}

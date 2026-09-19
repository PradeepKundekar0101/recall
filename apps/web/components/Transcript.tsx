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

export function Transcript({
  lines,
  interim,
  guardrails,
  customer,
  brief = null,
}: {
  lines: TranscriptLine[];
  interim: { speaker: "agent" | "customer"; text: string } | null;
  guardrails: Tag[];
  customer: Customer;
  /** The operator's brief, shown once at the top so the room can hear it applied. */
  brief?: string | null;
}) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [lines.length, interim?.text]);

  const note = brief ? (
    <div className="brief-note">
      <span className="label">Brief</span>
      <p>{brief}</p>
    </div>
  ) : null;

  if (!lines.length && !interim) {
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

  return (
    <>
      {note}
      {lines.map((line, i) => {
        // Guardrail triggers render inline at the turn they fired on, which is
        // what makes "the disclosure came before any question" checkable.
        const tags = guardrails.filter(
          (g) => g.at >= line.at && g.at < (lines[i + 1]?.at ?? Number.MAX_SAFE_INTEGER)
        );
        return (
          <TurnLine
            key={`${line.at}-${i}`}
            speaker={line.speaker}
            text={line.text}
            at={line.at}
            confidence={line.confidence}
            tags={tags}
            customer={customer}
          />
        );
      })}

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

function clock(at: number): string {
  return new Date(at).toISOString().slice(14, 19);
}

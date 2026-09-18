"use client";

import { useEffect, useRef } from "react";
import type { TranscriptLine } from "@recall/shared";

/**
 * Speaker-separated transcript. Interim results render grey and italic until the
 * final arrives, so the room can see the recognition settling in real time.
 */
export function Transcript({
  lines,
  interim,
  guardrails,
}: {
  lines: TranscriptLine[];
  interim: { speaker: "agent" | "customer"; text: string } | null;
  guardrails: { guardrail: string; detail: string; at: number }[];
}) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [lines.length, interim?.text]);

  if (!lines.length && !interim) {
    return <p className="empty">The transcript starts when the customer picks up.</p>;
  }

  return (
    <>
      {lines.map((line, i) => {
        // Guardrail triggers render inline at the turn they fired on, which is
        // what makes "the disclosure came before any question" checkable.
        const tags = guardrails.filter(
          (g) => g.at >= line.at && g.at < (lines[i + 1]?.at ?? Number.MAX_SAFE_INTEGER)
        );
        return (
          <div className={`turn turn-${line.speaker}`} key={`${line.at}-${i}`}>
            <div className="turn-head">
              <span className="turn-who">{line.speaker}</span>
              <span className="turn-at">{clock(line.at)}</span>
              {line.confidence != null && (
                <span className="turn-at">{Math.round(line.confidence * 100)}%</span>
              )}
            </div>
            <div className="turn-text">
              {line.text}
              {tags.map((tag) => (
                <span className="tag tag-guardrail" key={`${tag.guardrail}-${tag.at}`} title={tag.detail}>
                  {tag.guardrail.replace(/_/g, " ")}
                </span>
              ))}
            </div>
          </div>
        );
      })}

      {interim && (
        <div className={`turn turn-${interim.speaker} turn-interim`}>
          <div className="turn-head">
            <span className="turn-who">{interim.speaker}</span>
          </div>
          <div className="turn-text">{interim.text}</div>
        </div>
      )}
      <div ref={endRef} />
    </>
  );
}

function clock(at: number): string {
  return new Date(at).toISOString().slice(14, 19);
}

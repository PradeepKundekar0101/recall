"use client";

import type { CSSProperties } from "react";
import type { CallStatus } from "@recall/shared";

/**
 * The agent, drawn the way ElevenLabs draws an agent: as an orb.
 *
 * It is the one thing in the console that moves on its own. Idle it sits still
 * and a little desaturated; it pulses while the line rings, breathes while the
 * call is live and quickens while the agent is talking, takes a rose ring when
 * the call is handed to a person, and greys out when the line drops. The same
 * orb, small, marks every agent line in the transcript, so the thing talking on
 * the phone and the thing on screen are recognisably one thing.
 */
export type OrbStatus = CallStatus | "idle" | "lost";

export function Orb({
  status,
  speaking = null,
  size = 48,
}: {
  status: OrbStatus;
  /** Who the interim transcript currently belongs to, if anyone. */
  speaking?: "agent" | "customer" | null;
  size?: number;
}) {
  const classes = ["orb", `orb-${status}`, speaking ? `orb-speaking-${speaking}` : ""]
    .filter(Boolean)
    .join(" ");
  return (
    <span className={classes} style={{ "--orb-size": `${size}px` } as CSSProperties} aria-hidden="true">
      <span className="orb-ring" />
      <img className="orb-img" src="/brand/orb.png" alt="" width={size} height={size} draggable={false} />
    </span>
  );
}

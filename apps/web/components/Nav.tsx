"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { Stepper, type Phase } from "./Stepper";

/**
 * The top bar every page shares: the wordmark home, the three steps where a
 * call is being set up or watched, and whatever the page puts on the right.
 */
export function Nav({ phase, children }: { phase?: Phase; children?: ReactNode }) {
  return (
    <header className="nav">
      <Link href="/" className="wordmark" aria-label="Recall home">
        <span className="wordmark-name">Recall</span>
        <span className="wordmark-sub">Recovery call</span>
      </Link>
      {phase && <Stepper phase={phase} />}
      <span className="spacer" />
      {children}
    </header>
  );
}

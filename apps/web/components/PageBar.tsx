"use client";

import type { ReactNode } from "react";
import { Stepper, type Phase } from "./Stepper";

/**
 * The bar across the top of a page: the three steps where a call is being set
 * up or watched, and whatever the page puts on the right.
 *
 * Only what belongs to the page you are on. Where you can go is the rail down
 * the left instead. The bar keeps its height on a page that passes it neither -
 * analytics is one - so that the rail's wordmark and a page's first heading sit
 * on the same line whichever route you are on.
 */
export function PageBar({ phase, children }: { phase?: Phase; children?: ReactNode }) {
  return (
    <header className="pagebar">
      {phase && <Stepper phase={phase} />}
      <span className="spacer" />
      {children}
    </header>
  );
}

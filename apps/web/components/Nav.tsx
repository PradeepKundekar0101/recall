"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { Stepper, type Phase } from "./Stepper";

/**
 * The two standing views. Setting up a call is a flow with its own steps and
 * its own entry point, so it is the wordmark rather than a third link here.
 */
const VIEWS = [
  { href: "/calls", label: "Calls" },
  { href: "/analytics", label: "Analytics" },
];

/**
 * The top bar every page shares: the wordmark home, the standing views, the
 * three steps where a call is being set up or watched, and whatever the page
 * puts on the right.
 */
export function Nav({ phase, children }: { phase?: Phase; children?: ReactNode }) {
  const pathname = usePathname();

  return (
    <header className="nav">
      <Link href="/" className="wordmark" aria-label="Recall home">
        <span className="wordmark-name">Recall</span>
        <span className="wordmark-sub">Recovery call</span>
      </Link>
      <nav className="nav-links" aria-label="Views">
        {VIEWS.map((view) => {
          // Exact, not a prefix. A call's own page is under /calls but is not the
          // list, and this link is the only way back to it: marking it current
          // there would tell a screen reader there is no list to go to.
          const current = pathname === view.href;
          return (
            <Link
              key={view.href}
              href={view.href}
              className={current ? "nav-link nav-link-on" : "nav-link"}
              aria-current={current ? "page" : undefined}
            >
              {view.label}
            </Link>
          );
        })}
      </nav>
      {phase && <Stepper phase={phase} />}
      <span className="spacer" />
      {children}
    </header>
  );
}

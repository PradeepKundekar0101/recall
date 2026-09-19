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
          // A call's own page lives under /calls, and the operator who opened it
          // from the list is still in the list as far as the nav is concerned.
          const current = pathname === view.href || pathname.startsWith(`${view.href}/`);
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

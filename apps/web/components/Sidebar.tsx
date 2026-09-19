"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * The two standing views. Setting up a call is a flow with its own steps and
 * its own entry point, so it is the wordmark above rather than a third link
 * here.
 */
const VIEWS = [
  { href: "/calls", label: "Calls" },
  { href: "/analytics", label: "Analytics" },
];

/**
 * The console's left rail: the wordmark home over the standing views. Every
 * page shares it. What belongs to the page you are on - the steps, its own
 * actions - is the bar across the top instead.
 */
export function Sidebar() {
  const pathname = usePathname();

  return (
    <div className="sidebar">
      <div className="sidebar-head">
        <Link href="/" className="wordmark" aria-label="Recall home">
          <span className="wordmark-name">Recall</span>
          <span className="wordmark-sub">Recovery call</span>
        </Link>
      </div>
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
    </div>
  );
}

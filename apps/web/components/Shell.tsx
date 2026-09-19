import type { ReactNode } from "react";
import { Sidebar } from "./Sidebar";

/**
 * The console's frame: the standing rail on the left, the page in a column
 * beside it.
 *
 * Every console page is wrapped in this. The handoff console is not - it is
 * opened on a second laptop to carry one packet, and giving it somewhere else
 * to go would make it the thing it was written not to be.
 */
export function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="console">
      <Sidebar />
      <div className="console-main">{children}</div>
    </div>
  );
}

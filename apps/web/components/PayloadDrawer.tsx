"use client";

import { useState } from "react";

/**
 * The payload the receiving system will get on the final submit, updating live.
 *
 * Collapsed by default so it does not steal the form's room, and it turns green on
 * a 2xx - the moment the working-outcome criterion is actually satisfied. The
 * incremental saves are the API logs pane's job; this is the shape of the whole
 * journey rather than the requests that built it.
 */
export function PayloadDrawer({
  payload,
  submissions,
}: {
  payload: unknown;
  submissions: { step: string; status: number; body: unknown }[];
}) {
  const [open, setOpen] = useState(false);
  const final = submissions.find((s) => s.step === "final");
  const ok = final ? final.status >= 200 && final.status < 300 : null;

  return (
    <div className="drawer">
      <button className="drawer-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="label">Final payload</span>
        {final ? (
          <span className={`chip ${ok ? "chip-success" : "chip-error"}`}>
            {final.status} {ok ? "accepted" : "rejected"}
          </span>
        ) : (
          <span className="pane-meta">Not submitted</span>
        )}
        <span className="spacer" />
        <span className="drawer-toggle">{open ? "Hide" : "Show"}</span>
      </button>

      {open && (
        <div className="drawer-body">
          {JSON.stringify(payload, null, 2)}
          {final != null && !ok && (
            <div className="drawer-err" style={{ marginTop: 10 }}>
              {JSON.stringify(final.body, null, 2)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

"use client";

import { useState } from "react";

/**
 * The payload the sandbox will receive, updating live.
 *
 * Collapsed by default so it does not steal the form's room, and it turns green on
 * a 2xx - the moment the working-outcome criterion is actually satisfied.
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
        <span className="label">Sandbox payload</span>
        <span className={ok === null ? "" : ok ? "drawer-ok" : "drawer-err"}>
          {final ? `${final.status} ${ok ? "accepted" : "rejected"}` : "not submitted"}
        </span>
        {submissions.length > 0 && (
          <span className="meter-score">
            {submissions.filter((s) => s.step !== "final").length} section saves
          </span>
        )}
        <span className="bar-spacer" />
        <span className="meter-score">{open ? "hide" : "show"}</span>
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

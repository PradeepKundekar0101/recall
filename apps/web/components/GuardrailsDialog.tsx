"use client";

import { useEffect, useRef, useState } from "react";
import type { GuardrailReport } from "@recall/shared";
import { getJson } from "../lib/api";

/**
 * What the system refuses to do, from the process that does the refusing.
 *
 * The content is fetched rather than written here. A guardrail list typed into
 * a component is a promise the code stops keeping the moment somebody changes
 * a setting - it would go on saying "no number outside the allowlist is ever
 * dialled" over an allowlist that had since been emptied. `GET /guardrails` is
 * built from the same `env` and `policy` the dial path reads, so this pane and
 * the next call cannot disagree.
 *
 * A native `<dialog>` rather than a hand-rolled overlay: the focus trap, the
 * Escape key, the inert background and the backdrop are all behaviour we would
 * otherwise have to write and would write slightly wrong.
 */
export function GuardrailsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [report, setReport] = useState<GuardrailReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    if (!open || report) return;
    let live = true;
    void getJson<GuardrailReport>("/guardrails")
      .then((data) => live && setReport(data))
      .catch((err: unknown) => live && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      live = false;
    };
  }, [open, report]);

  return (
    <dialog
      ref={ref}
      className="sheet"
      aria-labelledby="guardrails-title"
      // Fires however it closed - the native close request, or our own call.
      onClose={onClose}
      /**
       * Escape, explicitly, rather than only through the browser's own close
       * request on a modal dialog.
       *
       * The native behaviour is real and does the right thing in a browser
       * somebody is typing in. It is also the one part of this that could not
       * be exercised here - an injected Escape reaches the document without
       * producing a trusted close request - so relying on it alone would mean
       * shipping the dismissal untested. Both paths end in the same setState,
       * and a second call with the same value is a no-op.
       */
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
      onClick={(event) => {
        // A click on the dialog element itself is a click on the backdrop:
        // everything inside is wrapped in the body below.
        if (event.target === ref.current) onClose();
      }}
    >
      <div className="sheet-body">
        <div className="sheet-head">
          <div>
            <h2 className="sheet-title" id="guardrails-title">
              Guardrails
            </h2>
            <p className="sheet-sub">
              Six rules no journey can opt out of. Read live from the orchestrator that will place the call, not
              written into this page.
            </p>
          </div>
          <button type="button" className="btn btn-outline btn-sm" onClick={onClose}>
            Close
          </button>
        </div>

        {error && (
          <div className="notice" role="status">
            Could not reach the orchestrator, so this is showing nothing rather than something out of date. {error}
          </div>
        )}

        {!report && !error && <p className="empty">Reading the guardrails off the orchestrator...</p>}

        {report && (
          <>
            <ol className="guardrails">
              {report.guardrails.map((guardrail) => (
                <li className="guardrail" key={guardrail.id}>
                  <div className="guardrail-head">
                    {/* The number, not the id: the id is only ever a shoutier
                        spelling of the title beside it, whereas the number is
                        how the source comments refer to these ("Guardrail 3:
                        a digit run never reaches the transcript"). */}
                    <span className="guardrail-number" aria-hidden="true">
                      {guardrail.number}
                    </span>
                    <span className="guardrail-title">{guardrail.title}</span>
                  </div>
                  <p className="guardrail-rule">{guardrail.rule}</p>

                  <dl className="guardrail-facts">
                    {guardrail.facts.map((fact) => (
                      <div key={fact.label}>
                        <dt>{fact.label}</dt>
                        <dd>{fact.value}</dd>
                      </div>
                    ))}
                  </dl>

                  <div className="guardrail-where">
                    <span className="label">Enforced at</span>
                    <ul>
                      {guardrail.enforced_at.map((where) => (
                        <li key={where}>{where}</li>
                      ))}
                    </ul>
                  </div>

                  {/* A guardrail that is currently weakened says so here rather
                      than being quietly absent from the list. */}
                  {guardrail.relaxed && <p className="guardrail-relaxed">{guardrail.relaxed}</p>}
                </li>
              ))}
            </ol>

            <div className="guardrail-window">
              <span className="label">{report.call_window.label}</span>
              <span>{report.call_window.value}</span>
              {report.call_window.relaxed && (
                <span className="guardrail-relaxed">{report.call_window.relaxed}</span>
              )}
            </div>
          </>
        )}
      </div>
    </dialog>
  );
}

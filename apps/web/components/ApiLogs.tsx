"use client";

import { useEffect, useRef, useState } from "react";
import type { ApiCall } from "../lib/useCallStream";

/**
 * Every request made to the receiving system, as it happens.
 *
 * The claim this pane exists to settle is "the data is saved as the call goes",
 * and a claim about an integration is worth nothing unless the room can see the
 * request and the response. So each row is one real HTTP call - method, path,
 * status, round trip - and opening it shows the JSON that went out and the JSON
 * that came back.
 *
 * Oldest first with the newest scrolled to, so it reads as a log rather than a
 * list that reorders itself while someone is pointing at it.
 *
 * The pane owns its own height because those two states want different amounts of
 * it: closed, it is a ticker and must not steal room from the three panes above;
 * open, someone is reading JSON and needs to be able to.
 */
export function ApiLogs({ calls, leadId }: { calls: ApiCall[]; leadId: string | null }) {
  const [open, setOpen] = useState<number | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  // The pane's own body, scrolled by hand. scrollIntoView would have scrolled
  // every scrollable ancestor as well, so each field saved during a call
  // dragged the whole page down to the log and the transcript off the top of
  // it - the pane pulling the screen to itself for a row nobody asked to see.
  useEffect(() => {
    const body = bodyRef.current;
    if (body) body.scrollTop = body.scrollHeight;
  }, [calls.length]);

  return (
    <section className={`pane pane-flat ${open === null ? "" : "pane-flat-open"}`} aria-label="API logs">
      <div className="pane-head">
        <span className="pane-title">API logs</span>
        <span className="pane-meta">{summarise(calls, leadId)}</span>
      </div>
      <div className="pane-body" ref={bodyRef}>
        {calls.length === 0 ? (
          <p className="empty">
            Nothing saved yet. Every field is written to the CRM the moment the customer confirms it, and each
            request and response appears here.
          </p>
        ) : (
          <ol className="apilog">
            {calls.map((call, i) => {
              const good = ok(call);
              const isFinal = call.step === "final";
              return (
                <li key={`${call.at}-${i}`} className={`apirow ${good ? "api-ok" : "api-bad"}`}>
                  <button
                    className="apirow-head"
                    onClick={() => setOpen((v) => (v === i ? null : i))}
                    aria-expanded={open === i}
                  >
                    <span className={`apimethod ${call.method === "POST" ? "apimethod-post" : ""}`}>
                      {call.method}
                    </span>
                    <span className="apipath">{call.path}</span>
                    <span className="spacer" />
                    {isFinal && <span className="apitag">journey submit</span>}
                    <span className={`chip ${good ? "chip-success" : "chip-error"}`}>
                      {call.status === 0 ? "no response" : call.status}
                    </span>
                    <span className="apims">{call.ms} ms</span>
                    <span className="apichevron" aria-hidden>
                      {open === i ? "−" : "+"}
                    </span>
                  </button>

                  {open === i && (
                    <div className="apibody">
                      <div className="apiside">
                        <span className="label">Request sent</span>
                        <pre className="apijson">{JSON.stringify(call.request, null, 2)}</pre>
                      </div>
                      <div className="apiside">
                        <span className="label">Response received</span>
                        <pre className={`apijson ${good ? "" : "drawer-err"}`}>
                          {call.error ?? JSON.stringify(call.body, null, 2)}
                        </pre>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </section>
  );
}

/**
 * The one-line summary for the pane header.
 *
 * Distinct fields rather than requests, because a field that failed and was saved
 * on the retry is one field held, not two - and "how much does the CRM have now" is
 * the question this line answers. The request count sits beside it so a retry is
 * still visible rather than rounded away.
 */
function summarise(calls: ApiCall[], leadId: string | null): string {
  if (!calls.length) return leadId ? `${leadId} · nothing sent yet` : "Nothing sent yet";

  const saved = new Set(calls.filter((c) => c.step !== "final" && ok(c)).map((c) => c.step));
  const failed = calls.filter((c) => !ok(c)).length;

  const parts = [
    `${saved.size} ${saved.size === 1 ? "field" : "fields"} saved`,
    `${calls.length} ${calls.length === 1 ? "request" : "requests"}`,
  ];
  if (failed) parts.push(`${failed} failed`);
  if (calls.some((c) => c.step === "final" && ok(c))) parts.push("journey submitted");
  return parts.join(" · ");
}

function ok(call: ApiCall): boolean {
  return call.status >= 200 && call.status < 300;
}

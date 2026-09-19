"use client";

import { useEffect, useState } from "react";
import type { AnalyticsResponse, AnalyticsWindow } from "@recall/shared";
import { ApiError, getJson } from "../../lib/api";
import { Nav } from "../../components/Nav";
import { StatTile } from "../../components/analytics/StatTile";
import { Histogram } from "../../components/analytics/Histogram";
import { StageBars } from "../../components/analytics/StageBars";
import { KindSplit } from "../../components/analytics/KindSplit";
import { TrendChart } from "../../components/analytics/TrendChart";
import { OutcomeBar } from "../../components/analytics/OutcomeBar";
import { FieldTable } from "../../components/analytics/FieldTable";
import { Thin } from "../../components/analytics/Thin";
import { ms, pct } from "../../lib/analytics";

const WINDOWS: { id: AnalyticsWindow; label: string }[] = [
  { id: "24h", label: "24 hours" },
  { id: "7d", label: "7 days" },
  { id: "30d", label: "30 days" },
  { id: "all", label: "All time" },
];

/**
 * The share of fields the agent has to get without a human, from the project's
 * own acceptance criterion.
 *
 * This one is written here rather than read off the response, unlike the budget
 * and the thin-data threshold: nothing server-side measures against it, so
 * there is no number over there for this to drift from.
 */
const HANDS_FREE_BAR = 0.25;

/** What went wrong, and the orchestrator's own words about it where it sent any. */
type Failure = { title: string; detail: string | null };

/**
 * Is the agent fast, and is it accurate.
 *
 * Simulated calls are excluded by default. A simulated call with mocked voice
 * returns TTS instantly and scores every turn at 95%, so counting them makes
 * the agent look several times faster and more accurate than it is.
 */
export default function Analytics() {
  const [windowId, setWindowId] = useState<AnalyticsWindow>("7d");
  const [includeSimulated, setIncludeSimulated] = useState(false);
  const [data, setData] = useState<AnalyticsResponse | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);

  useEffect(() => {
    let live = true;
    setFailure(null);
    // Cleared rather than left on screen: the controls would otherwise name one
    // window while every number under them still belonged to the last one.
    setData(null);
    const source = includeSimulated ? "all" : "dialled";
    void getJson<AnalyticsResponse>(`/analytics?window=${windowId}&source=${source}`)
      .then((next) => {
        if (live) setData(next);
      })
      .catch((err: unknown) => {
        if (live) setFailure(describe(err));
      });
    return () => {
      live = false;
    };
  }, [windowId, includeSimulated]);

  return (
    <div className="console">
      <Nav />

      <section className="step-body analytics" aria-label="Analytics">
        <div className="intro">
          <h1 className="intro-title">Analytics</h1>
          <p className="intro-sub">
            Whether the agent is fast enough to hold a phone call, and accurate enough to be trusted with the form.
          </p>
        </div>

        <div className="analytics-controls">
          <div className="segmented" role="group" aria-label="Time window">
            {WINDOWS.map((option) => (
              <button
                key={option.id}
                type="button"
                className={`segmented-option${windowId === option.id ? " is-on" : ""}`}
                aria-pressed={windowId === option.id}
                onClick={() => setWindowId(option.id)}
              >
                {option.label}
              </button>
            ))}
          </div>
          <label className="toggle">
            <input
              type="checkbox"
              checked={includeSimulated}
              onChange={(event) => setIncludeSimulated(event.target.checked)}
            />
            Include simulated calls
          </label>
          {/* What the window on the left resolved to. "7 days" is a label; this
              is the population every number below it was counted over. */}
          {data && <p className="provenance">{covered(data.window)}</p>}
        </div>

        {failure && (
          <div className="notice" role="status">
            <span>{failure.title}</span>
            {failure.detail && <span className="notice-detail">{failure.detail}</span>}
          </div>
        )}

        {!data && !failure && <p className="empty">Reading the audit trail.</p>}

        {data && <Dashboard data={data} />}
      </section>
    </div>
  );
}

/** Everything that needs a response to exist, so the nulls stay in one place. */
function Dashboard({ data }: { data: AnalyticsResponse }) {
  const budget = data.latency.budget_ms;
  const p50 = data.latency.first_audio?.p50 ?? null;
  const handsFree = data.accuracy.hands_free_rate;
  // The page's whole argument is that a number without its population is not a
  // verdict, and that holds for the tiles as much as for the trend. Under the
  // threshold the numbers and their meters still show - they are what was
  // measured - but neither is coloured as a pass or a fail.
  const judged = !data.thin;

  return (
    <>
      <div className="analytics-tiles">
        <StatTile
          label="Median time to reply"
          value={ms(p50)}
          sub={`against an ${budget}ms budget`}
          tone={p50 === null || !judged ? "neutral" : p50 <= budget ? "good" : "bad"}
          meter={p50 === null ? null : p50 / budget}
        />
        <StatTile
          label="Hands free"
          value={pct(handsFree)}
          sub={`${data.accuracy.hands_free_captured} of ${data.accuracy.hands_free_total} fields, the bar is ${pct(HANDS_FREE_BAR)}`}
          tone={handsFree === null || !judged ? "neutral" : handsFree >= HANDS_FREE_BAR ? "good" : "warn"}
          meter={handsFree}
        />
        <StatTile
          label="Submitted"
          value={pct(data.accuracy.submitted_rate)}
          sub={`${data.totals.by_outcome.submitted ?? 0} of ${data.totals.calls} calls`}
          tone="neutral"
          meter={data.accuracy.submitted_rate}
        />
        <StatTile
          label="Calls"
          value={String(data.totals.calls)}
          sub={
            data.window.source === "all"
              ? `${data.totals.simulated} simulated counted in`
              : `${data.totals.simulated} simulated left out`
          }
          tone="neutral"
        />
      </div>

      {/* Said once, quietly, rather than repeated into every tile's sub: the two
          tiles that carry a threshold are the ones the grey is about. */}
      {!judged && (
        <p className="tiles-note">
          {data.totals.calls} {data.totals.calls === 1 ? "call" : "calls"} in this window. A verdict needs at least{" "}
          {data.thin_threshold}, so the numbers above are drawn without one.
        </p>
      )}

      <div className="analytics-row">
        <section className="card">
          <header className="card-lede">
            <h2 className="card-title">Time to reply, every turn</h2>
            <p className="card-sub">
              {data.latency.turns} {data.latency.turns === 1 ? "turn" : "turns"}, {data.latency.over_budget} over the{" "}
              {budget}ms budget.
            </p>
          </header>
          {data.latency.turns === 0 ? (
            <p className="empty">No measured turns yet. Run a call.</p>
          ) : (
            <Histogram buckets={data.latency.histogram} budgetMs={budget} />
          )}
        </section>

        <section className="card">
          <header className="card-lede">
            <h2 className="card-title">Where the turn goes</h2>
            <p className="card-sub">At the median. The three stages tile the turn.</p>
          </header>
          {p50 === null ? (
            <p className="empty">No measured turns yet.</p>
          ) : (
            <>
              <StageBars
                total={p50}
                stages={[
                  {
                    id: "think",
                    label: "Think",
                    p50: data.latency.stages.think?.p50 ?? null,
                    hint: "transcript to reply decided",
                  },
                  {
                    id: "wire",
                    label: "Wire wait",
                    p50: data.latency.stages.wire_wait?.p50 ?? null,
                    hint: "previous line still playing",
                  },
                  {
                    id: "tts",
                    label: "TTS",
                    p50: data.latency.stages.tts_ttfb?.p50 ?? null,
                    hint: "text to first audio frame",
                  },
                ]}
              />
              {/* The bar above blends every kind of turn together, which is the
                  one thing TurnKind exists to stop. Same card, because the split
                  is a reading of the bar rather than a second subject. */}
              <KindSplit byKind={data.latency.by_kind} />
            </>
          )}
        </section>
      </div>

      <div className="analytics-row">
        <section className="card">
          <header className="card-lede">
            <h2 className="card-title">Over time</h2>
            <p className="card-sub">One median a day, and how many calls stood behind it.</p>
          </header>
          {data.thin ? (
            <Thin calls={data.totals.calls} threshold={data.thin_threshold} what="A daily trend" />
          ) : data.trend.length < 2 ? (
            <p className="empty">One day of calls so far. A line needs two.</p>
          ) : (
            <TrendChart points={data.trend} budgetMs={budget} />
          )}
        </section>

        <section className="card">
          <header className="card-lede">
            <h2 className="card-title">How calls ended</h2>
          </header>
          {data.totals.calls === 0 ? (
            <p className="empty">No calls in this window.</p>
          ) : (
            <OutcomeBar counts={data.totals.by_outcome} />
          )}
        </section>
      </div>

      <div className="analytics-row">
        <section className="card">
          <header className="card-lede">
            <h2 className="card-title">Which question the agent fumbles</h2>
            <p className="card-sub">Worst first, by re-asks per call that reached the field.</p>
          </header>
          <FieldTable fields={data.fields} />
        </section>

        <section className="card">
          <header className="card-lede">
            <h2 className="card-title">Usage</h2>
            <p className="card-sub">What the window cost the two vendors.</p>
          </header>
          <ul className="usage-list">
            <li>
              <span>Prompt tokens</span>
              <span>{data.usage.prompt_tokens.toLocaleString()}</span>
            </li>
            <li>
              <span>Completion tokens</span>
              <span>{data.usage.completion_tokens.toLocaleString()}</span>
            </li>
            <li>
              <span>TTS characters synthesised</span>
              <span>{data.usage.tts_chars_synthesised.toLocaleString()}</span>
            </li>
            <li>
              <span>TTS characters played from cache</span>
              <span>{(data.usage.tts_chars - data.usage.tts_chars_synthesised).toLocaleString()}</span>
            </li>
          </ul>
        </section>
      </div>
    </>
  );
}

/**
 * A failure in the operator's terms.
 *
 * An orchestrator that is down and one that is up but cannot read its audit
 * trail need different things done about them, so they are not collapsed into
 * one message. The server's own words go on a second line rather than inside
 * the first: its 503 body already carries a colon.
 */
function describe(err: unknown): Failure {
  if (!(err instanceof ApiError)) return { title: "Orchestrator is not reachable.", detail: null };
  if (err.status === 503) {
    return {
      title: "The orchestrator cannot read its audit trail, so there is nothing to count.",
      detail: err.detail,
    };
  }
  return { title: `The orchestrator answered ${err.status} for this window.`, detail: err.detail };
}

/** The dates the window resolved to, as the line under the control that set it. */
function covered(window: AnalyticsResponse["window"]): string {
  const to = at(window.to);
  return window.from === null ? `Every call on record, to ${to}` : `${at(window.from)} to ${to}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * "19 Sep 14:22", in the reader's own timezone.
 *
 * Hand-built rather than toLocaleString: Node's ICU says "Sept" where a browser
 * says "Sep", and this page is one route away from being server-rendered.
 */
function at(iso: string): string {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return iso;
  const hh = String(when.getHours()).padStart(2, "0");
  const mm = String(when.getMinutes()).padStart(2, "0");
  return `${when.getDate()} ${MONTHS[when.getMonth()] ?? ""} ${hh}:${mm}`;
}

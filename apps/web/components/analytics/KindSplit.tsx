import type { AnalyticsResponse, Stats, TurnKind } from "@recall/shared";
import { ms } from "../../lib/analytics";

/** The kinds in the order they cost, cheapest first, so the list reads as a climb. */
const ORDER: TurnKind[] = ["closed_field", "cached_line", "synthesised"];

/** What the turn actually did, rather than what the enum calls it. */
const KIND_LABEL: Record<TurnKind, string> = {
  closed_field: "Matched in code",
  cached_line: "Played from cache",
  synthesised: "Synthesised live",
};

type Row = { kind: TurnKind; stats: Stats };

/**
 * First audio at the median, one row per kind of turn.
 *
 * This sits under the blended stage bar because the blend is only honest with
 * it: a closed field resolves in single-digit milliseconds and a synthesised
 * line waits on a TTS socket, so one median across them is an average of three
 * different questions. Drawn on a scale the three rows share, which is the
 * whole point - the gap between them is the finding, and three numbers in a
 * column do not show a gap.
 *
 * A kind with no turns in the window is left out rather than drawn empty. An
 * empty row claims a measurement of zero where there was no measurement.
 */
export function KindSplit({ byKind }: { byKind: AnalyticsResponse["latency"]["by_kind"] }) {
  const rows = ORDER.map((kind) => ({ kind, stats: byKind[kind] })).filter(
    (row): row is Row => row.stats !== null
  );
  if (!rows.length) return null;

  // Floored at 1 so a window of nothing but sub-millisecond closed fields still
  // divides, rather than putting every bar at NaN percent.
  const worst = Math.max(1, ...rows.map((row) => row.stats.p50));

  return (
    <div className="kinds">
      <p className="kinds-lede">
        A closed field and a synthesised line are different questions, so their medians are counted apart.
      </p>
      <ul className="kinds-list">
        {rows.map(({ kind, stats }) => (
          <li key={kind}>
            <span className="kinds-name">{KIND_LABEL[kind]}</span>
            {/* One reading per row rather than one for the bar and one for the
                figures beside it: the row is a single fact. */}
            <span
              className="kinds-track"
              role="img"
              aria-label={`${KIND_LABEL[kind]}: median ${ms(stats.p50)} over ${turns(stats.n)}`}
            >
              <span className="kinds-fill" style={{ width: `${(stats.p50 / worst) * 100}%` }} />
            </span>
            <span className="kinds-ms">{ms(stats.p50)}</span>
            {/* The count travels with the median because a median over two turns
                is not the same claim as a median over two hundred. */}
            <span className="kinds-n">{turns(stats.n)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function turns(n: number): string {
  return `${n} ${n === 1 ? "turn" : "turns"}`;
}

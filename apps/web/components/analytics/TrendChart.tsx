import type { TrendPoint } from "@recall/shared";

const WIDTH = 640;
const HEIGHT = 186;
const PAD = { left: 40, right: 12, top: 14 };
const PLOT_WIDTH = WIDTH - PAD.left - PAD.right;
const PLOT_HEIGHT = 112;
const BASE_Y = PAD.top + PLOT_HEIGHT;
/** The volume band sits under the axis rule, with its own baseline. */
const VOLUME_TOP = BASE_Y + 16;
const VOLUME_HEIGHT = 26;
const VOLUME_BASE = VOLUME_TOP + VOLUME_HEIGHT;
const MAX_BAR = 24;

/**
 * Median time to reply per day, with how many calls stand behind each day.
 *
 * The call count is drawn in its own band below the axis rather than as bars
 * inside the plot. Two measures on one pair of axes invent a relationship the
 * data does not have: a volume bar reaching half the plot height would be read
 * against the millisecond scale beside it, which it has nothing to do with.
 */
export function TrendChart({ points, budgetMs }: { points: TrendPoint[]; budgetMs: number }) {
  if (points.length < 2) return null;

  const latencies = points.map((p) => p.first_audio_p50).filter((v): v is number => typeof v === "number");
  // Headroom, then up to a round number: without it the worst day lands exactly on
  // the top edge with its own label on top of it, and the axis reads 1180 rather
  // than a number anybody would choose.
  const maxLatency = Math.max(250, Math.ceil(Math.max(budgetMs * 1.25, ...latencies.map((v) => v * 1.12)) / 250) * 250);
  const maxCalls = Math.max(1, ...points.map((p) => p.calls));
  const step = PLOT_WIDTH / (points.length - 1);
  const barWidth = Math.min(Math.max(step - 2, 1), MAX_BAR);

  const x = (i: number) => PAD.left + i * step;
  const y = (ms: number) => PAD.top + PLOT_HEIGHT - (ms / maxLatency) * PLOT_HEIGHT;

  const budgetY = y(budgetMs);
  const first = points[0];
  const last = points[points.length - 1];

  return (
    <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="chart" role="group" aria-label="Median time to reply per day">
      <line
        x1={PAD.left}
        y1={budgetY}
        x2={WIDTH - PAD.right}
        y2={budgetY}
        stroke="var(--error-line)"
        strokeDasharray="4 3"
        aria-hidden="true"
      />
      {/* In the axis gutter, not on the plot: a threshold written over the middle of
          the chart lands on whichever day happens to sit nearest it. */}
      <text x={PAD.left - 5} y={budgetY + 3} textAnchor="end" className="chart-note" fill="var(--error)" aria-hidden="true">
        {budgetMs}
      </text>

      {runs(points).map((run) => (
        <path
          key={run[0]?.day}
          d={run.map((at, n) => `${n === 0 ? "M" : "L"}${x(at.index)},${y(at.ms)}`).join(" ")}
          fill="none"
          stroke="var(--info-line)"
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
          aria-hidden="true"
        />
      ))}

      {points.map((point, i) =>
        typeof point.first_audio_p50 === "number" ? (
          // A 2px ring in the surface colour, so a dot stays a dot where it sits
          // on top of the line it belongs to.
          <circle
            key={point.day}
            cx={x(i)}
            cy={y(point.first_audio_p50)}
            r="4"
            fill="var(--info)"
            stroke="var(--surface)"
            strokeWidth="2"
            role="img"
          >
            <title>{`${day(point.day)}: ${point.first_audio_p50}ms median`}</title>
          </circle>
        ) : null,
      )}

      {typeof last?.first_audio_p50 === "number" && (
        <text
          x={WIDTH - PAD.right}
          y={Math.max(y(last.first_audio_p50) - 12, PAD.top + 8)}
          textAnchor="end"
          className="chart-note"
          fill="var(--body)"
          aria-hidden="true"
        >
          {last.first_audio_p50}ms
        </text>
      )}

      <line x1={PAD.left} y1={BASE_Y} x2={WIDTH - PAD.right} y2={BASE_Y} stroke="var(--hairline-strong)" aria-hidden="true" />
      <text x={4} y={PAD.top + 4} className="chart-axis" fill="var(--muted)" aria-hidden="true">
        {maxLatency}
      </text>
      <text x={4} y={BASE_Y} className="chart-axis" fill="var(--muted)" aria-hidden="true">
        0
      </text>

      {/* The band is the only place a day's call count is drawn, and on a day with
          no measured turn it is the only mark at all - there is no dot to carry
          the number instead. So the bars are reachable, not decoration. */}
      {points.map((point, i) => {
        const height = (point.calls / maxCalls) * VOLUME_HEIGHT;
        if (height <= 0) return null;
        return (
          <rect
            key={point.day}
            x={x(i) - barWidth / 2}
            y={VOLUME_BASE - height}
            width={barWidth}
            height={height}
            fill="var(--hairline-strong)"
            role="img"
          >
            <title>{`${day(point.day)}: ${point.calls} ${point.calls === 1 ? "call" : "calls"}, ${point.submitted} submitted`}</title>
          </rect>
        );
      })}
      {/* Above the band, not in the gutter beside it: the end bars are centred on
          the plot edges, so they overhang into the gutter at both ends. */}
      <text x={PAD.left} y={VOLUME_TOP - 4} className="chart-axis" fill="var(--muted)" aria-hidden="true">
        Calls a day, peak {maxCalls}
      </text>

      <text x={PAD.left} y={HEIGHT - 6} className="chart-axis" fill="var(--muted)" aria-hidden="true">
        {day(first?.day)}
      </text>
      <text x={WIDTH - PAD.right} y={HEIGHT - 6} textAnchor="end" className="chart-axis" fill="var(--muted)" aria-hidden="true">
        {day(last?.day)}
      </text>
    </svg>
  );
}

/**
 * The runs of consecutive days that actually have a median.
 *
 * A day with no measured turn is a gap, not a value: joining across it would draw
 * a straight line through a day nothing is known about and invite it to be read.
 */
function runs(points: TrendPoint[]): { index: number; day: string; ms: number }[][] {
  const out: { index: number; day: string; ms: number }[][] = [];
  let run: { index: number; day: string; ms: number }[] = [];
  points.forEach((point, index) => {
    const ms = point.first_audio_p50;
    if (typeof ms === "number") {
      run.push({ index, day: point.day, ms });
      return;
    }
    if (run.length > 1) out.push(run);
    run = [];
  });
  if (run.length > 1) out.push(run);
  return out;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * "2026-09-19" as "19 Sep", from the string, with no date library and no locale.
 *
 * toLocaleDateString gives "Sept" under Node's ICU and "Sep" in Chrome, which
 * renders this chart differently on the server and in the browser and fails
 * hydration. Putting the day through a Date at all would be the second bug: the
 * server hands back a bare calendar day, and parsing one into an instant moves
 * it across a date boundary in every timezone behind UTC.
 */
function day(iso: string | undefined): string {
  const parts = iso ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso) : null;
  const month = parts ? MONTHS[Number(parts[2]) - 1] : undefined;
  if (!parts || !month) return iso ?? "";
  return `${Number(parts[3])} ${month}`;
}

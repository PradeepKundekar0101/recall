"use client";

import { useId } from "react";
import type { AnalyticsResponse } from "@recall/shared";

type Bucket = AnalyticsResponse["latency"]["histogram"][number];

const WIDTH = 640;
const HEIGHT = 196;
const PAD = { left: 34, right: 12, top: 18, bottom: 40 };
const PLOT_WIDTH = WIDTH - PAD.left - PAD.right;
const PLOT_HEIGHT = HEIGHT - PAD.top - PAD.bottom;
const BASE_Y = PAD.top + PLOT_HEIGHT;
/** Columns are capped rather than filling their band, so the band's leftover is air. */
const MAX_BAR = 24;

/**
 * The distribution of reply latency, with the budget drawn as a rule.
 *
 * A distribution rather than an average because the average is the one number
 * that cannot show you the tail, and the tail is what breaks calls.
 */
export function Histogram({ buckets, budgetMs }: { buckets: Bucket[]; budgetMs: number }) {
  if (!buckets.length) return null;

  const max = Math.max(1, ...buckets.map((b) => b.count));
  const band = PLOT_WIDTH / buckets.length;
  // Floored: enough buckets and `band - 2` goes negative, which drops every column.
  const barWidth = Math.max(1, Math.min(band - 2, MAX_BAR));
  const ruleX = budgetX(buckets, budgetMs, band);
  const captionId = useId();

  return (
    // aria-describedby, so the caveat under the chart reaches a screen reader
    // with the chart rather than as a loose paragraph after it.
    <figure className="chart-figure">
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="chart"
        role="group"
        aria-label="Time to reply, every measured turn"
        aria-describedby={captionId}>
        <line
          x1={PAD.left}
          y1={PAD.top}
          x2={WIDTH - PAD.right}
          y2={PAD.top}
          stroke="var(--hairline)"
          aria-hidden="true"
        />
        <line
          x1={PAD.left}
          y1={BASE_Y}
          x2={WIDTH - PAD.right}
          y2={BASE_Y}
          stroke="var(--hairline-strong)"
          aria-hidden="true"
        />

        {buckets.map((bucket, i) => {
          if (bucket.count === 0) return null;
          const barHeight = (bucket.count / max) * PLOT_HEIGHT;
          const x = PAD.left + band * i + (band - barWidth) / 2;
          // The rule is the only thing that says whether a turn was fast enough, so
          // which side of it a column sits on is the column's second encoding.
          const overBudget = bucket.from_ms >= budgetMs;
          return (
            <path
              key={bucket.from_ms}
              d={column(x, BASE_Y - barHeight, barWidth, barHeight)}
              fill={overBudget ? "var(--warn-line)" : "var(--info-line)"}
              role="img"
            >
              {/* One string, not several children: React renders a <title> in place
                  only when it is given a single string, and otherwise ships an
                  empty one from the server and fills it in on the client, which
                  is a hydration mismatch and a tooltip that is not there. */}
              <title>{label(bucket)}</title>
            </path>
          );
        })}

        <line
          x1={ruleX}
          y1={PAD.top - 10}
          x2={ruleX}
          y2={BASE_Y}
          stroke="var(--error-line)"
          strokeWidth="1.5"
          strokeDasharray="4 3"
          aria-hidden="true"
        />
        <text
          x={ruleX + 5}
          y={PAD.top - 4}
          className="chart-note"
          fill="var(--error)"
          aria-hidden="true"
        >
          {budgetMs}ms budget
        </text>

        <text x={4} y={PAD.top + 4} className="chart-axis" fill="var(--muted)" aria-hidden="true">
          {max}
        </text>
        <text x={4} y={BASE_Y} className="chart-axis" fill="var(--muted)" aria-hidden="true">
          0
        </text>

        {/* Every other edge, because nine of them under a 640px chart collide. Each
            is centred on the boundary it names, including the last: these are the
            edges between bands, not captions under the columns. */}
        {buckets.map((bucket, i) => {
          if (i % 2 !== 0) return null;
          const last = i === buckets.length - 1;
          return (
            <text
              key={bucket.from_ms}
              x={PAD.left + band * i}
              y={HEIGHT - 14}
              textAnchor={i === 0 ? "start" : "middle"}
              className="chart-axis"
              fill="var(--muted)"
              aria-hidden="true"
            >
              {edge(bucket.from_ms)}
              {last ? "+" : ""}
            </text>
          );
        })}
      </svg>
      <figcaption className="chart-caption" id={captionId}>
        Measured from the customer&apos;s committed transcript to the first audio of the agent&apos;s reply. A short
        filler line can play before that, so this is not how long the line was silent.
      </figcaption>
    </figure>
  );
}

/**
 * A column with a 4px rounded cap and a square foot.
 *
 * `rx` on a `<rect>` rounds all four corners, which puts a curve where the column
 * meets its own baseline and reads as a rendering fault rather than as a style.
 */
function column(x: number, y: number, width: number, height: number): string {
  const r = Math.min(4, width / 2, height);
  return `M${x},${y + height} L${x},${y + r} Q${x},${y} ${x + r},${y} L${x + width - r},${y} Q${x + width},${y} ${x + width},${y + r} L${x + width},${y + height} Z`;
}

/**
 * Where the budget rule falls, on the band scale the columns are drawn on.
 *
 * The server's buckets are not equal in milliseconds - 1000 to 1500 is one bucket
 * and so is 0 to 200 - but they are drawn as equal bands. Placing the rule on a
 * linear millisecond scale would therefore land it several columns away from the
 * boundary it is meant to mark.
 */
function budgetX(buckets: Bucket[], budgetMs: number, band: number): number {
  for (let i = 0; i < buckets.length; i += 1) {
    const bucket = buckets[i];
    if (!bucket) continue;
    const to = bucket.to_ms;
    if (budgetMs < bucket.from_ms) return PAD.left + band * i;
    if (to === null || budgetMs < to) {
      const across = to === null ? 0 : (budgetMs - bucket.from_ms) / (to - bucket.from_ms);
      return PAD.left + band * (i + across);
    }
  }
  return PAD.left + PLOT_WIDTH;
}

function label(bucket: Bucket): string {
  const range = bucket.to_ms === null ? `${bucket.from_ms}ms and up` : `${bucket.from_ms} to ${bucket.to_ms}ms`;
  return `${range}: ${bucket.count} ${bucket.count === 1 ? "turn" : "turns"}`;
}

function edge(ms: number): string {
  return ms >= 1000 ? `${ms / 1000}s` : String(ms);
}

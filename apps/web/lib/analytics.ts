/**
 * The two formatters the analytics page and its charts share.
 *
 * The response types - AnalyticsResponse, Stats, TrendPoint, FieldStat and the
 * two enums - are deliberately not here. They live in @recall/shared, because
 * the orchestrator writes them and this console reads them, and a copy kept by
 * hand on each side of that boundary is exactly the drift the shared package
 * exists to prevent.
 */

/** Milliseconds in the unit somebody would say them out loud in. */
export function ms(value: number | null): string {
  if (value === null) return "-";
  return value >= 1000 ? `${(value / 1000).toFixed(2)}s` : `${Math.round(value)}ms`;
}

/**
 * A 0..1 rate as whole percent. A rate over an empty population arrives as
 * null and is printed as a dash, never as 0%: nothing measured and none
 * captured are different answers.
 */
export function pct(value: number | null): string {
  return value === null ? "-" : `${Math.round(value * 100)}%`;
}

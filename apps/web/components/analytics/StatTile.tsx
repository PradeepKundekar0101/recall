/**
 * One headline number, with the threshold it is being judged against.
 *
 * The threshold is the point. "1.18s" says nothing on its own; "1.18s against an
 * 800ms budget" is a verdict, and a tile that shows the first without the second
 * is decoration.
 */
export function StatTile({
  label,
  value,
  sub,
  tone = "neutral",
  meter,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "neutral" | "good" | "warn" | "bad";
  /** 0..1 against the threshold named in `sub`. Omitted when there is nothing to compare to. */
  meter?: number | null;
}) {
  // Number.isFinite, not typeof: a rate computed from a zero denominator arrives
  // as NaN, which is a number and yields width: NaN%.
  const ratio = typeof meter === "number" && Number.isFinite(meter) ? Math.min(Math.max(meter, 0), 1) : null;

  return (
    <div className={`tile tile-${tone}`}>
      <span className="tile-label">{label}</span>
      <span className="tile-value">{value}</span>
      {sub && <span className="tile-sub">{sub}</span>}
      {ratio !== null && (
        // The meter re-states the ratio that `sub` already spells out in words, so
        // it is hidden rather than read out twice.
        <span className="tile-meter" aria-hidden="true">
          <span className="tile-meter-fill" style={{ width: `${ratio * 100}%` }} />
        </span>
      )}
    </div>
  );
}

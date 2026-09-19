/**
 * Best first, and fixed, so switching the window redraws the same bar with
 * different lengths rather than reshuffling it. A reader who learned that the
 * green sits on the left should not have to relearn the bar every time.
 */
const ORDER = [
  "submitted",
  "incomplete",
  "handoff",
  "disconnected",
  "abandoned",
  "no_answer",
  "declined",
] as const;

/**
 * Three outcomes carry a verdict and take the console's semantic colours. The
 * rest are one neutral ramp, darkest where the most of the call actually
 * happened: a line that dropped mid-sentence, a customer who went quiet, a phone
 * that never picked up.
 *
 * The order above is also what the palette was checked in - red beside the mid
 * grey is the one adjacent pair a protan reader cannot separate, so declined
 * sits at the far end, past the neutrals, rather than next to them.
 */
const FILL: Record<string, string> = {
  submitted: "var(--success-line)",
  incomplete: "var(--info-line)",
  handoff: "var(--warn-line)",
  disconnected: "var(--muted)",
  abandoned: "var(--muted-soft)",
  no_answer: "var(--hairline-strong)",
  declined: "var(--error-line)",
};

/** How the calls in this window ended, as one bar. */
export function OutcomeBar({ counts }: { counts: Record<string, number> }) {
  const entries = ordered(counts);
  const total = entries.reduce((sum, [, n]) => sum + n, 0);
  if (!total) return null;

  return (
    <div className="outcomes">
      <div className="outcomes-bar" role="group" aria-label="How calls ended">
        {entries.map(([outcome, n]) => (
          // flex-grow rather than a width percentage, so the 2px gaps between
          // slices come out of the track before the shares are worked out.
          <span
            key={outcome}
            className="outcomes-slice"
            style={{ flexGrow: n, background: FILL[outcome] ?? "var(--surface-strong)" }}
            role="img"
            aria-label={`${name(outcome)}: ${n} of ${total}`}
            title={`${name(outcome)}: ${n} of ${total}`}
          />
        ))}
      </div>
      <ul className="outcomes-key">
        {entries.map(([outcome, n]) => (
          <li key={outcome}>
            <span className="outcomes-dot" style={{ background: FILL[outcome] ?? "var(--surface-strong)" }} />
            <span className="outcomes-name">{name(outcome)}</span>
            <span className="outcomes-n">{n}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The known outcomes in their fixed order, then anything else.
 *
 * An outcome this file has not seen would be a server that grew a new one. It
 * still gets drawn, in the flattest fill there is, rather than quietly dropped
 * from a bar that claims to be the whole window.
 */
function ordered(counts: Record<string, number>): [string, number][] {
  const known: [string, number][] = ORDER.filter((id) => (counts[id] ?? 0) > 0).map((id) => [id, counts[id] ?? 0]);
  const rest = Object.entries(counts)
    .filter(([id, n]) => n > 0 && !ORDER.includes(id as (typeof ORDER)[number]))
    .sort(([, a], [, b]) => b - a);
  return [...known, ...rest];
}

function name(outcome: string): string {
  return outcome.replace(/_/g, " ");
}

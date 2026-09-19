type Stage = { id: string; label: string; p50: number | null; hint: string };

/**
 * The three stages read as one process, not as three identities, so they take
 * the console's blue, its neutral and its amber in that order: the model's own
 * time, time the agent spent waiting on audio already playing, and the vendor's.
 */
const FILLS = ["var(--info-line)", "var(--muted-soft)", "var(--warn-line)"];

/**
 * Where the time inside a turn goes.
 *
 * The three stages tile the turn, so they are drawn as one bar cut into three
 * rather than three bars side by side. Reading them as parts of a whole is the
 * entire point.
 */
export function StageBars({ stages, total }: { stages: Stage[]; total: number | null }) {
  const known = stages.filter((stage): stage is Stage & { p50: number } => typeof stage.p50 === "number");
  const sum = known.reduce((acc, stage) => acc + stage.p50, 0);
  if (!known.length || sum <= 0) return null;

  return (
    <div className="stages">
      <div className="stages-bar" role="group" aria-label="Turn stages at the median">
        {known.map((stage, i) => (
          // flex-grow rather than a width percentage: the 2px gaps between slices
          // are taken out of the track before the shares are worked out, so three
          // shares of a whole still add up to the whole.
          <span
            key={stage.id}
            className="stages-slice"
            style={{ flexGrow: stage.p50, background: FILLS[i % FILLS.length] }}
            role="img"
            aria-label={`${stage.label}: ${ms(stage.p50)}`}
            title={`${stage.label}: ${ms(stage.p50)}`}
          />
        ))}
      </div>
      <ul className="stages-key">
        {known.map((stage, i) => (
          <li key={stage.id}>
            <span className="stages-dot" style={{ background: FILLS[i % FILLS.length] }} />
            <span className="stages-name">{stage.label}</span>
            <span className="stages-ms">{ms(stage.p50)}</span>
            <span className="stages-hint">{stage.hint}</span>
          </li>
        ))}
      </ul>
      {typeof total === "number" && <p className="stages-total">Median turn: {ms(total)}</p>}
    </div>
  );
}

/** Local until Task 9 puts one formatter in lib/analytics.ts for the whole page. */
function ms(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(2)}s` : `${Math.round(value)}ms`;
}

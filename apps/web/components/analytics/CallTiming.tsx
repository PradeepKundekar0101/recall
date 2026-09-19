import { LATENCY_BUDGET_MS, type TurnTiming } from "@recall/shared";
import { ms } from "../../lib/analytics";

/**
 * Which of the three kinds of turn this was, in the operator's words.
 *
 * Without it a fast turn is unreadable: a closed field is matched in code and
 * never reaches the model, a cached line plays off disk with no synthesis, and
 * only a generated reply pays for both. Ten green bars mean nothing until you
 * know how many of them were real work.
 */
const KIND_LABEL: Record<TurnTiming["kind"], string> = {
  closed_field: "matched in code",
  cached_line: "played from cache",
  generated: "generated",
};

/**
 * The three stages, in the order they happen and in the colours the dashboard's
 * stage bar already uses, so a bar here and a bar there are the same bar.
 */
const STAGES: { id: string; label: string; fill: string; of: (turn: TurnTiming) => number }[] = [
  { id: "think", label: "Think", fill: "var(--info-line)", of: (turn) => turn.think_ms },
  { id: "wire", label: "Wire wait", fill: "var(--muted-soft)", of: (turn) => turn.wire_wait_ms },
  { id: "tts", label: "TTS", fill: "var(--warn-line)", of: (turn) => turn.tts_ttfb_ms },
];

/**
 * This call's turns, in order, against the budget.
 *
 * Built from the timing events already streaming in, so a replayed call shows
 * the same numbers as a live one and there is no second source to disagree.
 *
 * Every bar is drawn on one scale shared by the whole list, which is what makes
 * the stack comparable: the budget rule falls at the same place on every row, so
 * a turn that went over is over by an amount you can see rather than by a colour
 * you have to trust.
 *
 * A call recorded before this instrumentation existed has no timing events at
 * all, and draws nothing. An empty panel would claim the call had no turns.
 */
export function CallTiming({ timings, budgetMs = LATENCY_BUDGET_MS }: { timings: TurnTiming[]; budgetMs?: number }) {
  if (!timings.length) return null;

  // The budget is part of the scale, not just a mark on it: on a call where every
  // turn came in fast the rule still has to be on screen, or the bars fill the
  // track and a good call looks the same as a bad one. The headroom keeps the
  // rule off the track's own edge, where it stops reading as a threshold the
  // bars are measured against and starts reading as the end of the chart.
  const worst = Math.max(budgetMs * 1.15, ...timings.map((turn) => turn.first_audio_ms));
  const budgetLeft = (budgetMs / worst) * 100;
  const over = timings.filter((turn) => turn.first_audio_ms > budgetMs).length;
  const tokens = timings.reduce(
    (acc, turn) => ({
      prompt: acc.prompt + (turn.prompt_tokens ?? 0),
      completion: acc.completion + (turn.completion_tokens ?? 0),
    }),
    { prompt: 0, completion: 0 }
  );
  const chars = timings.reduce((sum, turn) => sum + turn.tts_chars, 0);

  return (
    <section className="card call-timing" aria-label="Turn timing">
      <header className="card-lede">
        <h2 className="card-title">Time to reply, turn by turn</h2>
        <p className="card-sub">
          {timings.length} {timings.length === 1 ? "turn" : "turns"}, {over} over the {budgetMs}ms budget.
        </p>
      </header>

      {/* Two columns rather than one: the call page is a fixed 100vh shell and the
          three live panes above have first claim on it, so the list runs down the
          width the page has spare instead of down its height. */}
      <div className="call-timing-body">
        <div>
          {/* The amber and the grey do not clear 3:1 on white, so the colour alone
              is never what tells you which slice is which. */}
          <ul className="timing-key">
            {STAGES.map((stage) => (
              <li key={stage.id}>
                <span className="stages-dot" style={{ background: stage.fill }} />
                {stage.label}
              </li>
            ))}
          </ul>

          <ol className="timing-list">
            {timings.map((turn, i) => (
              <li key={i} className={turn.first_audio_ms > budgetMs ? "timing-row over" : "timing-row"}>
                <span className="timing-n">{i + 1}</span>
                {/* One label on the group rather than one per slice: three readings
                    a turn is thirty readings on a ten turn call, and the row
                    already says the total out loud in text. */}
                <span className="timing-bar" role="img" aria-label={stageWords(turn)}>
                  <span className="timing-rule" style={{ left: `${budgetLeft}%` }} />
                  {STAGES.map((stage) => (
                    <span
                      key={stage.id}
                      className="timing-slice"
                      style={{ width: `${(stage.of(turn) / worst) * 100}%`, background: stage.fill }}
                      title={`${stage.label}: ${ms(stage.of(turn))}`}
                    />
                  ))}
                </span>
                <span className="timing-total">{ms(turn.first_audio_ms)}</span>
                <span className="timing-kind">{KIND_LABEL[turn.kind]}</span>
              </li>
            ))}
          </ol>
        </div>

        <div>
          <ul className="usage-list">
            <li>
              <span>Prompt tokens</span>
              <span>{tokens.prompt.toLocaleString()}</span>
            </li>
            <li>
              <span>Completion tokens</span>
              <span>{tokens.completion.toLocaleString()}</span>
            </li>
            <li>
              <span>TTS characters</span>
              <span>{chars.toLocaleString()}</span>
            </li>
          </ul>

          <p className="chart-caption">
            Transcript in hand to the first audio of the reply. A filler line can play before that, so this is not how
            long the line was silent.
          </p>
        </div>
      </div>
    </section>
  );
}

/** One string, so a screen reader gets the breakdown in a single reading. */
function stageWords(turn: TurnTiming): string {
  return STAGES.map((stage) => `${stage.label} ${ms(stage.of(turn))}`).join(", ");
}

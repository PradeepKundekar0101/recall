/**
 * `pnpm analytics:check` - the arithmetic behind every number on the dashboard.
 *
 * Pure functions over fixture rows, so the whole thing runs in milliseconds
 * with no database. This is where the arithmetic errors hide: a percentile off
 * by one index, a null token count summed as a zero, or a simulated call quietly
 * dragging the latency median down.
 */
import { THIN_DATA_MIN_CALLS, buildAnalytics, percentile, summarise } from "./aggregate.js";
import type { CallLite, FieldEventRow, TurnRow } from "./types.js";

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "  ok " : "FAIL "} ${name}${ok || !detail ? "" : ` - ${detail}`}`);
  if (!ok) failed += 1;
}

// ---- percentiles
check("percentile of an empty set is null", percentile([], 50) === null);
check("p50 of one value is that value", percentile([7], 50) === 7);
check("p50 of 1..10 is 5", percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50) === 5, String(percentile([1,2,3,4,5,6,7,8,9,10], 50)));
check("p90 of 1..10 is 9", percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90) === 9, String(percentile([1,2,3,4,5,6,7,8,9,10], 90)));
check("p100 is the max", percentile([1, 2, 3], 100) === 3);

const stats = summarise([10, 20, 30, 40]);
check("summarise reports n", stats?.n === 4);
check("summarise reports min and max", stats?.min === 10 && stats?.max === 40);
check("summarise of nothing is null", summarise([]) === null);

// ---- fixtures
function turn(over: Partial<TurnRow> = {}): TurnRow {
  return {
    call_id: "c1",
    at: "2026-09-19T01:00:00.000Z",
    think_ms: 300,
    llm_ttfb_ms: null,
    llm_total_ms: 280,
    wire_wait_ms: 100,
    tts_ttfb_ms: 200,
    first_audio_ms: 600,
    prompt_tokens: 800,
    completion_tokens: 40,
    model: "gpt-4o-mini",
    tts_chars: 60,
    kind: "generated",
    ...over,
  };
}

function call(over: Partial<CallLite> = {}): CallLite {
  return {
    id: "c1",
    outcome: "submitted",
    handoff_reason: null,
    started_at: "2026-09-19T01:00:00.000Z",
    duration_s: 120,
    fields_hands_free: 11,
    fields_total: 15,
    simulated: false,
    ...over,
  };
}

function report(over: Partial<{ calls: CallLite[]; turns: TurnRow[]; fieldEvents: FieldEventRow[] }> = {}) {
  return buildAnalytics({
    window: "7d",
    source: "dialled",
    from: "2026-09-12T00:00:00.000Z",
    to: "2026-09-19T12:00:00.000Z",
    calls: over.calls ?? [call()],
    turns: over.turns ?? [turn()],
    fieldEvents: over.fieldEvents ?? [],
  });
}

// ---- the tiling identity
{
  const t = turn({ think_ms: 300, wire_wait_ms: 100, tts_ttfb_ms: 200, first_audio_ms: 600 });
  check("the three tiling stages sum to first audio", t.think_ms + t.wire_wait_ms + t.tts_ttfb_ms === t.first_audio_ms);
}

// ---- closed fields stay out of the model statistics
{
  const r = report({
    turns: [
      turn({ kind: "generated", llm_total_ms: 900 }),
      turn({ kind: "closed_field", llm_total_ms: null, llm_ttfb_ms: null, prompt_tokens: null, completion_tokens: null, model: null, first_audio_ms: 40, think_ms: 5, wire_wait_ms: 5, tts_ttfb_ms: 30 }),
    ],
  });
  check("llm stats count only turns that reached the model", r.latency.llm.total?.n === 1, String(r.latency.llm.total?.n));
  check("first-audio stats count every turn", r.latency.first_audio?.n === 2, String(r.latency.first_audio?.n));
  check("by_kind splits the two apart", r.latency.by_kind.closed_field?.n === 1 && r.latency.by_kind.generated?.n === 1);
}

// ---- cached lines stay out of the synthesis statistics
{
  const r = report({
    turns: [turn({ kind: "generated", tts_chars: 100 }), turn({ kind: "cached_line", tts_chars: 50 })],
  });
  check("tts_chars counts every line", r.usage.tts_chars === 150, String(r.usage.tts_chars));
  check("synthesised chars exclude cached lines", r.usage.tts_chars_synthesised === 100, String(r.usage.tts_chars_synthesised));
}

// ---- simulated calls are excluded from a dialled window
{
  const r = buildAnalytics({
    window: "7d",
    source: "dialled",
    from: "2026-09-12T00:00:00.000Z",
    to: "2026-09-19T12:00:00.000Z",
    calls: [call({ id: "real", simulated: false }), call({ id: "fake", simulated: true })],
    turns: [turn({ call_id: "real", first_audio_ms: 800 }), turn({ call_id: "fake", first_audio_ms: 10 })],
    fieldEvents: [],
  });
  check("a dialled window counts only dialled calls", r.totals.calls === 1, String(r.totals.calls));
  check("a dialled window drops simulated turns", r.latency.first_audio?.n === 1, String(r.latency.first_audio?.n));
  check("a simulated turn cannot drag the median down", r.latency.first_audio?.p50 === 800, String(r.latency.first_audio?.p50));
  check("the simulated count is still reported", r.totals.simulated === 1, String(r.totals.simulated));
}

// ---- null tokens do not poison the totals
{
  const r = report({
    turns: [
      turn({ prompt_tokens: 100, completion_tokens: 10 }),
      turn({ prompt_tokens: null, completion_tokens: null, model: null }),
    ],
  });
  check("null tokens are skipped, not summed as zero", r.usage.prompt_tokens === 100, String(r.usage.prompt_tokens));
  check("a turn with no model is not a model key", Object.keys(r.usage.by_model).length === 1, JSON.stringify(Object.keys(r.usage.by_model)));
}

// ---- thin data
{
  const thin = report({ calls: [call()] });
  check("one call is thin", thin.thin === true);
  check("the threshold is reported so the page can say it", thin.thin_threshold === THIN_DATA_MIN_CALLS);
  check("a thin window yields no trend", thin.trend.length === 0, `got ${thin.trend.length}`);

  const fat = report({
    calls: Array.from({ length: THIN_DATA_MIN_CALLS }, (_, i) => call({ id: `c${i}` })),
  });
  check("ten calls is not thin", fat.thin === false);
  check("a fat window yields a trend", fat.trend.length > 0);
}

// ---- accuracy
{
  const r = report({
    calls: [
      call({ id: "a", outcome: "submitted", fields_hands_free: 10, fields_total: 15, duration_s: 100 }),
      call({ id: "b", outcome: "handoff", handoff_reason: "CONFUSION", fields_hands_free: 5, fields_total: 15, duration_s: 200 }),
    ],
    // The default turn is on call "c1"; neither fixture call here uses that id.
    // These assertions never look at latency, but keeping the turn on a call
    // that exists is what a real audit trail would look like.
    turns: [turn({ call_id: "a" })],
  });
  check("hands-free rate is over the summed totals", r.accuracy.hands_free_rate === 0.5, String(r.accuracy.hands_free_rate));
  check("submitted rate counts submitted over all", r.accuracy.submitted_rate === 0.5, String(r.accuracy.submitted_rate));
  check("median duration", r.accuracy.median_duration_s === 100, String(r.accuracy.median_duration_s));
  check("handoff reasons are counted", r.totals.by_handoff_reason.CONFUSION === 1);
  check("outcomes are counted", r.totals.by_outcome.submitted === 1 && r.totals.by_outcome.handoff === 1);
}

// ---- per-field accuracy
{
  const events: FieldEventRow[] = [
    { call_id: "a", field: "email", state: "asking", confidence: null, attempts: 0 },
    { call_id: "a", field: "email", state: "captured", confidence: 0.8, attempts: 0 },
    { call_id: "a", field: "email", state: "asking", confidence: null, attempts: 1 },
    { call_id: "a", field: "email", state: "confirmed", confidence: 0.9, attempts: 1 },
    { call_id: "b", field: "street", state: "asking", confidence: null, attempts: 0 },
    { call_id: "b", field: "street", state: "confirmed", confidence: 0.95, attempts: 0 },
  ];
  // buildAnalytics filters field events down to the calls in the window, so the
  // window has to actually contain "a" and "b" or every assertion below sees
  // an empty table instead of the two fields these events describe.
  const r = report({ calls: [call({ id: "a" }), call({ id: "b" })], fieldEvents: events });
  const email = r.fields.find((f) => f.id === "email");
  const street = r.fields.find((f) => f.id === "street");
  check("a re-asked field records the re-ask", email?.re_asks === 1, String(email?.re_asks));
  check("a field asked once is captured first try", street?.captured_first_try === 1, String(street?.captured_first_try));
  check("mean confidence ignores the nulls", street?.mean_confidence === 0.95, String(street?.mean_confidence));
  check("fields are sorted worst first", r.fields[0]?.id === "email", String(r.fields[0]?.id));
}

// ---- over budget
{
  const r = report({ turns: [turn({ first_audio_ms: 400 }), turn({ first_audio_ms: 1200 })] });
  check("over-budget counts turns past the budget", r.latency.over_budget === 1, String(r.latency.over_budget));
  check("the budget is reported so the page does not hardcode it", r.latency.budget_ms === 800);
}

// ---- empty window
{
  const r = report({ calls: [], turns: [], fieldEvents: [] });
  check("an empty window does not throw", r.totals.calls === 0);
  check("an empty window reports null rather than zero", r.latency.first_audio === null && r.accuracy.hands_free_rate === null);
}

console.log(failed ? `\n${failed} failed` : "\nall ok");
process.exit(failed ? 1 : 0);

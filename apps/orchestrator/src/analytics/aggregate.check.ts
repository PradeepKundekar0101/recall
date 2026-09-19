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
check("p0 is the min", percentile([5, 1, 9], 0) === 1, String(percentile([5, 1, 9], 0)));
// An even-length set has no middle element, which is exactly where a
// half-open vs closed rank formula disagrees with itself.
check("p50 of an even-length set is nearest-rank, not an average", percentile([1, 2, 3, 4], 50) === 2, String(percentile([1, 2, 3, 4], 50)));
check("p90 of an even-length set is nearest-rank", percentile([1, 2, 3, 4], 90) === 4, String(percentile([1, 2, 3, 4], 90)));
{
  const input = [3, 1, 4, 2];
  const before = [...input];
  percentile(input, 50);
  check("percentile does not mutate the array it is given", JSON.stringify(input) === JSON.stringify(before), JSON.stringify(input));
}

const stats = summarise([10, 20, 30, 40]);
check("summarise reports n", stats?.n === 4);
check("summarise reports min and max", stats?.min === 10 && stats?.max === 40);
check("summarise of nothing is null", summarise([]) === null);
check("summarise p50 on an even-length set", stats?.p50 === 20, String(stats?.p50));
check("summarise p90 on an even-length set", stats?.p90 === 40, String(stats?.p90));
{
  const input = [3, 1, 4, 2];
  const before = [...input];
  summarise(input);
  check("summarise does not mutate the array it is given", JSON.stringify(input) === JSON.stringify(before), JSON.stringify(input));
}

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
    kind: "synthesised",
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

// ---- the tiling identity, on numbers that actually came back from buildAnalytics
// (the fixture-only version of this check just adds up literals it set itself
// and would pass no matter what the module does with them)
{
  const r = report({ turns: [turn({ think_ms: 300, wire_wait_ms: 100, tts_ttfb_ms: 200, first_audio_ms: 600 })] });
  const sum = (r.latency.stages.think?.p50 ?? NaN) + (r.latency.stages.wire_wait?.p50 ?? NaN) + (r.latency.stages.tts_ttfb?.p50 ?? NaN);
  check("the three tiling stages sum to first audio", sum === r.latency.first_audio?.p50, `${sum} vs ${r.latency.first_audio?.p50}`);
}

// ---- closed fields stay out of the model statistics
{
  const r = report({
    turns: [
      turn({ kind: "synthesised", llm_total_ms: 900 }),
      turn({ kind: "closed_field", llm_total_ms: null, llm_ttfb_ms: null, prompt_tokens: null, completion_tokens: null, model: null, first_audio_ms: 40, think_ms: 5, wire_wait_ms: 5, tts_ttfb_ms: 30 }),
    ],
  });
  check("llm stats count only turns that reached the model", r.latency.llm.total?.n === 1, String(r.latency.llm.total?.n));
  check("first-audio stats count every turn", r.latency.first_audio?.n === 2, String(r.latency.first_audio?.n));
  check("by_kind splits the two apart", r.latency.by_kind.closed_field?.n === 1 && r.latency.by_kind.synthesised?.n === 1);
}

// ---- cached lines stay out of the synthesis statistics
{
  const r = report({
    turns: [turn({ kind: "synthesised", tts_chars: 100 }), turn({ kind: "cached_line", tts_chars: 50 })],
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

// ---- null tokens do not poison the totals, and a missing model does not either
// (regression for Important 1: a turn with real tokens but no model used to
// drop both counts from the grand total because the loop skipped the whole
// turn on `!t.model`, not just the by_model entry)
{
  const r = report({
    turns: [
      turn({ prompt_tokens: 100, completion_tokens: 10 }),
      turn({ prompt_tokens: null, completion_tokens: null, model: null }),
      turn({ prompt_tokens: 50, completion_tokens: 5, model: null }),
    ],
  });
  check("null tokens are skipped, not summed as zero", r.usage.prompt_tokens === 150, String(r.usage.prompt_tokens));
  check(
    "a turn with real tokens but no model still reaches the total",
    r.usage.completion_tokens === 15,
    String(r.usage.completion_tokens)
  );
  check("a turn with no model is not a model key", Object.keys(r.usage.by_model).length === 1, JSON.stringify(Object.keys(r.usage.by_model)));
}

// ---- a NaN token count is not a finite number either, and must not poison the total
// (`typeof x === "number"` alone admits NaN; only Number.isFinite catches it)
{
  const r = report({
    turns: [
      turn({ prompt_tokens: 100, completion_tokens: 10 }),
      turn({ prompt_tokens: NaN, completion_tokens: NaN }),
    ],
  });
  check("a NaN token count does not reach the grand total", r.usage.prompt_tokens === 100 && r.usage.completion_tokens === 10, `${r.usage.prompt_tokens}/${r.usage.completion_tokens}`);
}

// ---- by_model, including the calls counter, and a second model getting its own row
{
  const r = report({
    turns: [
      turn({ model: "gpt-4o-mini", prompt_tokens: 100, completion_tokens: 10 }),
      turn({ model: "gpt-4o-mini", prompt_tokens: 200, completion_tokens: 20 }),
      turn({ model: "claude-haiku", prompt_tokens: 50, completion_tokens: 5 }),
    ],
  });
  const mini = r.usage.by_model["gpt-4o-mini"];
  const haiku = r.usage.by_model["claude-haiku"];
  check("by_model sums tokens per model", mini?.prompt_tokens === 300 && mini?.completion_tokens === 30, JSON.stringify(mini));
  check("by_model counts calls per model", mini?.calls === 2, String(mini?.calls));
  check("a second model gets its own row", haiku?.prompt_tokens === 50 && haiku?.calls === 1, JSON.stringify(haiku));
}

// ---- thin data
{
  const thin = report({ calls: [call()] });
  check("one call is thin", thin.thin === true);
  // Compared against the literal, not the constant the module built the number
  // from - `thin_threshold === THIN_DATA_MIN_CALLS` is green no matter what
  // that constant is set to, which is exactly what `budget_ms === 800` below
  // already gets right.
  check("the threshold is reported so the page can say it", thin.thin_threshold === 10, String(thin.thin_threshold));

  const fat = report({
    calls: Array.from({ length: THIN_DATA_MIN_CALLS }, (_, i) => call({ id: `c${i}` })),
  });
  check("ten calls is not thin", fat.thin === false);
  // Every one of the ten fixture calls shares the same `started_at`, so the
  // trend the fat window yields has to be exactly one day, not merely "some".
  check("a fat window yields a trend with one bucket for the one day it covers", fat.trend.length === 1, String(fat.trend.length));
  check("a thin window yields no trend", thin.trend.length === 0, `got ${thin.trend.length}`);
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

// ---- a call with an unmeasured hands-free count is skipped from both sums
// (regression for Important 2: `?? 0` on either side used to assert "captured
// nothing" about a call whose numerator, or denominator, was never measured)
{
  const r = report({
    calls: [
      call({ id: "a", fields_hands_free: 10, fields_total: 15 }),
      call({ id: "b", fields_hands_free: null, fields_total: 15 }),
      call({ id: "c", fields_hands_free: 5, fields_total: null }),
    ],
    turns: [turn({ call_id: "a" })],
  });
  check(
    "a call missing either side of the hands-free count is dropped from both sums, not summed as zero",
    r.accuracy.hands_free_captured === 10 && r.accuracy.hands_free_total === 15,
    `${r.accuracy.hands_free_captured}/${r.accuracy.hands_free_total}`
  );
}

// ---- per-field accuracy
//
// Every `attempts` below mirrors what fact-bus.ts actually emits: it increments
// the counter on entry into `asking`, so the first ask already carries 1, a
// re-ask carries 2, and a state that is not `asking` carries whatever the last
// ask left behind. There is no shape in which a real `asking` event carries 0.
// Do not "simplify" these back to zero-based - fixtures that counted the first
// ask as 0 are what let a first-try rate of 0% for every field ship.
{
  const events: FieldEventRow[] = [
    // Asked, misheard, asked again, then confirmed. One re-ask, not a first try.
    { call_id: "a", field: "email", state: "asking", confidence: null, attempts: 1 },
    { call_id: "a", field: "email", state: "captured", confidence: 0.8, attempts: 1 },
    { call_id: "a", field: "email", state: "asking", confidence: null, attempts: 2 },
    { call_id: "a", field: "email", state: "confirmed", confidence: 0.9, attempts: 2 },
    // Asked once, confirmed. A first-try capture with nothing re-asked.
    { call_id: "b", field: "street", state: "asking", confidence: null, attempts: 1 },
    { call_id: "b", field: "street", state: "confirmed", confidence: 0.95, attempts: 1 },
  ];
  // buildAnalytics filters field events down to the calls in the window, so the
  // window has to actually contain "a" and "b" or every assertion below sees
  // an empty table instead of the two fields these events describe.
  const r = report({ calls: [call({ id: "a" }), call({ id: "b" })], fieldEvents: events });
  const email = r.fields.find((f) => f.id === "email");
  const street = r.fields.find((f) => f.id === "street");
  check("a field asked twice records exactly one re-ask", email?.re_asks === 1, String(email?.re_asks));
  check("a field asked twice is not a first-try capture", email?.captured_first_try === 0, String(email?.captured_first_try));
  check("a field asked once and confirmed is a first-try capture", street?.captured_first_try === 1, String(street?.captured_first_try));
  check("a field asked once is charged no re-ask", street?.re_asks === 0, String(street?.re_asks));
  check("mean confidence ignores the nulls", street?.mean_confidence === 0.95, String(street?.mean_confidence));
  check("fields are sorted worst first", r.fields[0]?.id === "email", String(r.fields[0]?.id));
}

// ---- a prefilled field the engine only confirmed was never asked
// (regression for Important 3: the engine announces every prefilled field
// before the opener speaks, so a field the web journey already had emits a
// `field.update` without the agent ever asking for it. Gating "asked" on
// `attempts === 0` counted that announcement as a first-try capture and
// flattered the headline number with fields the agent never won.)
{
  const events: FieldEventRow[] = [
    // Never entered `asking`, so the counter never moved off zero.
    { call_id: "a", field: "plan_id", state: "prefilled", confidence: null, attempts: 0 },
    { call_id: "a", field: "plan_id", state: "confirmed", confidence: 0.99, attempts: 0 },
    // Asked, then the call dropped before it was ever confirmed or submitted.
    { call_id: "b", field: "postcode", state: "asking", confidence: null, attempts: 1 },
  ];
  const r = report({ calls: [call({ id: "a" }), call({ id: "b" })], fieldEvents: events });
  check(
    "a field only ever prefilled and confirmed is not counted as asked at all",
    !r.fields.some((f) => f.id === "plan_id"),
    JSON.stringify(r.fields.map((f) => f.id))
  );
  const postcode = r.fields.find((f) => f.id === "postcode");
  check(
    "a field that was asked but never confirmed is asked, not captured",
    postcode?.asked === 1 && postcode?.captured_first_try === 0,
    JSON.stringify(postcode)
  );
}

// ---- mean_confidence is computed over the same population as asked, not every event
// (regression: confidence used to be collected across every field.update for the
// field, including events from pairs the asking-gate excludes - a numerator over
// one population and a denominator over another)
{
  const events: FieldEventRow[] = [
    // Call "a": prefilled and confirmed, never asked. Excluded from `asked`.
    { call_id: "a", field: "plan_name", state: "prefilled", confidence: null, attempts: 0 },
    { call_id: "a", field: "plan_name", state: "confirmed", confidence: 0.5, attempts: 0 },
    // Call "b": genuinely asked and confirmed. Included in `asked`.
    { call_id: "b", field: "plan_name", state: "asking", confidence: null, attempts: 1 },
    { call_id: "b", field: "plan_name", state: "confirmed", confidence: 0.9, attempts: 1 },
  ];
  const r = report({ calls: [call({ id: "a" }), call({ id: "b" })], fieldEvents: events });
  const planName = r.fields.find((f) => f.id === "plan_name");
  check("mean_confidence reflects only the pair that was actually asked", planName?.asked === 1 && planName?.mean_confidence === 0.9, JSON.stringify(planName));
}

// ---- a redacted field is asked but never a capture, and is still tallied redacted
{
  const events: FieldEventRow[] = [
    { call_id: "a", field: "card_number", state: "asking", confidence: null, attempts: 1 },
    { call_id: "a", field: "card_number", state: "redacted", confidence: null, attempts: 1 },
  ];
  const r = report({ calls: [call({ id: "a" })], fieldEvents: events });
  const card = r.fields.find((f) => f.id === "card_number");
  check("a redacted field is asked but not captured first try", card?.asked === 1 && card?.captured_first_try === 0, JSON.stringify(card));
  check("a redacted field is tallied", card?.redacted === 1, String(card?.redacted));
}

// ---- latency.stages carries its own min/max/n per stage, not just first_audio
{
  const r = report({
    turns: [
      turn({ think_ms: 100, wire_wait_ms: 10, tts_ttfb_ms: 20 }),
      turn({ think_ms: 300, wire_wait_ms: 30, tts_ttfb_ms: 60 }),
    ],
  });
  check("the think stage counts both turns", r.latency.stages.think?.n === 2, String(r.latency.stages.think?.n));
  check(
    "the think stage reports its own min and max",
    r.latency.stages.think?.min === 100 && r.latency.stages.think?.max === 300,
    JSON.stringify(r.latency.stages.think)
  );
  check(
    "the wire_wait stage reports its own min and max",
    r.latency.stages.wire_wait?.min === 10 && r.latency.stages.wire_wait?.max === 30,
    JSON.stringify(r.latency.stages.wire_wait)
  );
  check(
    "the tts_ttfb stage reports its own min and max",
    r.latency.stages.tts_ttfb?.min === 20 && r.latency.stages.tts_ttfb?.max === 60,
    JSON.stringify(r.latency.stages.tts_ttfb)
  );
}

// ---- the histogram's buckets account for every turn, including one far past the last edge
{
  const r = report({
    turns: [turn({ first_audio_ms: 100 }), turn({ first_audio_ms: 5000 })],
  });
  const total = r.latency.histogram.reduce((sum, bucket) => sum + bucket.count, 0);
  check("histogram bucket counts sum to n", total === r.latency.first_audio?.n, `${total} vs ${r.latency.first_audio?.n}`);
  const last = r.latency.histogram[r.latency.histogram.length - 1];
  check("the last bucket is open-ended", last?.to_ms === null);
  check("the open-ended last bucket catches a value far past every fixed edge", last?.count === 1, String(last?.count));
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

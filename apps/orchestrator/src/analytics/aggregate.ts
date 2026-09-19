import { LATENCY_BUDGET_MS, type TurnKind } from "@recall/shared";
import type {
  AnalyticsInput,
  AnalyticsResponse,
  CallLite,
  FieldStat,
  Stats,
  TrendPoint,
  TurnRow,
} from "./types.js";

/**
 * Every number on the analytics dashboard, computed from rows.
 *
 * Pure on purpose. The database work lives in `query.ts`, so this file can be
 * exercised exhaustively in milliseconds by `pnpm analytics:check`, which is
 * where the arithmetic errors actually hide.
 *
 * Two rules run through all of it. A missing measurement is null and is skipped,
 * never zero and summed - a zero is a claim that something took no time or cost
 * no tokens. And a number that cannot be computed honestly is null rather than
 * a default, so the page can say "not enough data" instead of drawing a
 * confident zero.
 */

/** Below this many calls in the window, a per-day trend is decoration. */
export const THIN_DATA_MIN_CALLS = 10;

export { LATENCY_BUDGET_MS };

/** Nearest-rank, which for small samples is the honest one: every value reported is a value observed. */
export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.min(Math.max(rank, 1), sorted.length) - 1;
  return sorted[index] as number;
}

export function summarise(values: number[]): Stats | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return {
    p50: percentile(sorted, 50) as number,
    p90: percentile(sorted, 90) as number,
    min: sorted[0] as number,
    max: sorted[sorted.length - 1] as number,
    n: sorted.length,
  };
}

function numbers<T>(rows: T[], pick: (row: T) => number | null): number[] {
  const out: number[] = [];
  for (const row of rows) {
    const value = pick(row);
    if (isFiniteNumber(value)) out.push(value);
  }
  return out;
}

/** `typeof x === "number"` alone admits NaN, which would poison any sum it reaches. */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function day(iso: string): string {
  return iso.slice(0, 10);
}

function countBy<T>(rows: T[], pick: (row: T) => string | null): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) {
    const key = pick(row);
    if (key === null) continue;
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

const KINDS: TurnKind[] = ["closed_field", "cached_line", "generated"];

/** Fixed buckets, so two windows drawn side by side share an x axis. */
const HISTOGRAM_EDGES = [0, 200, 400, 600, 800, 1000, 1500, 2000, 3000];

function histogram(values: number[]): { from_ms: number; to_ms: number | null; count: number }[] {
  return HISTOGRAM_EDGES.map((from, i) => {
    const to = HISTOGRAM_EDGES[i + 1] ?? null;
    const count = values.filter((v) => v >= from && (to === null || v < to)).length;
    return { from_ms: from, to_ms: to, count };
  });
}

function fieldStats(events: AnalyticsInput["fieldEvents"]): FieldStat[] {
  // Per field per call, because "re-asked" is a fact about one call's attempt at
  // one field, not about the field across the whole window.
  const perCall = new Map<
    string,
    { field: string; attempts: number; redacted: boolean; reachedAsking: boolean; reachedCaptureEnd: boolean; confidences: number[] }
  >();

  for (const event of events) {
    const key = `${event.call_id}:${event.field}`;
    const seen = perCall.get(key) ?? {
      field: event.field,
      attempts: 0,
      redacted: false,
      reachedAsking: false,
      reachedCaptureEnd: false,
      confidences: [],
    };
    seen.attempts = Math.max(seen.attempts, event.attempts);
    if (event.state === "redacted") seen.redacted = true;
    // `asking` is the gate for "asked" on purpose: the engine announces every
    // prefilled field before the opener even speaks (dialogue.ts, the walk
    // that fires `field.update` for whatever the lead already carried), so a
    // prefilled field emits an event without ever being asked. Counting it as
    // asked - and then as captured on the first try, since no attempt was ever
    // charged against it - would flatter the accuracy number with fields the
    // web journey had already filled in, not fields the agent actually won.
    if (event.state === "asking") seen.reachedAsking = true;
    if (event.state === "confirmed" || event.state === "submitted") seen.reachedCaptureEnd = true;
    if (isFiniteNumber(event.confidence)) seen.confidences.push(event.confidence);
    perCall.set(key, seen);
  }

  const byField = new Map<string, FieldStat>();
  const confidencesByField = new Map<string, number[]>();
  for (const seen of perCall.values()) {
    // Confidence is folded in here, inside the same gate as every other
    // column, and only from pairs kept by it - not collected across every
    // event up front. asked, captured_first_try and re_asks already describe
    // only asked pairs; a mean_confidence built from the full event stream
    // would average in a prefilled-and-confirmed pair's confidence while the
    // row's own asked count excludes that pair, a numerator over one
    // population divided by a denominator over another.
    if (!seen.reachedAsking) continue;
    const stat =
      byField.get(seen.field) ??
      ({ id: seen.field, asked: 0, captured_first_try: 0, re_asks: 0, mean_confidence: null, redacted: 0 } as FieldStat);
    stat.asked += 1;
    // `attempts` counts entries into `asking`, not re-asks: fact-bus.ts
    // increments it on the way in, so the very first ask already arrives as 1.
    // A first-try capture is therefore one ask and no more, and the re-asks are
    // whatever was asked beyond that original. Reading `attempts` as a re-ask
    // count put every field's first-try rate at 0% and charged a flawless call
    // one re-ask per field.
    if (seen.reachedCaptureEnd && seen.attempts <= 1) stat.captured_first_try += 1;
    stat.re_asks += Math.max(0, seen.attempts - 1);
    if (seen.redacted) stat.redacted += 1;
    byField.set(seen.field, stat);

    const list = confidencesByField.get(seen.field) ?? [];
    list.push(...seen.confidences);
    confidencesByField.set(seen.field, list);
  }

  for (const [field, list] of confidencesByField) {
    const stat = byField.get(field);
    if (stat && list.length) stat.mean_confidence = list.reduce((a, b) => a + b, 0) / list.length;
  }

  // Worst first. The point of this table is to say which question the agent
  // keeps fumbling, so the answer has to be the top row.
  return [...byField.values()].sort((a, b) => {
    const aRate = a.asked ? a.re_asks / a.asked : 0;
    const bRate = b.asked ? b.re_asks / b.asked : 0;
    if (aRate !== bRate) return bRate - aRate;
    return a.id.localeCompare(b.id);
  });
}

function trend(calls: CallLite[], turns: TurnRow[]): TrendPoint[] {
  const days = new Map<string, { calls: number; submitted: number; latencies: number[] }>();
  for (const c of calls) {
    const key = day(c.started_at);
    const bucket = days.get(key) ?? { calls: 0, submitted: 0, latencies: [] };
    bucket.calls += 1;
    if (c.outcome === "submitted") bucket.submitted += 1;
    days.set(key, bucket);
  }
  for (const t of turns) {
    const key = day(t.at);
    const bucket = days.get(key);
    if (bucket) bucket.latencies.push(t.first_audio_ms);
  }
  return [...days.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([dayKey, bucket]) => ({
      day: dayKey,
      calls: bucket.calls,
      submitted: bucket.submitted,
      first_audio_p50: percentile(bucket.latencies, 50),
    }));
}

export function buildAnalytics(input: AnalyticsInput): AnalyticsResponse {
  const simulatedCount = input.calls.filter((c) => c.simulated).length;
  const calls = input.source === "dialled" ? input.calls.filter((c) => !c.simulated) : input.calls;
  const keep = new Set(calls.map((c) => c.id));
  const turns = input.turns.filter((t) => keep.has(t.call_id));
  const fieldEvents = input.fieldEvents.filter((e) => keep.has(e.call_id));

  const thin = calls.length < THIN_DATA_MIN_CALLS;

  // A call with a null count of either kind has an unknown hands-free rate, not
  // a rate of zero: `?? 0` on just one side would assert "captured nothing"
  // about a call whose numerator was never measured. Skip the whole call from
  // both sums unless both sides are real numbers.
  let handsFreeCaptured = 0;
  let handsFreeTotal = 0;
  for (const c of calls) {
    if (!isFiniteNumber(c.fields_hands_free) || !isFiniteNumber(c.fields_total)) continue;
    handsFreeCaptured += c.fields_hands_free;
    handsFreeTotal += c.fields_total;
  }
  const durations = numbers(calls, (c) => c.duration_s);

  const firstAudio = numbers(turns, (t) => t.first_audio_ms);

  const byModel: AnalyticsResponse["usage"]["by_model"] = {};
  let promptTokens = 0;
  let completionTokens = 0;
  for (const t of turns) {
    // The grand total and the by-model breakdown are two different questions,
    // gated independently. A turn can carry real spend with no model on record
    // (a logging gap), and dropping its tokens from the grand total because it
    // has no model key would be exactly the zero-for-missing this file exists
    // to avoid - so the total is gated only on the tokens being real numbers.
    // Likewise a model can be known on a turn whose token counts did not land;
    // that turn still counts as a call against the model, it just does not
    // contribute tokens to that model's row.
    const hasTokens = isFiniteNumber(t.prompt_tokens) && isFiniteNumber(t.completion_tokens);
    if (hasTokens) {
      promptTokens += t.prompt_tokens as number;
      completionTokens += t.completion_tokens as number;
    }
    if (typeof t.model === "string" && t.model.length > 0) {
      const entry = byModel[t.model] ?? { prompt_tokens: 0, completion_tokens: 0, calls: 0 };
      if (hasTokens) {
        entry.prompt_tokens += t.prompt_tokens as number;
        entry.completion_tokens += t.completion_tokens as number;
      }
      entry.calls += 1;
      byModel[t.model] = entry;
    }
  }

  const byKind = {} as Record<TurnKind, Stats | null>;
  for (const kind of KINDS) {
    byKind[kind] = summarise(numbers(turns.filter((t) => t.kind === kind), (t) => t.first_audio_ms));
  }

  return {
    window: { window: input.window, source: input.source, from: input.from, to: input.to },
    thin,
    thin_threshold: THIN_DATA_MIN_CALLS,
    totals: {
      calls: calls.length,
      dialled: input.calls.length - simulatedCount,
      simulated: simulatedCount,
      by_outcome: countBy(calls, (c) => c.outcome),
      by_handoff_reason: countBy(calls, (c) => c.handoff_reason),
    },
    accuracy: {
      hands_free_captured: handsFreeCaptured,
      hands_free_total: handsFreeTotal,
      hands_free_rate: handsFreeTotal ? handsFreeCaptured / handsFreeTotal : null,
      submitted_rate: calls.length ? calls.filter((c) => c.outcome === "submitted").length / calls.length : null,
      median_duration_s: percentile(durations, 50),
    },
    latency: {
      budget_ms: LATENCY_BUDGET_MS,
      turns: turns.length,
      over_budget: firstAudio.filter((ms) => ms > LATENCY_BUDGET_MS).length,
      first_audio: summarise(firstAudio),
      stages: {
        think: summarise(numbers(turns, (t) => t.think_ms)),
        wire_wait: summarise(numbers(turns, (t) => t.wire_wait_ms)),
        tts_ttfb: summarise(numbers(turns, (t) => t.tts_ttfb_ms)),
      },
      llm: {
        ttfb: summarise(numbers(turns, (t) => t.llm_ttfb_ms)),
        total: summarise(numbers(turns, (t) => t.llm_total_ms)),
      },
      by_kind: byKind,
      histogram: histogram(firstAudio),
    },
    // A trend over fewer than the threshold is decoration, so it is not drawn
    // at all rather than drawn with a caveat underneath it.
    trend: thin ? [] : trend(calls, turns),
    fields: fieldStats(fieldEvents),
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      tts_chars: turns.reduce((sum, t) => sum + (t.tts_chars ?? 0), 0),
      tts_chars_synthesised: turns
        .filter((t) => t.kind !== "cached_line")
        .reduce((sum, t) => sum + (t.tts_chars ?? 0), 0),
      by_model: byModel,
    },
  };
}

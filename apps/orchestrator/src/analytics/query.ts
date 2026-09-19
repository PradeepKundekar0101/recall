import { sb } from "../db/supabase.js";
import { log } from "../log.js";
import { buildAnalytics } from "./aggregate.js";
import type {
  AnalyticsResponse,
  AnalyticsSource,
  AnalyticsWindow,
  CallLite,
  FieldEventRow,
  TurnRow,
} from "./types.js";

/**
 * The database half of the dashboard.
 *
 * Aggregation runs over `call_events` rather than a table of its own. That table
 * is already the single audit mirror of the SSE union, which is what makes a
 * finished call replayable; a second write path would give the call detail page
 * two sources for one number, and they can disagree. If volume ever makes the
 * JSONB scan slow, a materialised view goes behind this file without the
 * endpoint changing shape.
 */

/** `typeof x === "number"` alone admits NaN, which would poison any sum it reaches. */
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * The turn kind a stored payload claims, as a kind this codebase still has.
 *
 * Rows written before the rename carry "generated", which was the old name for
 * what is now "synthesised". Mapping it here keeps those turns inside the
 * by-kind split instead of leaving them in a bucket nothing counts.
 */
function kindOf(value: unknown): TurnRow["kind"] {
  if (value === "closed_field" || value === "cached_line" || value === "synthesised") return value;
  return "synthesised";
}

const WINDOW_MS: Record<AnalyticsWindow, number | null> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
  all: null,
};

/** Opening the page twice in a row must not rescan. */
const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { at: number; value: AnalyticsResponse }>();

export function clearAnalyticsCache(): void {
  cache.clear();
}

export async function loadAnalytics(
  window: AnalyticsWindow,
  source: AnalyticsSource
): Promise<AnalyticsResponse> {
  const key = `${window}:${source}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  const client = sb();
  if (!client) throw new Error("supabase is not configured");

  const to = new Date();
  const span = WINDOW_MS[window];
  const from = span === null ? null : new Date(to.getTime() - span);

  let callQuery = client
    .from("calls")
    .select("id, outcome, handoff_reason, started_at, duration_s, fields_hands_free, fields_total, simulated")
    .order("started_at", { ascending: false })
    .limit(2000);
  if (from) callQuery = callQuery.gte("started_at", from.toISOString());

  const { data: callRows, error: callError } = await callQuery;
  if (callError) {
    log.warn(`analytics.calls: ${callError.message}`);
    throw new Error(callError.message);
  }

  const calls = (callRows ?? []).map(
    (row): CallLite => ({
      id: String(row.id),
      outcome: (row.outcome as CallLite["outcome"]) ?? null,
      handoff_reason: (row.handoff_reason as string | null) ?? null,
      started_at: String(row.started_at),
      duration_s: (row.duration_s as number | null) ?? null,
      fields_hands_free: (row.fields_hands_free as number | null) ?? null,
      fields_total: (row.fields_total as number | null) ?? null,
      // A row written before the column existed reads as simulated. Counting an
      // unknown as dialled would put exactly the samples the column exists to
      // exclude back into the latency numbers.
      simulated: row.simulated !== false,
    })
  );

  // No calls in the window means no events worth fetching, and an `in` filter
  // on an empty list is a query that matches everything on some drivers.
  if (!calls.length) {
    const empty = buildAnalytics({
      window,
      source,
      from: from?.toISOString() ?? null,
      to: to.toISOString(),
      calls: [],
      turns: [],
      fieldEvents: [],
    });
    cache.set(key, { at: Date.now(), value: empty });
    return empty;
  }

  const ids = calls.map((c) => c.id);

  const [{ data: turnRows, error: turnError }, { data: fieldRows, error: fieldError }] = await Promise.all([
    client.from("call_events").select("call_id, at, payload").eq("type", "turn.timing").in("call_id", ids).limit(50_000),
    client.from("call_events").select("call_id, payload").eq("type", "field.update").in("call_id", ids).limit(50_000),
  ]);

  if (turnError) log.warn(`analytics.turns: ${turnError.message}`);
  if (fieldError) log.warn(`analytics.fields: ${fieldError.message}`);

  const turns: TurnRow[] = [];
  let partialTurns = 0;
  for (const row of turnRows ?? []) {
    const p = (row.payload ?? {}) as Record<string, unknown>;
    const think = num(p.think_ms);
    const wireWait = num(p.wire_wait_ms);
    const ttsTtfb = num(p.tts_ttfb_ms);
    const firstAudio = num(p.first_audio_ms);
    // The four required stages are all or nothing. `?? 0` here would hand the
    // aggregate a fabricated 0 ms sample, which lands in the budget percentile
    // as the fastest turn ever measured - exactly the zero-for-missing that
    // aggregate.ts's header comment forbids. TurnClock.finish() returns null
    // rather than a partial, so no row written today can reach this, but the
    // reader is the wrong place to depend on the writer staying that way.
    if (think === null || wireWait === null || ttsTtfb === null || firstAudio === null) {
      partialTurns += 1;
      continue;
    }
    turns.push({
      call_id: String(row.call_id),
      at: String(row.at),
      think_ms: think,
      llm_ttfb_ms: num(p.llm_ttfb_ms),
      llm_total_ms: num(p.llm_total_ms),
      wire_wait_ms: wireWait,
      tts_ttfb_ms: ttsTtfb,
      first_audio_ms: firstAudio,
      prompt_tokens: num(p.prompt_tokens),
      completion_tokens: num(p.completion_tokens),
      model: typeof p.model === "string" ? p.model : null,
      tts_chars: num(p.tts_chars) ?? 0,
      kind: kindOf(p.kind),
    });
  }
  // Loud, because a stage that stops arriving would otherwise shrink the sample
  // silently and the dashboard would keep drawing a confident median over it.
  if (partialTurns) log.warn(`analytics.turns: skipped ${partialTurns} rows missing a required stage`);

  const fieldEvents = (fieldRows ?? []).map((row): FieldEventRow => {
    const p = (row.payload ?? {}) as Record<string, unknown>;
    return {
      call_id: String(row.call_id),
      field: String(p.field ?? ""),
      state: p.state as FieldEventRow["state"],
      confidence: typeof p.confidence === "number" ? p.confidence : null,
      attempts: typeof p.attempts === "number" ? p.attempts : 0,
    };
  });

  const value = buildAnalytics({
    window,
    source,
    from: from?.toISOString() ?? null,
    to: to.toISOString(),
    calls,
    turns,
    fieldEvents,
  });
  cache.set(key, { at: Date.now(), value });
  return value;
}

import type { TurnKind } from "./call.js";

/**
 * The shape of the analytics dashboard's one endpoint response.
 *
 * These describe one endpoint's response and live here, rather than in the
 * orchestrator, because both the orchestrator (which produces them) and the
 * console (which renders them) read them. Keeping a hand-maintained copy of a
 * wire type on each side of that boundary is exactly the drift this package
 * exists to prevent.
 */

export type Stats = { p50: number; p90: number; min: number; max: number; n: number };

export type AnalyticsWindow = "24h" | "7d" | "30d" | "all";
export type AnalyticsSource = "dialled" | "all";

export type TrendPoint = {
  day: string;
  calls: number;
  submitted: number;
  first_audio_p50: number | null;
};

export type FieldStat = {
  id: string;
  asked: number;
  captured_first_try: number;
  re_asks: number;
  mean_confidence: number | null;
  redacted: number;
};

export type AnalyticsResponse = {
  window: { window: AnalyticsWindow; source: AnalyticsSource; from: string | null; to: string };
  /** True when there is too little data for a trend to mean anything. */
  thin: boolean;
  thin_threshold: number;
  totals: {
    calls: number;
    dialled: number;
    simulated: number;
    by_outcome: Record<string, number>;
    by_handoff_reason: Record<string, number>;
  };
  accuracy: {
    hands_free_captured: number;
    hands_free_total: number;
    hands_free_rate: number | null;
    submitted_rate: number | null;
    median_duration_s: number | null;
  };
  latency: {
    budget_ms: number;
    turns: number;
    over_budget: number;
    first_audio: Stats | null;
    stages: { think: Stats | null; wire_wait: Stats | null; tts_ttfb: Stats | null };
    llm: { ttfb: Stats | null; total: Stats | null };
    by_kind: Record<TurnKind, Stats | null>;
    histogram: { from_ms: number; to_ms: number | null; count: number }[];
  };
  trend: TrendPoint[];
  fields: FieldStat[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    tts_chars: number;
    tts_chars_synthesised: number;
    by_model: Record<string, { prompt_tokens: number; completion_tokens: number; calls: number }>;
  };
};

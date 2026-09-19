import type { CallOutcome, FieldState, TurnKind } from "@recall/shared";

/** A `turn.timing` payload as it comes back out of the audit trail. */
export type TurnRow = {
  call_id: string;
  at: string;
  think_ms: number;
  llm_ttfb_ms: number | null;
  llm_total_ms: number | null;
  wire_wait_ms: number;
  tts_ttfb_ms: number;
  first_audio_ms: number;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  model: string | null;
  tts_chars: number;
  kind: TurnKind;
};

/** Only the columns the dashboard reads. */
export type CallLite = {
  id: string;
  outcome: CallOutcome | null;
  handoff_reason: string | null;
  started_at: string;
  duration_s: number | null;
  fields_hands_free: number | null;
  fields_total: number | null;
  simulated: boolean;
};

/** A `field.update` payload, for the per-field accuracy table. */
export type FieldEventRow = {
  call_id: string;
  field: string;
  state: FieldState;
  confidence: number | null;
  attempts: number;
};

export type Stats = { p50: number; p90: number; min: number; max: number; n: number };

export type AnalyticsWindow = "24h" | "7d" | "30d" | "all";
export type AnalyticsSource = "dialled" | "all";

export type AnalyticsInput = {
  window: AnalyticsWindow;
  source: AnalyticsSource;
  from: string | null;
  to: string;
  calls: CallLite[];
  turns: TurnRow[];
  fieldEvents: FieldEventRow[];
};

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

import type { AnalyticsSource, AnalyticsWindow, CallOutcome, FieldState, TurnKind } from "@recall/shared";

// The wire types (AnalyticsResponse, Stats, TrendPoint, FieldStat,
// AnalyticsWindow, AnalyticsSource) live in packages/shared/src/analytics.ts:
// apps/web reads them too, and a copy kept here by hand would drift from the
// one the console imports. Re-exported so existing imports from this module
// keep working unchanged.
export type {
  AnalyticsResponse,
  AnalyticsSource,
  AnalyticsWindow,
  FieldStat,
  Stats,
  TrendPoint,
} from "@recall/shared";

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

export type AnalyticsInput = {
  window: AnalyticsWindow;
  source: AnalyticsSource;
  from: string | null;
  to: string;
  calls: CallLite[];
  turns: TurnRow[];
  fieldEvents: FieldEventRow[];
};

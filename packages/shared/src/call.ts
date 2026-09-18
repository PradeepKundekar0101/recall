/**
 * Call-level state shared by the orchestrator and both consoles.
 */

/** The per-field lifecycle the console renders as colour. */
export type FieldState =
  /** Not yet asked. Grey outline. */
  | "empty"
  /** Carried in on the lead, awaiting a one-line confirmation. Blue. */
  | "prefilled"
  /** Script line just spoken. Amber pulse. */
  | "asking"
  /** Extracted, awaiting read-back. Amber solid plus confidence. */
  | "captured"
  /** Customer said yes. Green tick. */
  | "confirmed"
  /** In the sandbox payload. Green filled. */
  | "submitted"
  /** Sensitive data intercepted mid-utterance. Red strike. */
  | "redacted";

export type FieldValue = string | number | boolean | null;

export type FormField = {
  id: string;
  state: FieldState;
  value: FieldValue;
  /** Combined extractor score and STT word confidence over the evidence span. */
  confidence: number | null;
  /** Verbatim transcript span the value came from. Clicking the field highlights it. */
  evidence: string | null;
  /** Re-asks so far. Hits the field's `max_attempts` and CONFUSION fires. */
  attempts: number;
  updated_at: number;
};

export type FormState = Record<string, FormField>;

export type CallStatus =
  | "queued"
  | "dialling"
  | "answered"
  | "live"
  | "handoff"
  | "ended";

export type CallOutcome =
  | "completed"
  | "declined"
  | "callback"
  | "handoff"
  | "no_answer"
  | "voicemail"
  | "failed"
  | "dnc_blocked";

/** The six signals from the brief. */
export type EscalationSignal =
  | "ANGER"
  | "CONFUSION"
  | "OFF_SCRIPT"
  | "SENSITIVE"
  | "ASKS"
  | "LOW_CONF";

/** The six non-negotiable guardrails, named so the console can tag them inline. */
export type GuardrailId =
  | "TEST_DATA_ONLY"
  | "CONSENT_FIRST"
  | "NO_CARD_DATA"
  | "NO_ADVICE"
  | "DNC"
  | "RESPECT_NO";

/** What the extractor decides the customer's turn was. */
export type Intent =
  | "answer"
  | "decline"
  | "busy"
  | "question"
  | "ask_human"
  | "unclear";

export type Lead = {
  id: string;
  first_name: string;
  full_name: string;
  phone: string;
  email?: string;
  /** Section the customer dropped out of. Earlier sections arrive as `prefilled`. */
  last_completed_step: string;
  /** Pre-filled field values carried in from the web journey. */
  prefill: Record<string, FieldValue>;
  /** Plan they were looking at when they dropped. */
  plan_id?: string;
  plan_name?: string;
  /** When they started the comparison, spoken in the opener. */
  started_at: string;
};

export type TranscriptLine = {
  at: number;
  speaker: "agent" | "customer";
  text: string;
  /** Mean word confidence from STT. Null for agent lines. */
  confidence: number | null;
  /** Interim results render grey, finals white. */
  final: boolean;
};

/**
 * What the human sees the instant a handoff fires. The point of the whole feature
 * is that the customer never repeats themselves, so this carries everything.
 */
export type HandoffPacket = {
  call_id: string;
  lead_id: string;
  reason: EscalationSignal;
  /** The utterance that tripped the detector. */
  evidence: string;
  fields: FormState;
  /** Where the human picks the conversation back up. */
  next_field: string | null;
  transcript: TranscriptLine[];
  duration_s: number;
};

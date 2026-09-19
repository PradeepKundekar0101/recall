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

/**
 * How a call ended.
 *
 * `incomplete` and `disconnected` are separate on purpose: the first is a call
 * that ran out of conversation, the second is a line that died. They need
 * different follow-up, and collapsing them would hide the failure that actually
 * matters on a venue network.
 */
export type CallOutcome =
  /** Required fields confirmed and the sandbox accepted the payload. */
  | "submitted"
  /** Talked, did not finish. Includes a callback window being agreed. */
  | "incomplete"
  /** The line dropped mid-call. */
  | "disconnected"
  /** Never answered, or answered by a machine. */
  | "no_answer"
  /** Answered, then went silent through both nudges. */
  | "abandoned"
  /** Said no. Opted out, never called again. */
  | "declined"
  /** Transferred to a human. */
  | "handoff";

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

/**
 * What the operator sets up on the console before dialling. Sent as the body of
 * POST /calls alongside the lead id; the route refuses the whole body if any
 * part of it is wrong, so a call never runs on a setup the operator did not see.
 */
export type CallSetup = {
  lead_id: string;
  /**
   * Per-field overrides of the lead's prefill. A value seeds the field, so the
   * agent confirms it in one line instead of asking; null removes it, so the
   * agent asks. Fields left out keep whatever the lead carried.
   */
  prefill?: Record<string, FieldValue | null>;
  /**
   * How the agent should talk on this call - warmer, brisker, plainer. It shapes
   * the lines the model rephrases and never the scripts, which stay verbatim.
   */
  agent_brief?: string;
};

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

/**
 * One row of the call history the console lists. Built from the audit table
 * when there is one, and from the orchestrator's own event buffer for calls it
 * is still running or ran since it booted.
 */
export type CallSummary = {
  id: string;
  lead_id: string;
  /** Looked up from the synthetic leads; null for a lead that is no longer on file. */
  lead_name: string | null;
  status: CallStatus;
  outcome: CallOutcome | null;
  handoff_reason: EscalationSignal | null;
  /** ISO timestamps. */
  started_at: string;
  ended_at: string | null;
  duration_s: number | null;
  fields_hands_free: number | null;
  fields_total: number | null;
  has_recording: boolean;
  test_run: boolean;
  /** False only when a phone actually rang. Analytics excludes simulated calls by default. */
  simulated: boolean;
  /** Whether this orchestrator process is still running the call. */
  live: boolean;
};

/**
 * Which of three very different things a turn was.
 *
 * Without this split the timing chart is three overlapping distributions
 * pretending to be one, and the average across them is meaningless: a closed
 * field matched in code resolves in single-digit milliseconds, a pre-rendered
 * script line plays off disk with no synthesis, and a generated reply pays for
 * both a model round trip and a live TTS socket.
 */
export type TurnKind = "closed_field" | "cached_line" | "generated";

/**
 * One turn's measured stages, customer transcript in hand to agent audio on the
 * wire.
 *
 * Time zero is the committed transcript rather than end of speech. Scribe runs
 * with `include_timestamps` on, but word end times are not modelled by the
 * transcript type this codebase reads, so end of speech is not a boundary that
 * can be defended.
 *
 * `think_ms`, `wire_wait_ms` and `tts_ttfb_ms` tile the turn: on a turn that
 * completed every stage they sum to `first_audio_ms`. The two LLM numbers are
 * nested inside `think_ms` and are a breakdown of it, not a fourth slice.
 */
export type TurnTiming = {
  /** Transcript in hand to reply decided. Contains the model round trip, when there is one. */
  think_ms: number;
  /**
   * Request sent to first token. Only measurable on the streaming path; the
   * extraction call is not streamed, so this is null on those turns rather
   * than a copy of `llm_total_ms` dressed up as a first-token measurement.
   */
  llm_ttfb_ms: number | null;
  /** Request sent to last token. Null on a closed field, which never reaches the model. */
  llm_total_ms: number | null;
  /** Reply decided to wire free. The previous line was still playing. */
  wire_wait_ms: number;
  /** Text handed to TTS to first audio frame. Near zero for a pre-rendered line. */
  tts_ttfb_ms: number;
  /** Transcript to first audio. The number the 800 ms budget is set on. */
  first_audio_ms: number;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  /** The model that was actually called, not the configured default. Null when none was. */
  model: string | null;
  /** Characters handed to TTS, which is how ElevenLabs bills. */
  tts_chars: number;
  kind: TurnKind;
};

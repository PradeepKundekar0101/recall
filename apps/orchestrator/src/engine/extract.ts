import type { FieldValue, Intent, Journey, JourneyField } from "@recall/shared";
import { toolCall, type ToolSchema } from "../voice/llm.js";
import { normalise, stateFromPostcode } from "./normalise.js";
import type { Form } from "./fact-bus.js";

/**
 * Utterance to form patch.
 *
 * One extraction call per customer turn, returning a structured patch and never
 * free text. The engine then decides: accept, confirm, re-ask, or escalate.
 *
 * Two things are deliberately kept out of the model's hands. Normalisation happens
 * in `normalise.ts`, because a date parser that is occasionally and confidently
 * wrong is worse than one that fails loudly. And the confidence that gates a write
 * combines the extractor's own score with STT word confidence, because a model is
 * perfectly capable of being certain about a misheard word.
 */

export const CONFIDENCE_FLOOR = 0.85;
/** Two turns under this on the same field is the LOW CONF escalation signal. */
export const LOW_CONFIDENCE = 0.6;

export type RawPatch = {
  field: string;
  value: string;
  confidence: number;
  evidence: string;
};

export type ExtractionResult = {
  patches: RawPatch[];
  intent: Intent;
  /** Fields the customer volunteered before being asked. Confirmed later, not re-asked. */
  unasked_fields_mentioned: string[];
};

export type AcceptedPatch = {
  field: string;
  value: FieldValue;
  confidence: number;
  evidence: string;
  /** Whether this field still needs a read-back before it can be confirmed. */
  needsConfirm: boolean;
};

export type RejectedPatch = {
  field: string;
  reason: string;
  evidence: string;
};

/**
 * The extraction tool.
 *
 * Built from the journey so a field added to the config is extractable without a
 * prompt edit - the same reason the console and the payload are generated from it.
 */
export function extractionTool(journey: Journey): ToolSchema {
  return {
    name: "record_answer",
    description:
      "Record what the customer said as a patch to the energy comparison form. " +
      "Only include a field when the customer actually gave a value for it. " +
      "Never invent a value, and never guess at one you did not clearly hear.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["patches", "intent", "unasked_fields_mentioned"],
      properties: {
        patches: {
          type: "array",
          description: "One entry per field the customer gave a value for. Empty if they gave none.",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["field", "value", "confidence", "evidence"],
            properties: {
              field: { type: "string", enum: journey.fields.map((f) => f.id) },
              value: {
                type: "string",
                description: "The value exactly as the customer said it. Do not reformat dates or numbers.",
              },
              confidence: {
                type: "number",
                description: "0 to 1. How certain you are this is the value they gave for this field.",
              },
              evidence: {
                type: "string",
                description: "The exact span of their words this came from.",
              },
            },
          },
        },
        intent: {
          type: "string",
          enum: ["answer", "decline", "busy", "question", "ask_human", "unclear"],
          description:
            "answer: they answered. decline: not interested or stop calling. busy: call back later. " +
            "question: they asked something, including about rates or which plan is better. " +
            "ask_human: they want a person. unclear: you could not tell.",
        },
        unasked_fields_mentioned: {
          type: "array",
          items: { type: "string", enum: journey.fields.map((f) => f.id) },
          description: "Fields they volunteered without being asked.",
        },
      },
    },
  };
}

function systemPrompt(journey: Journey, asking: JourneyField | null): string {
  const lines = journey.fields.map(
    (f) =>
      `- ${f.id} (${f.type}${f.options ? `: ${f.options.join("|")}` : ""})${f.required ? " [required]" : ""}: ${f.label}`
  );
  return [
    "You extract structured answers from one turn of a phone call about an Australian energy plan comparison.",
    "",
    "Form fields:",
    ...lines,
    "",
    asking ? `The agent just asked for: ${asking.id} (${asking.label}).` : "The agent has not asked for a field yet.",
    "",
    "Rules:",
    "- Record a field only when the customer gave a value for it in this turn.",
    "- A customer often volunteers several fields at once. Record all of them.",
    "- Report the value verbatim. Normalisation happens downstream.",
    "- If they asked about rates, savings, or which plan is better, intent is question.",
    "- If you could not make out what they said, intent is unclear and patches is empty.",
  ].join("\n");
}

/**
 * Runs the extractor and resolves each patch against the journey's validators.
 *
 * `sttConfidence` is the mean word confidence over the utterance. It multiplies the
 * extractor's own score, so a confidently-extracted mishearing still fails the
 * floor and gets re-asked rather than written.
 */
export async function extract(opts: {
  journey: Journey;
  form: Form;
  utterance: string;
  asking: JourneyField | null;
  sttConfidence: number | null;
}): Promise<{ accepted: AcceptedPatch[]; rejected: RejectedPatch[]; intent: Intent; ms: number }> {
  const { journey, utterance, asking } = opts;

  const { value, ms } = await toolCall<ExtractionResult>({
    system: systemPrompt(journey, asking),
    user: utterance,
    tool: extractionTool(journey),
    mock: { patches: [], intent: "unclear", unasked_fields_mentioned: [] },
  });

  const accepted: AcceptedPatch[] = [];
  const rejected: RejectedPatch[] = [];

  for (const patch of value.patches ?? []) {
    const field = journey.fields.find((f) => f.id === patch.field);
    if (!field) continue;

    // Guardrail: the engine never asks for a sensitive field, and must not record
    // one the customer volunteers either. That path goes to SENSITIVE handoff.
    if (field.sensitive) {
      rejected.push({ field: patch.field, reason: "sensitive field", evidence: patch.evidence });
      continue;
    }

    const result = normalise(field, patch.value);
    if (!result.ok) {
      rejected.push({ field: patch.field, reason: result.reason, evidence: patch.evidence });
      continue;
    }

    const confidence = combineConfidence(patch.confidence, opts.sttConfidence);
    if (confidence < CONFIDENCE_FLOOR) {
      rejected.push({
        field: patch.field,
        reason: `confidence ${confidence.toFixed(2)} below ${CONFIDENCE_FLOOR}`,
        evidence: patch.evidence,
      });
      continue;
    }

    accepted.push({
      field: patch.field,
      value: result.value,
      confidence,
      evidence: patch.evidence,
      needsConfirm: field.confirm !== "none",
    });
  }

  // The customer said a postcode but not a state. Infer it rather than asking a
  // question they will find strange.
  inferState(journey, accepted);

  return { accepted, rejected, intent: value.intent ?? "unclear", ms };
}

/**
 * A model that is 0.95 sure about a word the STT heard at 0.5 is 0.5 sure overall.
 * Multiplying is harsher than averaging, which is the right bias for a field that
 * ends up in a submitted payload.
 */
export function combineConfidence(extractor: number, stt: number | null): number {
  const e = Math.max(0, Math.min(1, extractor));
  if (stt === null) return e;
  return e * Math.max(0, Math.min(1, stt));
}

function inferState(journey: Journey, accepted: AcceptedPatch[]): void {
  const hasState = accepted.some((p) => p.field === "state");
  const postcode = accepted.find((p) => p.field === "postcode");
  if (hasState || !postcode) return;

  const stateField = journey.fields.find((f) => f.id === "state");
  if (!stateField) return;

  const inferred = stateFromPostcode(String(postcode.value));
  if (!inferred) return;

  accepted.push({
    field: "state",
    value: inferred,
    // Inherited, not independently heard: the postcode is the evidence.
    confidence: postcode.confidence,
    evidence: `inferred from postcode ${postcode.value}`,
    needsConfirm: stateField.confirm !== "none",
  });
}

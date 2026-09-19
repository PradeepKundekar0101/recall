import type { FieldValue, Journey, JourneyField, Lead } from "@recall/shared";

/**
 * What the operator set up on the console before dialling.
 *
 * Seeds and removals are folded into the lead's prefill, which is the one place
 * the engine reads "already known" from; the brief rides alongside to the voice
 * prompt. Neither reaches the dial target: `lead.phone` is set at load from
 * TEST_NUMBERS and nothing here touches it, so guardrail 1 holds whatever the
 * console sends.
 */

export type ParsedSetup = {
  prefill: Record<string, FieldValue | null>;
  agentBrief: string | null;
};

/** Long enough for a paragraph of direction, short enough to stay a brief. */
export const BRIEF_MAX_CHARS = 600;

/**
 * Reads the setup off a POST /calls body. The body is refused whole rather
 * than partly applied, so the call never runs on a setup the operator did not
 * see on screen.
 */
export function parseSetup(
  body: unknown,
  journey: Journey
): { ok: true; setup: ParsedSetup } | { ok: false; error: string } {
  const b = isPlainObject(body) ? body : {};
  const prefill: Record<string, FieldValue | null> = {};

  if (b.prefill !== undefined) {
    if (!isPlainObject(b.prefill)) return { ok: false, error: "prefill must be an object of field values" };
    for (const [id, raw] of Object.entries(b.prefill)) {
      const field = journey.fields.find((f) => f.id === id);
      if (!field) return { ok: false, error: `prefill: ${id} is not a field of this journey` };
      const value = seedValue(field, raw);
      if (value === undefined) return { ok: false, error: `prefill: ${id} ${expected(field)}` };
      prefill[id] = value;
    }
  }

  let agentBrief: string | null = null;
  if (b.agent_brief !== undefined && b.agent_brief !== null) {
    if (typeof b.agent_brief !== "string") return { ok: false, error: "agent_brief must be text" };
    const trimmed = b.agent_brief.trim();
    if (trimmed.length > BRIEF_MAX_CHARS) {
      return { ok: false, error: `agent_brief must be ${BRIEF_MAX_CHARS} characters or fewer` };
    }
    agentBrief = trimmed || null;
  }

  return { ok: true, setup: { prefill, agentBrief } };
}

/** The lead as the engine should see it. The original is left alone. */
export function applySetup(lead: Lead, setup: ParsedSetup): Lead {
  const prefill: Record<string, FieldValue> = { ...lead.prefill };
  for (const [id, value] of Object.entries(setup.prefill)) {
    if (value === null) delete prefill[id];
    else prefill[id] = value;
  }
  return { ...lead, prefill };
}

/**
 * A seed as the form should hold it: null for a removal, undefined when the
 * value cannot be taken. A blank string is a removal, because that is what an
 * emptied input box sends.
 */
function seedValue(field: JourneyField, raw: unknown): FieldValue | null | undefined {
  if (raw === null) return null;
  if (typeof raw === "string" && raw.trim() === "") return null;
  switch (field.type) {
    case "bool":
      return typeof raw === "boolean" ? raw : undefined;
    case "enum":
      return typeof raw === "string" && (field.options ?? []).includes(raw) ? raw : undefined;
    default:
      if (typeof raw === "string") return raw.trim();
      if (typeof raw === "number" && Number.isFinite(raw)) return raw;
      return undefined;
  }
}

function expected(field: JourneyField): string {
  if (field.type === "bool") return "takes true or false";
  if (field.type === "enum") return `must be one of ${(field.options ?? []).join(", ")}`;
  return "must be text";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

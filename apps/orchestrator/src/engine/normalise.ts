import type { FieldValue, JourneyField } from "@recall/shared";

/**
 * Normalisation and validation, in code rather than in the model.
 *
 * The spec is deliberate about this: asking an LLM to return an ISO date is asking
 * it to be a date parser, and it will be wrong occasionally and confidently. The
 * extractor returns what it heard; this file decides what that means and whether it
 * is acceptable. A value that fails here is re-asked, never written.
 */

export type NormResult =
  | { ok: true; value: FieldValue }
  | { ok: false; reason: string };

/** Postcode ranges, so the state can be inferred when the customer does not say it. */
const STATE_BY_POSTCODE: [number, number, string][] = [
  [1000, 2599, "NSW"],
  [2619, 2899, "NSW"],
  [2921, 2999, "NSW"],
  [2600, 2618, "ACT"],
  [2900, 2920, "ACT"],
  [3000, 3999, "VIC"],
  [4000, 4999, "QLD"],
  [5000, 5799, "SA"],
  [6000, 6797, "WA"],
  [7000, 7799, "TAS"],
  [800, 899, "NT"],
];

export function stateFromPostcode(postcode: string): string | null {
  const n = Number(postcode);
  if (!Number.isInteger(n)) return null;
  for (const [lo, hi, state] of STATE_BY_POSTCODE) {
    if (n >= lo && n <= hi) return state;
  }
  return null;
}

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

/**
 * Dates as people say them on the phone: "seventh of March 1989", "7/3/1989",
 * "March 7 1989". Day-first, because this is Australia and "3/7" is July.
 */
export function normaliseDate(raw: string): NormResult {
  const text = raw.toLowerCase().trim();

  const iso = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) return buildDate(Number(iso[3]), Number(iso[2]), Number(iso[1]));

  const slash = text.match(/\b(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})\b/);
  if (slash) {
    const year = Number(slash[3]);
    return buildDate(Number(slash[1]), Number(slash[2]), year < 100 ? 1900 + year : year);
  }

  const dayFirst = text.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([a-z]+)\,?\s+(\d{4})\b/);
  if (dayFirst && MONTHS[dayFirst[2] as string]) {
    return buildDate(Number(dayFirst[1]), MONTHS[dayFirst[2] as string] as number, Number(dayFirst[3]));
  }

  const monthFirst = text.match(/\b([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?\,?\s+(\d{4})\b/);
  if (monthFirst && MONTHS[monthFirst[1] as string]) {
    return buildDate(Number(monthFirst[2]), MONTHS[monthFirst[1] as string] as number, Number(monthFirst[3]));
  }

  return { ok: false, reason: "could not read a date" };
}

function buildDate(day: number, month: number, year: number): NormResult {
  if (month < 1 || month > 12) return { ok: false, reason: "month out of range" };
  if (day < 1 || day > 31) return { ok: false, reason: "day out of range" };
  if (year < 1900 || year > 2100) return { ok: false, reason: "year out of range" };
  const date = new Date(Date.UTC(year, month - 1, day));
  // Rejects the 31st of February, which the constructor would happily roll over.
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return { ok: false, reason: "not a real date" };
  }
  return { ok: true, value: date.toISOString().slice(0, 10) };
}

/** Australian mobile or landline to E.164. */
export function normalisePhone(raw: string): NormResult {
  const digits = raw.replace(/[^\d+]/g, "");
  if (/^\+61\d{9}$/.test(digits)) return { ok: true, value: digits };
  if (/^0\d{9}$/.test(digits)) return { ok: true, value: `+61${digits.slice(1)}` };
  if (/^\d{9}$/.test(digits)) return { ok: true, value: `+61${digits}` };
  return { ok: false, reason: "not an Australian phone number" };
}

/**
 * Joins a spelled-out address: "p-r-i-y-a dot sharma at gmail dot com".
 *
 * Deepgram returns spelled letters as separate tokens, so the words have to be
 * rejoined before the result can be validated as an email at all.
 */
export function normaliseEmail(raw: string): NormResult {
  let text = raw.toLowerCase().trim();
  text = text
    .replace(/\s+at\s+/g, "@")
    .replace(/\s+dot\s+/g, ".")
    .replace(/\s+underscore\s+/g, "_")
    .replace(/\s+(?:dash|hyphen)\s+/g, "-");
  // Single letters separated by spaces or hyphens are a spelled-out run.
  text = text.replace(/\b(?:[a-z][\s-]+){2,}[a-z]\b/g, (run) => run.replace(/[\s-]+/g, ""));
  text = text.replace(/\s+/g, "");

  if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(text)) {
    return { ok: false, reason: "not a valid email address" };
  }
  return { ok: true, value: text };
}

export function normalisePostcode(raw: string): NormResult {
  const digits = raw.replace(/\D/g, "");
  if (!/^\d{4}$/.test(digits)) return { ok: false, reason: "postcode must be four digits" };
  if (!stateFromPostcode(digits)) return { ok: false, reason: "not an Australian postcode" };
  return { ok: true, value: digits };
}

/** NMI: 10 or 11 characters, digits and uppercase letters, no I or O. */
export function normaliseNmi(raw: string): NormResult {
  const value = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!/^[0-9A-HJ-NP-Z]{10,11}$/.test(value)) {
    return { ok: false, reason: "NMI must be 10 or 11 letters and digits" };
  }
  return { ok: true, value };
}

const YES = /\b(yes|yeah|yep|yup|correct|that's right|sure|ok|okay|i do|i am|affirmative)\b/i;
const NO = /\b(no|nope|nah|not really|incorrect|that's wrong|i don't|i'm not|negative)\b/i;

/** Returns null when the answer is neither, which routes to a re-ask. */
export function normaliseBool(raw: string): boolean | null {
  const hasNo = NO.test(raw);
  const hasYes = YES.test(raw);
  // "no, that's right" is agreement; check the stronger signal last.
  if (hasYes && !hasNo) return true;
  if (hasNo && !hasYes) return false;
  if (hasYes && hasNo) return /\b(correct|that's right)\b/i.test(raw);
  return null;
}

/**
 * Applies the right normaliser for a field, then checks it against the field's
 * declared validator and enum options.
 */
export function normalise(field: JourneyField, raw: string): NormResult {
  const text = raw.trim();
  if (!text) return { ok: false, reason: "empty" };

  switch (field.type) {
    case "date": {
      const result = normaliseDate(text);
      if (!result.ok) return result;
      if (field.validate === "date_past" && String(result.value) >= new Date().toISOString().slice(0, 10)) {
        return { ok: false, reason: "date must be in the past" };
      }
      return result;
    }
    case "phone":
      return normalisePhone(text);
    case "email":
      return normaliseEmail(text);
    case "digits":
      return field.validate === "postcode_au"
        ? normalisePostcode(text)
        : { ok: true, value: text.replace(/\D/g, "") };
    case "alphanumeric":
      return field.validate === "nmi" ? normaliseNmi(text) : { ok: true, value: text };
    case "bool": {
      const value = normaliseBool(text);
      return value === null ? { ok: false, reason: "not a yes or a no" } : { ok: true, value };
    }
    case "enum": {
      const options = field.options ?? [];
      const lower = text.toLowerCase();
      const hit = options.find((o) => lower.includes(o.toLowerCase().replace(/_/g, " ")) || lower === o.toLowerCase());
      return hit ? { ok: true, value: hit } : { ok: false, reason: `expected one of ${options.join(", ")}` };
    }
    case "text":
    default:
      return { ok: true, value: text.replace(/\s+/g, " ") };
  }
}

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

/**
 * Ordinals as people actually say them on the phone.
 *
 * "Seventh of March" is the normal way to say a date out loud, and a parser that
 * only accepts "7 March" re-asks a customer who answered perfectly well. Spelled
 * cardinals are included too, because STT transcribes "twenty five" either way
 * depending on the surrounding words.
 */
const ORDINAL_WORDS: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7,
  eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12, thirteenth: 13,
  fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17, eighteenth: 18,
  nineteenth: 19, twentieth: 20, "twenty-first": 21, "twenty-second": 22,
  "twenty-third": 23, "twenty-fourth": 24, "twenty-fifth": 25, "twenty-sixth": 26,
  "twenty-seventh": 27, "twenty-eighth": 28, "twenty-ninth": 29, thirtieth: 30,
  "thirty-first": 31,
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
};

/** Rewrites spoken ordinals to digits so one set of patterns handles both forms. */
function digitiseOrdinals(text: string): string {
  let out = text;
  // Longest first, so "twenty-first" is not matched as "first".
  const words = Object.keys(ORDINAL_WORDS).sort((a, b) => b.length - a.length);
  for (const word of words) {
    const spaced = word.replace("-", "[\\s-]+");
    out = out.replace(new RegExp(`\\b${spaced}\\b`, "g"), String(ORDINAL_WORDS[word]));
  }
  return out;
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
  const text = digitiseOrdinals(raw.toLowerCase().trim());

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

/**
 * Spoken digits to digits.
 *
 * Postcodes and NMIs use the `spell` capture mode, so the customer is explicitly
 * asked to read them out one character at a time - "two one five zero" is the
 * expected answer, not the exception. "oh" and "o" are both zero, because that is
 * how people read a leading zero aloud.
 */
const SPOKEN_DIGITS: Record<string, string> = {
  zero: "0", oh: "0", o: "0", nought: "0",
  one: "1", two: "2", three: "3", four: "4", five: "5",
  six: "6", seven: "7", eight: "8", nine: "9",
  double: "", triple: "", // handled below
};

export function digitsFromSpeech(raw: string): string {
  const tokens = raw
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  let out = "";
  let repeat = 1;
  for (const token of tokens) {
    if (token === "double") {
      repeat = 2;
      continue;
    }
    if (token === "triple") {
      repeat = 3;
      continue;
    }
    if (/^\d+$/.test(token)) {
      out += token.repeat(repeat);
      repeat = 1;
      continue;
    }
    const digit = SPOKEN_DIGITS[token];
    if (digit) {
      out += digit.repeat(repeat);
      repeat = 1;
    }
    // Anything else is filler ("it's", "postcode") and is skipped rather than
    // failing the parse - people rarely answer with bare digits.
  }
  return out;
}

export function normalisePostcode(raw: string): NormResult {
  const digits = /\d/.test(raw) ? raw.replace(/\D/g, "") : digitsFromSpeech(raw);
  if (!/^\d{4}$/.test(digits)) return { ok: false, reason: "postcode must be four digits" };
  if (!stateFromPostcode(digits)) return { ok: false, reason: "not an Australian postcode" };
  return { ok: true, value: digits };
}

/** NMI: 10 or 11 characters, digits and uppercase letters, no I or O. */
export function normaliseNmi(raw: string): NormResult {
  // An NMI read aloud is mostly spoken digits with the odd letter, so fall back to
  // the spoken-digit reader when nothing numeric came through.
  const value = /\d/.test(raw)
    ? raw.toUpperCase().replace(/[^A-Z0-9]/g, "")
    : digitsFromSpeech(raw).toUpperCase();
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
 * Matches an utterance to one of an enum's options.
 *
 * In the normal path the extractor has already mapped free speech to an option,
 * because the tool schema lists them - so this is usually an identity check. It is
 * tolerant anyway, because models sometimes echo the customer's words back
 * instead: "we\'re moving in" has to reach `move_in`, and "already living here"
 * has to reach `existing`, which no amount of string matching gets to without the
 * synonyms the journey config carries.
 */
function matchEnum(field: JourneyField, text: string): NormResult {
  const options = field.options ?? [];
  const lower = text.toLowerCase().trim();

  const exact = options.find((o) => o.toLowerCase() === lower);
  if (exact) return { ok: true, value: exact };

  const words = lower.replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);

  for (const option of options) {
    const terms = [option, ...(field.synonyms?.[option] ?? [])];
    for (const term of terms) {
      const termWords = term.toLowerCase().replace(/_/g, " ").split(/\s+/).filter(Boolean);
      // Every word of the term has to appear, allowing a shared prefix so
      // "moving" matches "move". Four characters is enough to avoid "in"
      // matching "interested".
      const allPresent = termWords.every((tw) =>
        words.some((w) => w === tw || (tw.length >= 4 && (w.startsWith(tw.slice(0, 4)) || tw.startsWith(w.slice(0, 4)))))
      );
      if (allPresent) return { ok: true, value: option };
    }
  }
  return { ok: false, reason: `expected one of ${options.join(", ")}` };
}

/**
 * Applies the right normaliser for a field, then checks it against the field\'s
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
    case "digits": {
      if (field.validate === "postcode_au") return normalisePostcode(text);
      const digits = /\d/.test(text) ? text.replace(/\D/g, "") : digitsFromSpeech(text);
      return digits ? { ok: true, value: digits } : { ok: false, reason: "no digits heard" };
    }
    case "alphanumeric":
      return field.validate === "nmi" ? normaliseNmi(text) : { ok: true, value: text };
    case "bool": {
      const value = normaliseBool(text);
      return value === null ? { ok: false, reason: "not a yes or a no" } : { ok: true, value };
    }
    case "enum":
      return matchEnum(field, text);
    case "text":
    default:
      return { ok: true, value: text.replace(/\s+/g, " ") };
  }
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function ordinal(day: number): string {
  if (day % 100 >= 11 && day % 100 <= 13) return `${day}th`;
  return `${day}${["th", "st", "nd", "rd"][day % 10] ?? "th"}`;
}

/**
 * How a normalised value should be said out loud.
 *
 * Values are stored normalised because that is what the payload needs, but a
 * read-back is for a human: "So that's the 1989-03-07?" is not a question anyone
 * answers yes to. Dates become spoken dates, booleans become yes and no, and
 * enum values lose their underscores.
 */
export function speakableValue(field: JourneyField, value: FieldValue): string {
  if (value === null || value === undefined) return "";

  if (field.type === "date" && typeof value === "string") {
    const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (match) {
      const [, year, month, day] = match;
      const name = MONTH_NAMES[Number(month) - 1];
      if (name) return `${ordinal(Number(day))} of ${name}, ${year}`;
    }
  }

  if (field.type === "bool") return value ? "yes" : "no";
  if (field.type === "enum" && typeof value === "string") return value.replace(/_/g, " ");

  return String(value);
}

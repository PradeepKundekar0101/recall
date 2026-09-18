import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Journey, JourneyField } from "@recall/shared";
import { journeySchema } from "./schema.js";

const here = dirname(fileURLToPath(import.meta.url));

let cached: Journey | null = null;

/**
 * Loads and validates `energy.journey.json`.
 *
 * Read from disk rather than imported so a script edit during rehearsal is one
 * restart away, not a rebuild. Throws on an invalid config: a journey the engine
 * half-understands is worse than one it refuses to start with.
 */
export function loadJourney(file = "energy.journey.json"): Journey {
  if (cached) return cached;
  const path = resolve(here, file);
  const parsed = journeySchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`);
    throw new Error(`${file} is invalid:\n${lines.join("\n")}`);
  }
  cached = parsed.data;
  return cached;
}

export function fieldById(journey: Journey, id: string): JourneyField | undefined {
  return journey.fields.find((f) => f.id === id);
}

export function fieldsInSection(journey: Journey, sectionId: string): JourneyField[] {
  return journey.fields.filter((f) => f.section === sectionId);
}

/** Required fields only; the review gate refuses to submit until each is confirmed. */
export function requiredFields(journey: Journey): JourneyField[] {
  return journey.fields.filter((f) => f.required);
}

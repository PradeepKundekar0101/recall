import { loadJourney } from "./index.js";

/**
 * `pnpm journey:check`. Run it after dropping CIMET's real field list in, before
 * finding out at dial time that a section has no fields.
 */
try {
  const journey = loadJourney();
  const required = journey.fields.filter((f) => f.required).length;
  const conditional = journey.fields.filter((f) => f.ask_when).length;
  console.log(`ok  ${journey.id} v${journey.version}`);
  console.log(`    ${journey.sections.length} sections, ${journey.fields.length} fields`);
  console.log(`    ${required} required, ${conditional} conditional`);
  for (const section of journey.sections) {
    const ids = journey.fields.filter((f) => f.section === section.id).map((f) => f.id);
    console.log(`    ${section.id.padEnd(12)} ${ids.join(", ")}`);
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

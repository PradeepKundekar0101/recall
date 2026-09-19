import type { FieldValue, Journey, JourneyField, Lead } from "@recall/shared";

/** A section's title for its id, or the id when the journey is not loaded yet. */
export function sectionTitle(journey: Journey | null, id: string): string {
  return journey?.sections.find((s) => s.id === id)?.title ?? id;
}

/** The seeds as the operator first sees them: whatever the lead carried in from the web journey. */
export function seedsFromLead(lead: Lead, journey: Journey): Record<string, FieldValue | null> {
  return Object.fromEntries(journey.fields.map((f) => [f.id, lead.prefill[f.id] ?? null]));
}

/**
 * A plausible value to seed a field with in one click: the lead's own value if
 * it carried one, otherwise a stand-in that the journey's validators accept.
 * Keyed by field id first, so a field CIMET adds still gets something sensible
 * from its type.
 */
export function sampleSeed(field: JourneyField, lead: Lead): FieldValue {
  const own = lead.prefill[field.id];
  if (own !== undefined && own !== null) return own;
  const sample = SAMPLES[field.id];
  if (sample !== undefined) return typeof sample === "function" ? sample(lead) : sample;
  switch (field.type) {
    case "bool":
      return true;
    case "enum":
      return field.options?.[0] ?? "";
    case "date":
      return "2026-10-01";
    case "digits":
      return "2000";
    case "phone":
      return lead.phone;
    case "email":
      return lead.email ?? `${lead.first_name.toLowerCase()}@example.com`;
    default:
      return "Sample";
  }
}

const SAMPLES: Record<string, FieldValue | ((lead: Lead) => FieldValue)> = {
  full_name: (l) => l.full_name,
  dob: "1989-03-07",
  account_holder: true,
  phone: (l) => l.phone,
  email: (l) => l.email ?? `${l.first_name.toLowerCase()}@example.com`,
  street: "42 Wattle Street",
  suburb: "Ashfield",
  postcode: "2131",
  state: "NSW",
  fuel_type: "electricity",
  nmi: "41031234567",
  connection_type: "existing",
  move_in_date: "2026-10-01",
  concession: false,
  concession_type: "pension",
  life_support: false,
  plan_id: (l) => l.plan_id ?? "PLAN-EN-0331",
};

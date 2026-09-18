"use client";

import type { FormState, Journey } from "@recall/shared";

/**
 * The journey form, rendered straight from the config the orchestrator serves.
 *
 * Nothing about the field list is hard-coded here, which is the point: when
 * CIMET's real field list drops into energy.journey.json, this panel changes
 * without being edited.
 */
export function JourneyForm({
  journey,
  form,
  onSelect,
  selected,
}: {
  journey: Journey | null;
  form: FormState;
  onSelect?: (fieldId: string) => void;
  selected?: string | null;
}) {
  if (!journey) return <p className="empty">Waiting for the journey config.</p>;

  return (
    <>
      {journey.sections.map((section) => {
        const fields = journey.fields.filter((f) => f.section === section.id);
        return (
          <div className="section" key={section.id}>
            <div className="section-head">
              <span className="label">{section.title}</span>
              <span className="section-rule" />
            </div>

            {fields.map((field) => {
              const state = form[field.id];
              const status = state?.state ?? "empty";
              const isSelected = selected === field.id;
              return (
                <div
                  key={field.id}
                  className={`field f-${status}`}
                  role="button"
                  tabIndex={0}
                  aria-label={`${field.label}, ${status}`}
                  aria-pressed={isSelected}
                  onClick={() => onSelect?.(field.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onSelect?.(field.id);
                    }
                  }}
                >
                  <span className="field-label">
                    {field.label}
                    {field.required ? "" : " (optional)"}
                  </span>
                  <span className="field-value">
                    {status === "redacted" ? "[REDACTED]" : renderValue(state?.value)}
                  </span>
                  <span className="field-conf">
                    {state?.confidence != null ? `${Math.round(state.confidence * 100)}%` : ""}
                  </span>
                </div>
              );
            })}
          </div>
        );
      })}
    </>
  );
}

/**
 * A redacted field renders its marker rather than its value, independently of the
 * engine having nulled it. Two layers have to fail before intercepted card data
 * could reach a projector.
 */
function renderValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "boolean") return value ? "yes" : "no";
  return String(value);
}

"use client";

import { useEffect, useRef } from "react";
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
  activeSection,
  askingField,
}: {
  journey: Journey | null;
  form: FormState;
  onSelect?: (fieldId: string) => void;
  selected?: string | null;
  /** The section the agent is asking about right now, written in ink. */
  activeSection?: string | null;
  /** The field on the line, which the pane follows down as the call progresses. */
  askingField?: string | null;
}) {
  const followRef = useRef<HTMLDivElement>(null);

  /**
   * Follow the call down the form.
   *
   * Seventeen fields over six sections do not fit the pane, so by the third
   * section the part of the journey the agent is actually working on is below
   * the fold - and the one screen that is meant to show a call filling itself
   * in is showing the top of a form nobody is looking at.
   *
   * The scroll is done by hand on the pane body rather than with
   * `scrollIntoView`, which walks every scrollable ancestor: on a short window
   * the outer column is scrollable too, so it would yank the whole board -
   * header, transcript and all - every time the agent moved to a new field.
   */
  useEffect(() => {
    const field = followRef.current;
    if (!field || !askingField) return;

    const pane = field.closest(".pane-body");
    if (!(pane instanceof HTMLElement)) return;

    // Where the field sits inside the scroller, whatever is between them.
    const top = field.offsetTop - pane.offsetTop;
    const target = top - pane.clientHeight / 2 + field.offsetHeight / 2;
    const next = Math.max(0, Math.min(target, pane.scrollHeight - pane.clientHeight));

    // Already close enough. Without this the pane nudges itself on every
    // re-render - and a field.update arrives on nearly every turn.
    if (Math.abs(next - pane.scrollTop) < 8) return;

    /**
     * Reduced motion is honoured here rather than in CSS.
     *
     * `scroll-behavior` in a stylesheet does not govern a scroll that asked
     * for `behavior: "smooth"` explicitly - the argument wins - so a media
     * query over there would have looked like it was doing something and done
     * nothing. The follow still happens either way; it just arrives instead of
     * travelling.
     */
    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    pane.scrollTo({ top: next, behavior: still ? "auto" : "smooth" });
  }, [askingField]);

  if (!journey) return <p className="empty">Waiting for the journey config.</p>;

  return (
    <>
      {journey.sections.map((section) => {
        const fields = journey.fields.filter((f) => f.section === section.id);
        // A field is done once the customer has said yes to it. Captured and
        // prefilled values are still waiting on that yes.
        const done = fields.filter((f) => {
          const state = form[f.id]?.state;
          return state === "confirmed" || state === "submitted";
        }).length;
        const active = activeSection === section.id;
        return (
          <div className={`section${active ? " section-active" : ""}`} key={section.id}>
            <div className="section-head">
              <span className="label">{section.title}</span>
              <span className="section-rule" />
              <span className="section-count">
                {done} of {fields.length}
              </span>
            </div>

            {fields.map((field) => {
              const state = form[field.id];
              const status = state?.state ?? "empty";
              const isSelected = selected === field.id;
              const asking = askingField === field.id;
              return (
                <div
                  key={field.id}
                  // Only the field on the line carries the ref, so the effect
                  // above has exactly one thing it could scroll to.
                  ref={asking ? followRef : undefined}
                  className={`field f-${status}${asking ? " field-asking" : ""}`}
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

"use client";

import type { Journey, Lead } from "@recall/shared";
import { Portrait } from "./Portrait";
import { sectionTitle } from "../lib/journey";

export type LeadRow = Lead & { dial: { allowed: boolean; reason?: string }; on_dnc: boolean };

/**
 * Step one: who are we calling back.
 *
 * One card per dropped-off lead, with the facts the operator needs to choose:
 * where they dropped out, what they were looking at, and how much of the form
 * they already gave. A lead the guardrails will refuse says so on the card
 * rather than on a 403 after the dial.
 */
export function CustomerPicker({
  leads,
  journey,
  selected,
  onSelect,
  onContinue,
}: {
  leads: LeadRow[];
  journey: Journey | null;
  selected: string | null;
  onSelect: (leadId: string) => void;
  onContinue: () => void;
}) {
  return (
    <section className="step-body" aria-label="Choose the customer">
      <div className="intro">
        <h1 className="intro-title">Who are we calling back?</h1>
        <p className="intro-sub">
          Leads who dropped out of the Energy journey. Pick one to set up the recovery call.
        </p>
      </div>

      {leads.length ? (
        <div className="lead-grid">
          {leads.map((lead) => {
            const carried = journey
              ? journey.fields.filter((f) => lead.prefill[f.id] != null).length
              : Object.keys(lead.prefill).length;
            const isSelected = lead.id === selected;
            return (
              <button
                key={lead.id}
                type="button"
                className={`lead-card${isSelected ? " lead-card-selected" : ""}`}
                aria-pressed={isSelected}
                onClick={() => onSelect(lead.id)}
              >
                <Portrait id={lead.id} name={lead.full_name} size={64} />
                <span className="lead-card-name">{lead.full_name}</span>
                <span className="lead-card-id">
                  {lead.id} · {lead.phone}
                </span>
                <span className="lead-card-facts">
                  <span>Dropped at {sectionTitle(journey, lead.last_completed_step)}</span>
                  {lead.plan_name && <span>Was looking at {lead.plan_name}</span>}
                  <span>
                    {carried} of {journey?.fields.length ?? "?"} fields carried over
                  </span>
                </span>
                {lead.on_dnc ? (
                  <span className="chip chip-error">On the Do Not Call register</span>
                ) : !lead.dial.allowed ? (
                  <span className="chip chip-error">Dial refused</span>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : (
        <p className="empty">No leads loaded. The orchestrator serves them on /leads.</p>
      )}

      <div className="step-actions">
        <button type="button" className="btn btn-primary" onClick={onContinue} disabled={!selected || !journey}>
          Continue to fields
        </button>
      </div>
    </section>
  );
}

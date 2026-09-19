"use client";

import type { FieldValue, Journey, JourneyField } from "@recall/shared";
import type { LeadRow } from "./CustomerPicker";
import { sampleSeed } from "../lib/journey";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

/**
 * Step two: what the agent already knows, and how it should talk.
 *
 * Every journey field is an input with a button beside it. A seeded field is
 * confirmed in one line on the call ("I have 42 Wattle Street, is that right?");
 * an empty one is asked. Seed fills a plausible value in one click, Remove
 * empties it, and the operator can type anything in between. The brief goes to
 * the voice prompt for the lines the model rephrases; the scripts stay as written.
 */

const TONES = ["Warm and unhurried.", "Brisk and to the point.", "Plain English, no jargon.", "Formal, no first names."];

/** Radix Select forbids an empty-string item value, so "no seed yet" gets a sentinel instead. */
const UNSET = "__unset__";

/** Mirrors BRIEF_MAX_CHARS on the orchestrator. */
const BRIEF_MAX = 600;

export function CallSetup({
  lead,
  journey,
  seeds,
  onSeedsChange,
  brief,
  onBriefChange,
  dialling,
  onBack,
  onDial,
  onDnc,
}: {
  lead: LeadRow;
  journey: Journey | null;
  seeds: Record<string, FieldValue | null>;
  onSeedsChange: (seeds: Record<string, FieldValue | null>) => void;
  brief: string;
  onBriefChange: (brief: string) => void;
  dialling: boolean;
  onBack: () => void;
  onDial: () => void;
  onDnc: () => void;
}) {
  if (!journey) return <p className="empty">Waiting for the journey config.</p>;

  const seededCount = journey.fields.filter((f) => seeds[f.id] != null).length;
  const toAsk = journey.fields.length - seededCount;
  const setSeed = (id: string, value: FieldValue | null) => onSeedsChange({ ...seeds, [id]: value });

  return (
    <section className="setup" aria-label="Fields and brief">
      <div className="card card-flush setup-fields">
        <div className="card-head">
          <span className="pane-title">Fields</span>
          <span className="pane-meta">
            {seededCount} seeded · {toAsk} to ask
          </span>
        </div>
        <div className="card-body">
          <p className="card-hint">A seeded field is confirmed in one line on the call. An empty one is asked.</p>
          {journey.sections.map((section) => {
            const fields = journey.fields.filter((f) => f.section === section.id);
            return (
              <div className="section" key={section.id}>
                <div className="section-head">
                  <span className="label">{section.title}</span>
                  <span className="section-rule" />
                </div>
                {fields.map((field) => {
                  const value = seeds[field.id] ?? null;
                  const seeded = value !== null;
                  return (
                    <div className={`seed-row${seeded ? " seed-row-seeded" : ""}`} key={field.id}>
                      <label className="seed-label" htmlFor={`seed-${field.id}`}>
                        {field.label}
                        {field.required ? "" : " (optional)"}
                      </label>
                      <SeedControl
                        id={`seed-${field.id}`}
                        field={field}
                        value={value}
                        onChange={(v) => setSeed(field.id, v)}
                      />
                      <button
                        type="button"
                        className="btn btn-outline btn-sm"
                        onClick={() => setSeed(field.id, seeded ? null : sampleSeed(field, lead))}
                        aria-label={`${seeded ? "Remove" : "Seed"} ${field.label}`}
                      >
                        {seeded ? "Remove" : "Seed"}
                      </button>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>

      <div className="setup-side">
        <div className="card">
          <div className="card-head card-head-flush">
            <span className="pane-title">Agent brief</span>
            <span className="pane-meta">Optional</span>
          </div>
          <p className="card-hint">
            How the agent should talk on this call. The script stays as written; this shapes how its lines are said.
          </p>
          <div className="tones">
            {TONES.map((tone) => (
              <button
                type="button"
                key={tone}
                className={`tone${brief.includes(tone) ? " tone-on" : ""}`}
                aria-pressed={brief.includes(tone)}
                onClick={() => onBriefChange(toggleTone(brief, tone))}
              >
                {tone.replace(/\.$/, "")}
              </button>
            ))}
          </div>
          <textarea
            className="brief-input"
            value={brief}
            maxLength={BRIEF_MAX}
            rows={5}
            placeholder="e.g. Priya mentioned she is on a night shift, so keep it short and do not rush the read-backs."
            onChange={(e) => onBriefChange(e.target.value)}
            aria-label="Agent brief"
          />
          <div className="brief-count">
            {brief.length} / {BRIEF_MAX}
          </div>
        </div>

        <div className="card predial">
          <div className="card-head card-head-flush">
            <span className="pane-title">Before you dial</span>
          </div>
          <dl className="predial-rows">
            <div>
              <dt>Calling</dt>
              <dd>
                {lead.full_name} · {lead.phone}
              </dd>
            </div>
            <div>
              <dt>Fields</dt>
              <dd>
                {seededCount} to confirm · {toAsk} to ask
              </dd>
            </div>
            <div>
              <dt>Brief</dt>
              <dd>{brief.trim() ? `${countWords(brief)} words` : "none"}</dd>
            </div>
          </dl>
          {!lead.dial.allowed && (
            <div className="notice" role="status">
              {lead.dial.reason ?? "This number cannot be dialled."}
            </div>
          )}
          <div className="predial-actions">
            <button type="button" className="btn btn-outline" onClick={onDnc}>
              Add to Do Not Call
            </button>
            <span className="spacer" />
            <button type="button" className="btn btn-outline" onClick={onBack}>
              Back
            </button>
            <button type="button" className="btn btn-primary" onClick={onDial} disabled={dialling}>
              {dialling ? "Dialling" : "Dial"}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

/** The input for one field, shaped by its type: a yes/no or an option list where the journey has one. */
function SeedControl({
  id,
  field,
  value,
  onChange,
}: {
  id: string;
  field: JourneyField;
  value: FieldValue | null;
  onChange: (value: FieldValue | null) => void;
}) {
  if (field.type === "bool") {
    return (
      <Select
        value={value === null ? UNSET : value ? "yes" : "no"}
        onValueChange={(v) => onChange(v === UNSET ? null : v === "yes")}
      >
        <SelectTrigger id={id} className="select-sm">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={UNSET}>Agent will ask</SelectItem>
          <SelectItem value="yes">Yes</SelectItem>
          <SelectItem value="no">No</SelectItem>
        </SelectContent>
      </Select>
    );
  }
  if (field.type === "enum") {
    return (
      <Select value={value === null ? UNSET : String(value)} onValueChange={(v) => onChange(v === UNSET ? null : v)}>
        <SelectTrigger id={id} className="select-sm">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={UNSET}>Agent will ask</SelectItem>
          {(field.options ?? []).map((option) => (
            <SelectItem key={option} value={option}>
              {option}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }
  return (
    <input
      id={id}
      className="seed-input"
      type={field.type === "date" ? "date" : "text"}
      inputMode={field.type === "digits" || field.type === "phone" ? "tel" : undefined}
      value={value === null ? "" : String(value)}
      placeholder="Agent will ask"
      onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
    />
  );
}

function toggleTone(brief: string, tone: string): string {
  if (brief.includes(tone)) return brief.replace(tone, "").replace(/\s{2,}/g, " ").trim();
  return `${brief.trim()} ${tone}`.trim();
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

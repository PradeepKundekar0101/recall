/**
 * The journey config's public shape.
 *
 * `energy.journey.json` is the single source of truth for the call: the dialogue
 * engine walks it, the operator console renders it, the extraction prompt is built
 * from it, and the sandbox payload is mapped out of it. CIMET's real field list
 * drops in as a one-file edit, which is the whole reason it is declarative.
 *
 * The orchestrator validates the file against a zod schema at boot; these types are
 * the contract the console compiles against, so a field added there shows up here
 * without a second edit.
 */

/** How the agent gets the value out of the customer. */
export type CaptureMode =
  /** Extract from free speech. */
  | "natural"
  /** Yes/no, or one of an enum. */
  | "closed"
  /** Ask for it letter by letter or digit by digit. */
  | "spell";

/** How the agent plays the value back before accepting it. */
export type ConfirmMode =
  /** Speak the normalised value. */
  | "read_back"
  /** Spell it out character by character, grouped naturally. */
  | "letters"
  /** No read-back. Closed fields do not need one. */
  | "none";

export type FieldType =
  | "text"
  | "date"
  | "bool"
  | "phone"
  | "email"
  | "enum"
  | "digits"
  | "alphanumeric";

export type FieldScript = {
  /** First time of asking. */
  ask: string;
  /** After a mishear or a failed validation. */
  reask: string;
  /** Read-back template. `{value}` and `{value_spelled}` are substituted. */
  confirm?: string;
  /**
   * Spoken when the lead already carries a value: a yes/no confirmation of it,
   * with `{value}` and `{value_spelled}` substituted. Without one the engine
   * falls back to `confirm`, or to `ask` for a closed field whose question is
   * already a yes/no.
   */
  prefilled?: string;
};

export type JourneyField = {
  id: string;
  section: string;
  type: FieldType;
  label: string;
  required: boolean;
  capture: CaptureMode;
  confirm: ConfirmMode;
  script: FieldScript;
  /** Named validator in the engine's registry, e.g. "email", "postcode_au". */
  validate?: string;
  /** Allowed values when `type` is "enum". */
  options?: string[];
  /**
   * Phrases that mean an option but do not contain it.
   *
   * "Already living here" means `existing` and shares no words with it. The
   * extractor usually maps this itself, but models sometimes echo the customer
   * instead, and a declarative list is cheaper than a re-ask.
   */
  synonyms?: Record<string, string[]>;
  /**
   * Re-asks allowed before the CONFUSION escalation signal fires.
   * The brief's threshold is 2.
   */
  max_attempts: number;
  /**
   * The engine never asks for a sensitive field, and hands off if the customer
   * volunteers it. None in Energy; `card_number` is the motivating example.
   */
  sensitive: boolean;
  /**
   * Only ask when this predicate holds, e.g. `move_in_date` when
   * `connection_type === "move_in"`.
   */
  ask_when?: { field: string; equals: string | boolean };
};

export type JourneySection = {
  id: string;
  title: string;
  /** Fixed one-liner spoken when the section opens. */
  intro: string;
};

export type JourneyScripts = {
  opener: string;
  consent_yes: string;
  review: string;
  close: string;
  decline: string;
  busy: string;
  handoff_bridge: string;
  /** Said when the operator pulls the call back before it changes hands. */
  handoff_cancelled: string;
  no_advice: string;
  robot_disclosure: string;
};

export type Journey = {
  id: string;
  vertical: string;
  version: string;
  sections: JourneySection[];
  fields: JourneyField[];
  scripts: JourneyScripts;
};

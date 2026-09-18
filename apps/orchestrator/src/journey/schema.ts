import { z } from "zod";
import type { Journey } from "@recall/shared";

/**
 * The journey config is the single source of truth for the call, so it is worth
 * failing loudly at boot rather than discovering a typo mid-demo. Everything the
 * dialogue engine, the console, the extractor and the payload mapper rely on is
 * checked here, including the cross-field rules zod cannot express alone.
 */

const scriptSchema = z.object({
  ask: z.string().min(1),
  reask: z.string().min(1),
  confirm: z.string().min(1).optional(),
});

const fieldSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]*$/, "field ids are snake_case"),
  section: z.string().min(1),
  type: z.enum(["text", "date", "bool", "phone", "email", "enum", "digits", "alphanumeric"]),
  label: z.string().min(1),
  required: z.boolean(),
  capture: z.enum(["natural", "closed", "spell"]),
  confirm: z.enum(["read_back", "letters", "none"]),
  script: scriptSchema,
  validate: z.string().optional(),
  options: z.array(z.string().min(1)).optional(),
  max_attempts: z.number().int().min(1).max(5),
  sensitive: z.boolean(),
  ask_when: z
    .object({
      field: z.string().min(1),
      equals: z.union([z.string(), z.boolean()]),
    })
    .optional(),
});

const sectionSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  intro: z.string().min(1),
});

const scriptsSchema = z.object({
  opener: z.string().min(1),
  consent_yes: z.string().min(1),
  review: z.string().min(1),
  close: z.string().min(1),
  decline: z.string().min(1),
  busy: z.string().min(1),
  handoff_bridge: z.string().min(1),
  no_advice: z.string().min(1),
  robot_disclosure: z.string().min(1),
});

export const journeySchema = z
  .object({
    id: z.string().min(1),
    vertical: z.string().min(1),
    version: z.string().min(1),
    sections: z.array(sectionSchema).min(1),
    fields: z.array(fieldSchema).min(1),
    scripts: scriptsSchema,
  })
  .superRefine((journey, ctx) => {
    const sectionIds = new Set(journey.sections.map((s) => s.id));
    const fieldIds = new Set<string>();

    for (const [i, field] of journey.fields.entries()) {
      const at = (path: string) => ({ path: ["fields", i, path] as (string | number)[] });

      if (fieldIds.has(field.id)) {
        ctx.addIssue({ code: "custom", message: `duplicate field id "${field.id}"`, ...at("id") });
      }
      fieldIds.add(field.id);

      if (!sectionIds.has(field.section)) {
        ctx.addIssue({
          code: "custom",
          message: `field "${field.id}" is in unknown section "${field.section}"`,
          ...at("section"),
        });
      }

      // An enum the engine cannot enumerate is a field it cannot validate.
      if (field.type === "enum" && !field.options?.length) {
        ctx.addIssue({ code: "custom", message: `enum field "${field.id}" needs options`, ...at("options") });
      }
      if (field.type !== "enum" && field.options?.length) {
        ctx.addIssue({
          code: "custom",
          message: `options on non-enum field "${field.id}"`,
          ...at("options"),
        });
      }

      // A confirm mode with no template leaves the engine nothing to speak.
      if (field.confirm !== "none" && !field.script.confirm) {
        ctx.addIssue({
          code: "custom",
          message: `field "${field.id}" has confirm="${field.confirm}" but no confirm script`,
          ...at("script"),
        });
      }
      if (field.confirm === "none" && field.script.confirm) {
        ctx.addIssue({
          code: "custom",
          message: `field "${field.id}" has a confirm script but confirm="none"`,
          ...at("script"),
        });
      }

      // The engine never asks for a sensitive field, so a required one would
      // deadlock the call at the review gate.
      if (field.sensitive && field.required) {
        ctx.addIssue({
          code: "custom",
          message: `field "${field.id}" is both sensitive and required - the engine never asks for it, so it can never be filled`,
          ...at("sensitive"),
        });
      }
    }

    // Conditionals are resolved against the form, so the field they test has to
    // exist and has to be asked first.
    for (const [i, field] of journey.fields.entries()) {
      if (!field.ask_when) continue;
      const targetIndex = journey.fields.findIndex((f) => f.id === field.ask_when!.field);
      if (targetIndex === -1) {
        ctx.addIssue({
          code: "custom",
          message: `field "${field.id}" is conditional on unknown field "${field.ask_when.field}"`,
          path: ["fields", i, "ask_when", "field"],
        });
      } else if (targetIndex > i) {
        ctx.addIssue({
          code: "custom",
          message: `field "${field.id}" is conditional on "${field.ask_when.field}", which is asked later`,
          path: ["fields", i, "ask_when", "field"],
        });
      }
    }

    for (const [i, section] of journey.sections.entries()) {
      if (!journey.fields.some((f) => f.section === section.id)) {
        ctx.addIssue({
          code: "custom",
          message: `section "${section.id}" has no fields`,
          path: ["sections", i, "id"],
        });
      }
    }
  });

/** Compile-time proof that the zod schema and the shared type stay in step. */
export type ParsedJourney = z.infer<typeof journeySchema>;
const _shapeCheck: Journey = null as unknown as ParsedJourney;
void _shapeCheck;

import express from "express";
import { pathToFileURL } from "node:url";
import { env } from "../env.js";
import { log } from "../log.js";

/**
 * A local stand-in for CIMET's journey sandbox.
 *
 * It exists so the working-outcome criterion does not depend on their endpoint
 * being reachable from the venue network. It mirrors the placeholder payload:
 * 422 with the missing-field list on failure, 201 with a journey_id on success.
 * The console shows the response either way, so a failed submit is visible rather
 * than silent.
 */

const REQUIRED: Record<string, string[]> = {
  customer: ["full_name", "dob", "email", "phone", "account_holder"],
  supply: ["street", "suburb", "state", "postcode", "fuel_type"],
  connection: ["type"],
  eligibility: ["concession", "life_support"],
};

type Journey = { lead_id: string; journey_id: string; steps: Record<string, unknown>; completed: boolean };

const journeys = new Map<string, Journey>();

export function createMockSandbox() {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) => res.json({ ok: true, journeys: journeys.size }));

  // Incremental step save. Partial by definition, so it does not validate.
  app.put("/journeys/:leadId/steps/:step", (req, res) => {
    const { leadId, step } = req.params;
    const journey = journeys.get(leadId) ?? {
      lead_id: leadId,
      journey_id: `J-${leadId}-${Date.now().toString(36)}`,
      steps: {},
      completed: false,
    };
    journey.steps[step] = req.body?.data ?? {};
    journeys.set(leadId, journey);
    log.info(`mock sandbox: saved step "${step}" for ${leadId}`);
    res.status(200).json({ journey_id: journey.journey_id, step, saved: true });
  });

  // Final submit. This one validates.
  app.post("/journeys", (req, res) => {
    const payload = req.body ?? {};
    const missing: string[] = [];

    for (const [section, fields] of Object.entries(REQUIRED)) {
      const block = (payload[section] ?? {}) as Record<string, unknown>;
      for (const field of fields) {
        const value = block[field];
        // `false` is a valid answer to "do you hold a concession card", so only
        // null, undefined and empty string count as missing.
        if (value === null || value === undefined || value === "") missing.push(`${section}.${field}`);
      }
    }
    if (!payload.plan_id) missing.push("plan_id");
    if (!payload.consent?.recorded) missing.push("consent.recorded");

    // Conditional fields, the same rules the journey config declares.
    if (payload.connection?.type === "move_in" && !payload.connection?.move_in_date) {
      missing.push("connection.move_in_date");
    }
    if (payload.eligibility?.concession === true && !payload.eligibility?.concession_type) {
      missing.push("eligibility.concession_type");
    }

    if (missing.length) {
      log.warn(`mock sandbox: rejected ${payload.lead_id} - ${missing.length} missing`);
      return res.status(422).json({ error: "missing_required_fields", missing });
    }

    const leadId = String(payload.lead_id);
    const existing = journeys.get(leadId);
    const journeyId = existing?.journey_id ?? `J-${leadId}-${Date.now().toString(36)}`;
    journeys.set(leadId, {
      lead_id: leadId,
      journey_id: journeyId,
      steps: existing?.steps ?? {},
      completed: true,
    });

    log.info(`mock sandbox: accepted ${leadId} -> ${journeyId}`);
    res.status(201).json({ journey_id: journeyId, status: "completed" });
  });

  app.get("/journeys/:leadId", (req, res) => {
    const journey = journeys.get(req.params.leadId);
    if (!journey) return res.status(404).json({ error: "not_found" });
    res.json(journey);
  });

  return app;
}

// `pnpm sandbox:mock`. Comparing resolved file URLs rather than matching on the
// basename, which would also fire when some other module shares the filename.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = env.mockSandboxPort;
  createMockSandbox().listen(port, () => log.info(`mock CIMET sandbox on :${port}`));
}

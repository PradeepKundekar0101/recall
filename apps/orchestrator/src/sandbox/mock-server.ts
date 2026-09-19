import express, { Router } from "express";
import { pathToFileURL } from "node:url";
import { env } from "../env.js";
import { log } from "../log.js";

/**
 * A local stand-in for CIMET's journey sandbox.
 *
 * It exists because no sandbox or mocked API was provided, so the working-outcome
 * criterion cannot depend on someone else's endpoint being reachable from the venue
 * network. It is mounted inside the orchestrator at `/mock-crm` by default, which
 * means one process to start instead of two - but the requests are ordinary HTTP
 * with ordinary status codes, and `SANDBOX_URL` still decides where they go, so
 * pointing at a real endpoint stays a config change.
 *
 * It mirrors the placeholder payload: 200 on an incremental field save, and on the
 * final submit either 422 with the missing-field list or 201 with a journey_id. The
 * console shows the request and the response either way, so a failed save is visible
 * rather than silent.
 */

const REQUIRED: Record<string, string[]> = {
  customer: ["full_name", "dob", "email", "phone", "account_holder"],
  supply: ["street", "suburb", "state", "postcode", "fuel_type"],
  connection: ["type"],
  eligibility: ["concession", "life_support"],
};

type Journey = {
  lead_id: string;
  journey_id: string;
  /** Field id to the last value saved for it, in the order the call confirmed them. */
  fields: Record<string, unknown>;
  completed: boolean;
};

const journeys = new Map<string, Journey>();

function journeyFor(leadId: string): Journey {
  const existing = journeys.get(leadId);
  if (existing) return existing;
  const created: Journey = {
    lead_id: leadId,
    journey_id: `J-${leadId}-${Date.now().toString(36)}`,
    fields: {},
    completed: false,
  };
  journeys.set(leadId, created);
  return created;
}

/** The routes themselves, so they can be mounted anywhere. */
export function mockSandboxRouter(): Router {
  const r = Router();

  r.get("/health", (_req, res) => res.json({ ok: true, journeys: journeys.size }));

  /**
   * Incremental field save. Partial by definition, so it does not validate - it
   * records the value, the confidence and where it came from, and reports how much
   * of the journey it is now holding.
   */
  r.put("/journeys/:leadId/fields/:field", (req, res) => {
    const { leadId, field } = req.params;
    const journey = journeyFor(leadId);
    journey.fields[field] = req.body?.value ?? null;

    log.info(`mock CRM: saved "${field}" for ${leadId} (${Object.keys(journey.fields).length} held)`);
    res.status(200).json({
      journey_id: journey.journey_id,
      field,
      saved: true,
      fields_held: Object.keys(journey.fields).length,
      received_at: new Date().toISOString(),
    });
  });

  // Final submit. This one validates.
  r.post("/journeys", (req, res) => {
    const payload = req.body ?? {};
    const missing: string[] = [];

    for (const [section, fields] of Object.entries(REQUIRED)) {
      const block = (payload[section] ?? {}) as Record<string, unknown>;
      for (const field of fields) {
        const value = block[field];
        // `false` is a valid answer to "are you the account holder", so only
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
      log.warn(`mock CRM: rejected ${payload.lead_id} - ${missing.length} missing`);
      return res.status(422).json({ error: "missing_required_fields", missing });
    }

    const leadId = String(payload.lead_id);
    const journey = journeyFor(leadId);
    journey.completed = true;

    log.info(`mock CRM: accepted ${leadId} -> ${journey.journey_id}`);
    res.status(201).json({
      journey_id: journey.journey_id,
      status: "completed",
      fields_held: Object.keys(journey.fields).length,
    });
  });

  r.get("/journeys/:leadId", (req, res) => {
    const journey = journeys.get(req.params.leadId);
    if (!journey) return res.status(404).json({ error: "not_found" });
    res.json(journey);
  });

  return r;
}

/** Standalone app, for running the mock on its own port. */
export function createMockSandbox() {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(mockSandboxRouter());
  return app;
}

// `pnpm sandbox:mock`. Comparing resolved file URLs rather than matching on the
// basename, which would also fire when some other module shares the filename.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = env.mockSandboxPort;
  createMockSandbox().listen(port, () => log.info(`mock CIMET sandbox on :${port}`));
}

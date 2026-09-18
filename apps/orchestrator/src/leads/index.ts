import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Lead } from "@recall/shared";
import { env } from "../env.js";

/**
 * Synthetic leads.
 *
 * Stands in for the ViciDial pick-the-lead cron, which is explicitly out of scope -
 * the console has a Dial button instead.
 *
 * Every lead's phone number is overwritten at load with the first entry in
 * TEST_NUMBERS. That is guardrail 1 enforced at the source: there is no code path
 * where a synthetic lead carries a number that is not a test phone, so a fixture
 * edited in a hurry at 2am cannot cause a real call.
 */

const here = dirname(fileURLToPath(import.meta.url));

let cached: Lead[] | null = null;

export function loadLeads(): Lead[] {
  if (cached) return cached;
  const raw = JSON.parse(readFileSync(resolve(here, "leads.json"), "utf8")) as Lead[];
  const testNumber = env.testNumbers[0] ?? "";

  cached = raw.map((lead) => ({
    ...lead,
    phone: testNumber,
    prefill: { ...lead.prefill, ...(lead.prefill.phone !== undefined ? { phone: testNumber } : {}) },
  }));
  return cached;
}

export function leadById(id: string): Lead | undefined {
  return loadLeads().find((l) => l.id === id);
}

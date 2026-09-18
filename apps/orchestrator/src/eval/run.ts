import { randomUUID } from "node:crypto";
import { loadJourney } from "../journey/index.js";
import { loadLeads } from "../leads/index.js";
import { SimTransport } from "../transports/sim.js";
import { newDialogue } from "../engine/dialogue.js";
import { personas, personaById } from "./personas.js";

/**
 * `pnpm eval` - the simulator harness.
 *
 * Runs the exact engine code against scripted personas, so the whole loop is
 * tested without a phone. The gate to move on from the simulator is 9 of 10.
 *
 * Right now it wires each persona up and reports that the turn loop is not
 * implemented, which is honest: the harness is real, the engine it drives is the
 * next build block. It fails loudly rather than reporting a green run over a
 * dialogue that never happened.
 */

type Result = { id: string; label: string; passed: boolean; detail: string };

async function main(): Promise<void> {
  const only = process.argv.find((a) => a.startsWith("--persona="))?.split("=")[1];
  const selected = only ? [personaById(only)].filter(Boolean) : personas;
  if (!selected.length) {
    console.error(`unknown persona "${only}". Known: ${personas.map((p) => p.id).join(", ")}`);
    process.exit(1);
  }

  const journey = loadJourney();
  const lead = loadLeads()[0];
  if (!lead) throw new Error("no synthetic leads loaded");

  const results: Result[] = [];

  for (const persona of selected) {
    if (!persona) continue;
    const callId = randomUUID();
    const transport = new SimTransport({ journey, lead, callId, persona });
    const dialogue = newDialogue({ callId, journey, lead, transport });

    try {
      await transport.start();
      // The turn loop lands in build block 0:15-1:30. Until then this throws,
      // which is the correct outcome: a harness that reported a pass here would
      // be reporting on a conversation that never took place.
      await dialogue.ctx.transport.speak(journey.scripts.opener);
      throw new Error("engine turn loop not implemented");
    } catch (err) {
      results.push({
        id: persona.id,
        label: persona.label,
        passed: false,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const passed = results.filter((r) => r.passed).length;
  console.log(`\njourney ${journey.id} v${journey.version}\n`);
  for (const result of results) {
    console.log(`${result.passed ? "pass" : "FAIL"}  ${result.label.padEnd(18)} ${result.detail}`);
  }
  console.log(`\n${passed}/${results.length} passed (gate: 9/10)`);
  process.exit(passed === results.length ? 0 : 1);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});

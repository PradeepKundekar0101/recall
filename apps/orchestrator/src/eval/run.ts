import { randomUUID } from "node:crypto";
import { loadJourney } from "../journey/index.js";
import { loadLeads } from "../leads/index.js";
import { SimTransport } from "../transports/sim.js";
import { createEngine } from "../engine/dialogue.js";
import { personas, personaById, assertions } from "./personas.js";
import { env, has } from "../env.js";

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

type Result = { id: string; label: string; passed: boolean; detail: string; skipped?: boolean };

/**
 * Personas whose path is decided by rules rather than by the model.
 *
 * These are exactly the guardrail demos, and they are meant to work when the LLM
 * is slow or unreachable - so they are the ones a dry run can legitimately judge.
 * Everything else needs extraction, and scoring it without a model would be
 * reporting a pass on a conversation that never happened.
 */
const RULE_ONLY = new Set(["decliner", "busy", "robot-checker"]);

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

  const dry = env.mockVoice || !has.llm();
  if (dry) {
    console.log(
      `\nrunning dry (${env.mockVoice ? "MOCK_VOICE=1" : `no key for ${env.llmProvider}`}).\n` +
        `extraction is inert, so only the rule-decided personas are scored; the rest are skipped.\n`
    );
  }

  const results: Result[] = [];

  for (const persona of selected) {
    if (!persona) continue;
    const callId = randomUUID();
    if (dry && !RULE_ONLY.has(persona.id)) {
      results.push({
        id: persona.id,
        label: persona.label,
        passed: false,
        skipped: true,
        detail: "skipped - needs a live model for extraction",
      });
      continue;
    }

    const transport = new SimTransport({ journey, lead, callId, persona });
    const engine = createEngine({
      callId,
      journey,
      lead,
      transport,
      hooks: {
        onAgentLine: () => {},
        onCustomerLine: () => {},
        onPartial: () => {},
        onFieldChange: () => {},
        onSection: () => {},
        onSignals: () => {},
        onHandoff: () => {},
        onGuardrail: () => {},
        onOutcome: () => {},
        persistField: () => {},
      },
    });

    try {
      await transport.start();
      await engine.begin();
      // The sim transport drives the conversation forward from inside speak(), so
      // by the time begin() resolves the persona has run to the end of its script.
      // Wait for any in-flight turn to settle before judging the outcome.
      await new Promise((r) => setTimeout(r, 50));

      const outcome = engine.state.outcome;
      const handsFree = engine.state.form.handsFree();
      const assertion = assertions[persona.id];
      const failure = assertion
        ? assertion({ outcome, spoken: transport.spoken, transferredTo: transport.transferredTo })
        : outcome === null
          ? `no outcome reached (phase ${engine.state.phase})`
          : null;

      results.push({
        id: persona.id,
        label: persona.label,
        passed: failure === null,
        detail:
          failure ??
          `${outcome ?? engine.state.phase} · ${handsFree.captured}/${handsFree.total} hands-free · ${engine.state.durationSeconds}s`,
      });
    } catch (err) {
      results.push({
        id: persona.id,
        label: persona.label,
        passed: false,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const scored = results.filter((r) => !r.skipped);
  const passed = scored.filter((r) => r.passed).length;

  console.log(`\njourney ${journey.id} v${journey.version}\n`);
  for (const result of results) {
    const tag = result.skipped ? "skip" : result.passed ? "pass" : "FAIL";
    console.log(`${tag}  ${result.label.padEnd(18)} ${result.detail}`);
  }

  if (dry) {
    console.log(`\n${passed}/${scored.length} rule-decided personas passed. ${results.length - scored.length} skipped.`);
    console.log("The 9/10 gate needs a live model - set a key and MOCK_VOICE=0.");
  } else {
    console.log(`\n${passed}/${results.length} passed (gate: 9/10)`);
  }
  process.exit(passed === scored.length ? 0 : 1);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});

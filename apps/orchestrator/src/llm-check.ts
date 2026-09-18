import { env, has } from "./env.js";
import { toolCall, streamSentences } from "./voice/llm.js";

/**
 * `pnpm llm:check` - proves the configured provider can do the two things the
 * engine needs, and measures what they cost in latency.
 *
 * Worth running per provider rather than trusting a table. The turn budget allows
 * 250 ms to first token, and a gateway in front of the model spends some of that
 * before the model has started - which is the whole question with OpenRouter.
 */

const TOOL = {
  name: "record_answer",
  description: "Record what the customer said as a patch to an energy comparison form.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["patches", "intent"],
    properties: {
      patches: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["field", "value"],
          properties: {
            field: { type: "string", enum: ["street", "suburb", "postcode", "email"] },
            value: { type: "string" },
          },
        },
      },
      intent: { type: "string", enum: ["answer", "decline", "busy", "question", "ask_human", "unclear"] },
    },
  },
};

const UTTERANCE = "Yeah it's 42 Wattle Street, Parramatta, and the postcode is two one five zero.";

/**
 * Repeats the measurement on a warm client.
 *
 * The first call pays DNS, TLS and connection setup, which a long-running
 * orchestrator pays once at boot and never again. A single cold sample would
 * condemn a provider for a cost the demo does not actually incur, so steady state
 * is what gets reported.
 */
const SAMPLES = Number(process.env.SAMPLES ?? 4);

function summarise(label: string, values: number[]): void {
  if (!values.length) return;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
  console.log(
    `${label.padEnd(10)} cold ${String(values[0]).padStart(5)}ms   ` +
      `warm median ${String(median).padStart(5)}ms   ` +
      `warm range ${Math.min(...values.slice(1))}-${Math.max(...values.slice(1))}ms`
  );
}

async function main(): Promise<void> {
  if (env.mockVoice) {
    console.error("MOCK_VOICE=1 - this check only means something with it off.");
    process.exit(1);
  }
  if (!has.llm()) {
    console.error(`no API key for LLM_PROVIDER=${env.llmProvider}`);
    process.exit(1);
  }

  console.log(`provider  ${env.llmProvider}`);
  console.log(`model     ${env.dialogueModel}`);
  console.log(`samples   ${SAMPLES} (first is cold)\n`);

  // ---- structured extraction ---------------------------------------------
  const toolTimes: number[] = [];
  let patches: { field: string; value: string }[] = [];
  let intent = "?";

  for (let i = 0; i < SAMPLES; i++) {
    const t0 = Date.now();
    const { value } = await toolCall<{ patches?: { field: string; value: string }[]; intent?: string }>({
      system:
        "You extract structured answers from one turn of a phone call about an Australian energy plan. " +
        "Record only fields the customer actually gave. Report values verbatim.",
      user: UTTERANCE,
      tool: TOOL,
      mock: { patches: [], intent: "unclear" },
    });
    toolTimes.push(Date.now() - t0);
    patches = value.patches ?? [];
    intent = value.intent ?? "?";
  }

  console.log(`extracted intent=${intent} patches=${patches.length}`);
  for (const p of patches) console.log(`          ${p.field} = ${p.value}`);
  console.log("");

  const fields = new Set(patches.map((p) => p.field));
  const wanted = ["street", "suburb", "postcode"];
  const missing = wanted.filter((f) => !fields.has(f));

  // ---- streaming ----------------------------------------------------------
  const streamTimes: number[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    const t1 = Date.now();
    let first: number | null = null;
    for await (const sentence of streamSentences({
      system: "You are a concise Australian call-centre assistant. One short sentence.",
      messages: [{ role: "user", content: "Say the line: Got that, thanks." }],
    })) {
      first ??= Date.now() - t1;
      void sentence;
    }
    streamTimes.push(first ?? Date.now() - t1);
  }

  summarise("tool call", toolTimes);
  summarise("stream", streamTimes);

  const toolWarm = toolTimes.slice(1);
  const streamWarm = streamTimes.slice(1);
  const medianOf = (xs: number[]) => {
    const s2 = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s2.length / 2);
    return s2.length % 2 ? s2[m]! : Math.round((s2[m - 1]! + s2[m]!) / 2);
  };
  const toolMs = toolWarm.length ? medianOf(toolWarm) : toolTimes[0]!;
  const firstSentenceMs = streamWarm.length ? medianOf(streamWarm) : streamTimes[0]!;

  // ---- verdict ------------------------------------------------------------
  console.log("");
  if (!patches.length) {
    console.error("FAIL  no patches extracted - tool calling is not working on this provider");
    process.exit(1);
  }
  if (missing.length) {
    console.error(`WARN  did not extract ${missing.join(", ")} from a turn that contained them`);
  }

  // The per-turn budget is ~800ms end to end, of which the model gets ~250ms to
  // first token. Anything past a second makes the call feel like a walkie-talkie.
  const budget = toolMs > 1000 || firstSentenceMs > 1000;
  if (budget) {
    console.error(
      `WARN  too slow for a live phone call.\n` +
        `      The turn budget allows ~250ms to first token and ~800ms end to end;\n` +
        `      warm medians here are ${toolMs}ms extraction and ${firstSentenceMs}ms to first sentence.\n` +
        `      Try a smaller model, or a direct provider key, before the demo.`
    );
  }
  console.log(missing.length || budget ? "Usable, with the caveats above." : "All checks passed.");
  process.exit(0);
}

void main().catch((err) => {
  console.error(`\nFAIL  ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

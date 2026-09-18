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
  console.log(`model     ${env.dialogueModel}\n`);

  // ---- structured extraction ---------------------------------------------
  const t0 = Date.now();
  const { value } = await toolCall<{ patches?: { field: string; value: string }[]; intent?: string }>({
    system:
      "You extract structured answers from one turn of a phone call about an Australian energy plan. " +
      "Record only fields the customer actually gave. Report values verbatim.",
    user: UTTERANCE,
    tool: TOOL,
    mock: { patches: [], intent: "unclear" },
  });
  const toolMs = Date.now() - t0;

  const patches = value.patches ?? [];
  console.log(`tool call ${toolMs}ms`);
  console.log(`          intent=${value.intent ?? "?"} patches=${patches.length}`);
  for (const p of patches) console.log(`          ${p.field} = ${p.value}`);

  const fields = new Set(patches.map((p) => p.field));
  const wanted = ["street", "suburb", "postcode"];
  const missing = wanted.filter((f) => !fields.has(f));

  // ---- streaming ----------------------------------------------------------
  console.log("");
  const t1 = Date.now();
  let firstSentenceMs: number | null = null;
  let sentences = 0;
  for await (const sentence of streamSentences({
    system: "You are a concise Australian call-centre assistant. One short sentence.",
    messages: [{ role: "user", content: "Say the line: Got that, thanks." }],
  })) {
    firstSentenceMs ??= Date.now() - t1;
    sentences++;
    void sentence;
  }
  console.log(`stream    first sentence in ${firstSentenceMs ?? "n/a"}ms, ${sentences} total`);

  // ---- verdict ------------------------------------------------------------
  console.log("");
  if (!patches.length) {
    console.error("FAIL  no patches extracted - tool calling is not working on this provider");
    process.exit(1);
  }
  if (missing.length) {
    console.error(`WARN  did not extract ${missing.join(", ")} from a turn that contained them`);
  }

  const budget = toolMs > 1500 || (firstSentenceMs ?? 0) > 1500;
  if (budget) {
    console.error(
      `WARN  slow for a phone call. The turn budget allows ~250ms to first token;\n` +
        `      measure a direct provider key before committing to this one for the demo.`
    );
  }
  console.log(missing.length || budget ? "Usable, with the caveats above." : "All checks passed.");
  process.exit(0);
}

void main().catch((err) => {
  console.error(`\nFAIL  ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

# RECALL

**RECALL** (Recovery Call).
Outbound AI voice agent that calls a dropped-off Energy lead, picks the comparison journey up where the customer left it, collects the remaining fields by phone, submits a valid payload to CIMET's journey sandbox, and hands the call to a human with full context the moment the conversation turns.

Built on the `buildin-hours` codebase (Panchayat AI).
Telephony, the transport seam, the SSE board and the eval harness are reused; Sarvam is replaced end to end for latency.

## Status

Infrastructure is built and verified dry.
The remaining gap is a real call: no vendor keys are set, so nothing below has been exercised against live audio yet.

**Tonight's target** is `CALL_MODE=echo` over a real phone: the agent repeats back what Scribe heard, under 1 s round trip.
Set the three keys, `MOCK_VOICE=0`, `TRANSPORT=pstn`, point ngrok at :8080, and press Dial.

| Area | State |
| --- | --- |
| Workspace, both apps, shared SSE contract | done |
| Journey config, zod schema, validation | done |
| Twilio + sim transports, barge-in, echo defence, warm transfer | done |
| Form state machine, normalisers, extraction, escalation detector | done |
| Guardrails: DNC, test-number, consent gate, card detection, decline | done |
| Sandbox mapping, incremental + final submit, mock server | done |
| Operator console, handoff console | done |
| Scribe v2 Realtime STT, Deepgram fallback | written, unverified against live audio |
| ElevenLabs Flash v2.5 TTS, disk pre-render | written, unverified against live audio |
| Dialogue engine, barge-in cancellation, silence handling | done |
| Echo mode and per-turn latency measurement | done |
| Energy scripts and field list | placeholder until the recording arrives |

## Getting started

Node 20 is pinned deliberately.
Node 22 and above ship a global `WebSocket` that silently drops the options argument, which means auth headers vanish from vendor sockets - this project has already lost an evening to that once.

```bash
nvm use && corepack pnpm install
```

### Providers

Every vendor sits behind an env switch, so swapping one is a config change rather than a code change.

| Switch | Options | Notes |
| --- | --- | --- |
| `STT_PROVIDER` | `scribe` (default), `deepgram` | Scribe is the build target. Both take Twilio's audio natively, so there is no transcode either way. |
| `LLM_PROVIDER` | `anthropic`, `openai`, `openrouter`, `gemini` | Blank means whichever key is set wins, preferring a direct key over the gateway. Reasoning is off on all of them. |
| `CALL_MODE` | `echo`, `journey` | `echo` repeats back what STT heard. It is the infrastructure check. |
| `TRANSPORT` | `sim`, `pstn` | `sim` runs the exact engine against scripted personas without dialling. |

**OpenRouter works, and is too slow to demo on.**
Measured with `pnpm llm:check`, warm, through the gateway:

| Model | Extraction | First sentence |
| --- | --- | --- |
| `google/gemini-2.5-flash-lite` | 1110 ms | 1067 ms |
| `openai/gpt-4o-mini` | 1686 ms | 3034 ms |
| `anthropic/claude-haiku-4.5` | 2067 ms | 1426 ms |

Cold and warm are near-identical, so this is not connection setup.
Three architecturally different models clustering above a hard floor of ~1050 ms is the signature of fixed gateway overhead, and the whole turn budget is 800 ms.
Get a direct Anthropic or OpenAI key for the demo; keep OpenRouter for trying models out.

**Mitigations already in place**, which matter whichever provider you use: every scripted line is pre-rendered and spoken verbatim, so the model is off the speech path entirely and a turn costs one extraction call rather than two round trips; a short pre-rendered filler plays at 400 ms so the line is never silent; and closed yes/no answers skip the sentiment classifier, removing a model call from the commonest turn in the journey.

**The older caveats still apply.**
It is OpenAI-compatible, so it uses the same client with a different base URL; set `OPENROUTER_API_KEY` and `LLM_PROVIDER=openrouter`, and use org-prefixed model ids like `anthropic/claude-haiku-4.5`.
The caveats are that it adds a network hop in front of the model, against a budget that only allows 250 ms to first token, and that `strict` tool calling is model-dependent behind the gateway - so it is sent without `strict` and the extractor's own validation holds the line instead.
Run `pnpm llm:check` to measure both before committing to it for the demo.

**Gemini is wired but never selected implicitly.**
Its published time-to-first-token at default thinking levels is an order of magnitude outside this project's 250 ms budget, and it has been stalling upstream.
It runs with `thinkingBudget: 0`; switch to it only after measuring in rehearsal.

Copy the env template and fill in the voice keys:

```bash
cp .env.example .env
```

Twilio and Supabase credentials are already carried over.
`ELEVENLABS_API_KEY` (used by both Scribe and Flash), `ELEVENLABS_VOICE_ID` and one LLM key still need filling, along with `HANDOFF_NUMBER` for the warm-transfer demo.

Run everything:

```bash
corepack pnpm dev
```

The orchestrator prints an integration report at boot, so a missing key is obvious before the demo rather than during it.

| Command | What it does |
| --- | --- |
| `pnpm dev` | Orchestrator on :8080 and console on :3000 |
| `pnpm dev:api` | Orchestrator only |
| `pnpm dev:web` | Console only |
| `pnpm sandbox:mock` | Mock CIMET sandbox on :4001 |
| `pnpm journey:check` | Validate `energy.journey.json` and print its shape |
| `pnpm llm:check` | Prove the configured LLM can do structured extraction and streaming, and measure both. Needs `MOCK_VOICE=0`. |
| `pnpm voice:check` | Synthesise a phrase with Flash, feed it back into Scribe, check the transcript. Needs `MOCK_VOICE=0`. |
| `pnpm voice:calibrate` | Measure the confidence scale clean vs degraded. Re-run on real phone audio. |
| `pnpm twilio:check` | Geo permissions, from-number, trial status, tunnel websocket upgrade |
| `pnpm eval` | Run the ten simulator personas (gate: 9/10) |
| `pnpm typecheck` | All three packages |

## Layout

```
apps/orchestrator/    Node 20 · TypeScript · Express · ESM
  src/journey/        energy.journey.json - the single source of truth
  src/voice/          Deepgram STT · ElevenLabs TTS · Claude Haiku
  src/transports/     Twilio media stream · simulator
  src/engine/         dialogue · fact-bus · extract · escalation · normalise
  src/sandbox/        mapping · submit · mock server
  src/eval/           ten personas and the harness
apps/web/             Next.js 15 · App Router
  app/                / operator console · /handoff human console
packages/shared/      The SSE event union, shared by both apps
```

## Where things live

**`src/journey/energy.journey.json` is the file that matters.**
The dialogue engine walks it, the operator console renders it, the extraction tool schema is generated from it, and the payload is mapped out of it.
When CIMET's real field list arrives, drop it in here and update `src/sandbox/mapping.ts`.
Nothing else should need to change.

**Guardrails live in the engine, not in prompts.**
No script and no model output can bypass them:

| Guardrail | Where |
| --- | --- |
| Test data only | `policy.canDial`, `transports/twilio.assertTestNumber`, and lead loading, which overwrites every fixture phone with a test number |
| Consent first | `engine/dialogue.ts` - entering a field state without consent throws |
| No card data by voice | `engine/escalation.looksLikeCardNumber` plus `Form.redact` |
| No advice | Extractor `intent = question` routes to the OFF_SCRIPT path |
| Do Not Call | `policy.onDncRegister`, checked before Twilio is touched |
| Respect "no" | Decline path plus `policy.addOptOut` |

**Normalisation is in code, never in the model.**
`engine/normalise.ts` owns dates, phone numbers, emails, postcodes and NMIs.
A model that is occasionally and confidently wrong about a date is worse than a parser that fails loudly.

**Disconnects are the normal case, not an exception.**
Every confirmed field is written to `call_events` the moment it is confirmed, so a call that drops after section three leaves three sections of real data behind.
`finalise()` is idempotent because the media stream's `stop` and Twilio's `completed` status callback race on every real call, in no guaranteed order.
Silence on an open question nudges at 6 s and 12 s, then closes as `abandoned`.

**Confidence multiplies rather than averages.**
The extractor's own score is multiplied by the STT word confidence over the evidence span, so a confidently-extracted mishearing still fails the 0.85 floor and gets re-asked instead of written.

## Known gaps

- **The confidence scale needs re-measuring on real phone audio.** The current baseline was measured on synthetic speech fed back through the encoder, which is not a mobile handset in a loud room. Run `pnpm voice:calibrate` once real call audio exists.
- **OpenRouter adds roughly a second of fixed latency**, which the turn budget cannot absorb. See below.
- `TEST_NUMBERS` currently holds an Indian number carried over from the old project. Replace it with the AU test numbers the organisers provide.
- The Energy field list and scripts in `energy.journey.json` are placeholders, pending the recording.
- The manual baseline for the efficiency counter is zero until it can be measured, rather than a number invented to make the comparison look good.
- 7 of the 10 eval personas need a live model; a dry run scores only the 3 rule-decided ones and says so.

## Confidence is a weak signal here, and read-back is the real gate

Scribe reports per-word log probabilities, not a 0-1 confidence.
Measured with `pnpm voice:calibrate` on this account: clean speech that transcribed perfectly scored **0.46-0.63** raw, and deliberately degraded audio scored **0.32-0.53**.
Those ranges overlap.

Two consequences, both load-bearing:

1. The thresholds carried over from Deepgram (accept at 0.85, LOW CONF under 0.6) would have rejected **every correct answer** and re-asked every field.
   Raw probability is now divided by a measured clean baseline, so 1.0 means "as confident as this model gets on clean audio", and the thresholds sit at 0.55 and 0.45 on that scale.
2. Because clean and degraded overlap, confidence cannot reliably separate a good answer from a bad one.
   A tight gate would mostly re-ask correct answers, which is a worse call than occasionally reading back a wrong one.
   **Read-back is the real gate**; confidence only catches genuinely broken turns and feeds the escalation meter.

Badly degraded audio produces *no transcript at all* rather than a low-confidence one, so that case is handled by the silence timers, not by LOW CONF.

## Node 20, and why Supabase nearly broke it

Node 20 is pinned because Node 22+ ships a global `WebSocket` that ignores the options argument, which silently drops the auth headers on the Scribe and ElevenLabs sockets.

`@supabase/realtime-js` has the opposite requirement: it throws outright when there is no native global `WebSocket`, and it is constructed eagerly inside `createClient`.
That killed the orchestrator on the first audit write.

The fix is to hand Supabase the `ws` package explicitly (`realtime: { transport: WebSocket }`), which is the same implementation every other socket here uses.
Upgrading to Node 22 would also satisfy Supabase and would reintroduce the header bug, so it is the wrong fix.

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
| `LLM_PROVIDER` | `anthropic`, `openai`, `gemini` | Blank means whichever key is set wins. Reasoning is off on all three. |
| `CALL_MODE` | `echo`, `journey` | `echo` repeats back what STT heard. It is the infrastructure check. |
| `TRANSPORT` | `sim`, `pstn` | `sim` runs the exact engine against scripted personas without dialling. |

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

- **Nothing has been exercised against live audio.** The STT and TTS clients are written against the published protocols and typecheck, but no key has been set, so the first real call is also the first test of them.
- `TEST_NUMBERS` currently holds an Indian number carried over from the old project. Replace it with the AU test numbers the organisers provide.
- The Energy field list and scripts in `energy.journey.json` are placeholders, pending the recording.
- The manual baseline for the efficiency counter is zero until it can be measured, rather than a number invented to make the comparison look good.
- 7 of the 10 eval personas need a live model; a dry run scores only the 3 rule-decided ones and says so.

## Node 20, and why Supabase nearly broke it

Node 20 is pinned because Node 22+ ships a global `WebSocket` that ignores the options argument, which silently drops the auth headers on the Scribe and ElevenLabs sockets.

`@supabase/realtime-js` has the opposite requirement: it throws outright when there is no native global `WebSocket`, and it is constructed eagerly inside `createClient`.
That killed the orchestrator on the first audit write.

The fix is to hand Supabase the `ws` package explicitly (`realtime: { transport: WebSocket }`), which is the same implementation every other socket here uses.
Upgrading to Node 22 would also satisfy Supabase and would reintroduce the header bug, so it is the wrong fix.

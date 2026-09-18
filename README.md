# recall

Outbound AI voice agent that calls a dropped-off Energy lead, picks the comparison journey up where the customer left it, collects the remaining fields by phone, submits a valid payload to CIMET's journey sandbox, and hands the call to a human with full context the moment the conversation turns.

Built on the `buildin-hours` codebase (Panchayat AI).
Telephony, the transport seam, the SSE board and the eval harness are reused; Sarvam is replaced end to end for latency.

## Status

Project setup is complete and verified.
The voice loop and the dialogue turn loop are the next build blocks and are deliberately unimplemented - they throw a named error rather than pretending to work.

| Area | State |
| --- | --- |
| Workspace, both apps, shared SSE contract | done |
| Journey config, zod schema, validation | done |
| Twilio + sim transports, barge-in, echo defence, warm transfer | done |
| Form state machine, normalisers, extraction, escalation detector | done |
| Guardrails: DNC, test-number, consent gate, card detection, decline | done |
| Sandbox mapping, incremental + final submit, mock server | done |
| Operator console, handoff console | done |
| Deepgram STT / ElevenLabs TTS sockets | build block P3 |
| Dialogue turn loop | build block 0:15-1:30 |

## Getting started

Node 20 is pinned deliberately.
Node 22 and above ship a global `WebSocket` that silently drops the options argument, which means auth headers vanish from vendor sockets - this project has already lost an evening to that once.

```bash
nvm use && corepack pnpm install
```

Copy the env template and fill in the voice keys:

```bash
cp .env.example .env
```

Twilio and Supabase credentials are already carried over.
`DEEPGRAM_API_KEY`, `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID` and `LLM_API_KEY` still need filling, along with `HANDOFF_NUMBER` for the warm-transfer demo.

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

**Confidence multiplies rather than averages.**
The extractor's own score is multiplied by the STT word confidence over the evidence span, so a confidently-extracted mishearing still fails the 0.85 floor and gets re-asked instead of written.

## Known gaps

- `TEST_NUMBERS` currently holds an Indian number carried over from the old project. Replace it with the AU test numbers the organisers provide.
- `@supabase/supabase-js` warns that Node 20 is deprecated. It is a warning, not a failure, and the Node 20 pin is the more important constraint.
- The manual baseline for the efficiency counter is hard-coded to zero until it can be measured from CIMET's recording.

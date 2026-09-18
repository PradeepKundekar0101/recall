# RECALL - session handoff

Written 19 Sep 2026, after the first successful live phone call.
Next task: **test the full Energy journey over a real call.**

## Where things stand

The voice loop works on a real phone.
Twilio to Scribe to ElevenLabs and back, mulaw 8 kHz end to end with no transcode anywhere.
A live echo call ran six turns, all transcribed and echoed, at **760-870 ms to first audio** - inside the 800 ms budget.

The full journey works in simulation against live models: a cooperative call submits to the sandbox in about 20 s with 13 of 15 fields captured hands-free.
All ten eval personas pass (gate is 9/10), though the suite is not fully deterministic - see Known flakiness.

**The journey has never been run over a real phone.** That is the next thing to do.

## Run it

Everything is already configured in `.env`; `TRANSPORT=pstn`, `MOCK_VOICE=0`, `CALL_MODE=journey`.

```bash
nvm use                      # Node 20 is pinned, see Gotchas
corepack pnpm twilio:check   # geo, tunnel, both handsets
corepack pnpm sandbox:mock   # mock CIMET sandbox on :4001
corepack pnpm dev:api        # orchestrator on :8080
corepack pnpm dev:web        # console on :3000
```

Then dial:

```bash
curl -s -X POST localhost:8080/calls -H 'content-type: application/json' -d '{"lead_id":"L-1042"}'
```

The response says `simulated: true` if nothing was actually dialled.
Trust that field rather than the 201.

| Command | What it proves |
| --- | --- |
| `pnpm twilio:check` | Account, geo permissions per country, tunnel websocket upgrade, handoff handset |
| `pnpm voice:check` | Synthesises a phrase and feeds it back through Scribe. Needs `MOCK_VOICE=0` |
| `pnpm llm:check` | Structured extraction and streaming, with warm latency medians |
| `pnpm normalise:check` | Dates, digits, emails, enums. Milliseconds, no network |
| `pnpm eval` | Ten simulator personas end to end |
| `pnpm voice:calibrate` | Confidence distribution, clean vs degraded |

## Gotchas that cost real time

Each of these was found the hard way.
Re-discovering them is expensive.

**Node 20 is pinned, and Supabase fights it.**
Node 22+ ships a global `WebSocket` that silently drops the options argument, which strips auth headers off the Scribe and ElevenLabs sockets.
But `@supabase/realtime-js` throws outright when there is *no* global WebSocket, and it is constructed eagerly inside `createClient`.
It is handed the `ws` package explicitly in `db/supabase.ts`.
Do not "fix" this by upgrading Node.

**Scribe rejects the whole socket over one bad keyterm.**
Any keyterm longer than 20 characters fails the connection with `invalid_request`, and the call then runs with no transcription at all - the agent greets the customer and hears nothing.
An email in the lead prefill caused exactly this.
`recognitionKeywords()` in `transports/twilio.ts` filters length and excludes values that are dictated rather than spoken.

**Scribe puts error detail in `error`, not `message`.**
Reading the wrong field turns a precise rejection into "no detail".

**`filter_background_audio` cannot be combined with `include_timestamps`.**
Timestamps win: the per-word logprobs are what LOW CONF is built on.

**`entity_detection` takes entity types or categories, not a boolean.**
It is set to `pci`, which covers card data for guardrail 3.

**Measure latency to first audio, not to the end of playback.**
Timing until `speak()` resolves includes however long the agent talked, which made an 800 ms loop look like 3 s.

**The model must not decide destructive outcomes.**
`intent: decline` and `intent: busy` from the LLM are ignored entirely - the model returned "decline" for an angry customer and for someone reading out a card number, and decline ends the call and writes a permanent opt-out.
Those paths run off explicit phrasings in `ruleIntent()`.

**Closed fields never reach the model.**
A yes/no or enum answer is matched in code, so those turns complete in single-digit milliseconds.
About a third of the journey's questions are closed.

**Digits are redacted for display only.**
The escalation detector sees the raw utterance; redacting first meant SENSITIVE could never fire on a card number.

**Speech is verbatim by default.**
Routing a read-back through the model produced "Yep, that's right mate." instead of the scripted line.
`speak()` only calls the model when explicitly asked to generate.

## Confidence is a weak signal here

Scribe reports per-word log probabilities, not a 0-1 score.
Raw probability is divided by a measured baseline in `voice/stt/scribe.ts` so that 1.0 means "as confident as this model gets on clean audio".

Measured on a real PSTN call, six correctly-transcribed turns scored **1.00, 0.55, 0.69, 0.85, 1.00, 1.00**.
Thresholds are deliberately permissive as a result (accept 0.35, LOW CONF 0.25).
Clean and degraded audio overlap, so confidence cannot reliably separate a good answer from a bad one - **read-back is the real gate**.

Six turns is a small sample.
Widen the thresholds further if rehearsal produces re-asks on answers that sounded fine.

## What to watch on the first full journey call

- Does the consent gate fire before any field is asked, and is the disclosure audible at the top.
- Do spelled fields survive a real line: email and postcode are the risky ones.
- Does the read-back speak a human date ("7th of March, 1989") rather than an ISO string.
- Does state get inferred from the postcode and the question skipped entirely.
- Do incremental section PUTs land - watch the mock sandbox log for `saved step`.
- Does the console fill live at `localhost:3000`.
- Echo: the agent hearing itself. On speakerphone this leaked through the token-overlap defence on one turn. Try a handset.

## Pending

**Blocking a full demo**

- The journey has never run over a real phone. Everything below assumes that happens first.
- Warm handoff `<Dial>` transfer is untested live. `HANDOFF_NUMBER` is a second handset now.
- The operator console has never been watched during a real call.

**Waiting on CIMET**

- Real field list drops into `journey/energy.journey.json`; update `sandbox/mapping.ts`. Nothing else should need to change.
- The recording gives script phrasing and the manual baseline for the efficiency counter, which is currently `manual_baseline_s: 0`.

**Known flakiness**

- The eval suite passes the 9/10 gate every run but is not deterministic; usually one persona fails, a different one each time, always the ANGER classifier firing on a benign turn.
- It has been tightened twice (pattern matches fire instantly, model-only judgements need a sustained signal). Watch it in rehearsal rather than assuming it is solved.

**Submission**

- Demo script in repo, deck, five rehearsals.
- `devtunnels.ms` URLs rotate when the tunnel restarts. Update `PUBLIC_BASE_URL` and re-run `pnpm twilio:check`, or the call connects and then sits in silence.

## Map

```
apps/orchestrator/src/
  journey/energy.journey.json   the single source of truth - sections, fields, scripts
  engine/dialogue.ts            the per-call loop: onTranscript -> extract -> decide -> speak
  engine/journey-state.ts       per-call state, transcript, review summary
  engine/fact-bus.ts            the form and its state machine
  engine/extract.ts             utterance to field patch
  engine/escalation.ts          six signals; five decided in code
  engine/normalise.ts           dates, digits, emails, enums - never the model
  voice/stt/scribe.ts           Scribe v2 Realtime; deepgram.ts is the fallback
  voice/tts.ts                  Flash v2.5, ulaw_8000, disk pre-render
  voice/llm/                    anthropic | openai | openrouter | gemini
  transports/twilio.ts          media stream, barge-in, echo defence, transfer
  calls.ts                      wires transport + engine to the SSE bus
apps/web/app/                   / operator console, /handoff human console
packages/shared/                the SSE event union both apps compile against
```

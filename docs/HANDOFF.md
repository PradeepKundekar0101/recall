# RECALL - session handoff

Written 19 Sep 2026, after the first successful live phone call.
Updated the same night, after the first and second journey calls over a real phone.
Next task: **run the Energy journey over a real call again, and let the handoff ring the second handset.**

## Where things stand

The voice loop works on a real phone.
Twilio to Scribe to ElevenLabs and back, mulaw 8 kHz end to end with no transcode anywhere.
A live echo call ran six turns, all transcribed and echoed, at **760-870 ms to first audio** - inside the 800 ms budget.

The full journey works in simulation against live models: a cooperative call submits to the sandbox in about 15 s with 11 of 15 fields captured hands-free.
That was 13 of 15 until a customer restating a prefilled value stopped counting as hands-free; the field came from the web journey, so it should not have.
All ten eval personas pass (gate is 9/10), though the suite is not fully deterministic - see Known flakiness.

**The journey has now been run over a real phone twice.**
The first call (3f927a21, 01:55 IST) failed on a line full of static and handed off with nothing captured.
The second (35fbec5a, 02:47 IST) ran cleanly through name, date of birth, account holder, phone and a corrected email, then fell over at the street address and "got cut" when the handoff fired.
Both calls are dissected below, and every defect they exposed is fixed and checked.
The warm transfer has still never rung the second handset; that is the next thing to see.

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
| `pnpm normalise:check` | Dates, digits, emails, enums, and how each value is read back. Milliseconds, no network |
| `pnpm dialogue:check` | The engine's turn logic against a fake line: prefilled values confirmed rather than asked, the second attempt heard before CONFUSION fires, nudges held while the customer talks. No vendors |
| `pnpm tts:check` | mulaw round-trip and loudness levelling. Milliseconds, no network |
| `pnpm transport:check` | The Twilio transport against a fake Twilio and a fake media stream: dial, handshake, transfer, and the hangup that must not follow it. Rings nothing |
| `pnpm eval` | Ten simulator personas end to end |
| `pnpm voice:calibrate` | Confidence distribution, clean vs degraded |
| `pnpm voice:replay <wav>` | A Twilio recording back through the live STT socket, paced like the media stream. Separates a bad line from a bad transcriber |

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

**Fourteen `tsx watch` orchestrators were alive at once.**
Every earlier `pnpm dev:api` left its watcher running after its port bind failed.
They all restart on any source edit and race for :8080, so the process serving the next call can be one started hours ago from a different shell, with that shell's environment.
Before a test: `pkill -f "tsx watch src/index.ts"`, start one, and confirm with `curl localhost:8080/health` that `boot` shows the mode and model you expect.

**The TTS model has to be one the voice is fine-tuned on.**
The Australian brand voice is a professional clone whose `eleven_flash_v2_5` fine-tune is `failed` on ElevenLabs' side, so v2.5 rendered it flat and synthetic on the first journey call.
`GET /v1/voices/{id}` shows `fine_tuning.state` per model; `TTS_MODEL` is now `eleven_flash_v2`, which is fine-tuned and within 30 ms of v2.5 to first audio.

**Digits are spaced where the value is known, not at the TTS layer.**
Spacing every digit run before synthesis turned the year in every date read-back into "1 9 8 9".
`speakableValue()` now spaces postcodes, NMIs and phone numbers and leaves dates alone.

**The transfer leg has its own guardrail, and the engine hangs up after it.**
`transfer()` used `assertTestNumber()`, so the handoff handset had to be a TEST_NUMBER - while `twilio:check` rightly insists it must not be, because a transfer to the phone already on the call connects nobody.
Every transfer was therefore refused, the fallback hung up, and the customer heard the call cut.
`assertHandoffNumber()` now allows the configured handset and refuses the customer's own number.
And `finalise()` calls `hangup()` after `transfer()`, which would complete the call before the Dial had rung anyone; the transport ignores a hangup once it has transferred.

**Never run a transport check without the injected client.**
The first draft of `transport:check` reached the real Twilio SDK and rang the test handset.
The check now injects a fake client and sets fake credentials before anything is imported.

## Confidence is a weak signal here

Scribe reports per-word log probabilities, not a 0-1 score.
Raw probability is divided by a measured baseline in `voice/stt/scribe.ts` so that 1.0 means "as confident as this model gets on clean audio".

Measured on a real PSTN call, six correctly-transcribed turns scored **1.00, 0.55, 0.69, 0.85, 1.00, 1.00**.
Thresholds are deliberately permissive as a result (accept 0.35, LOW CONF 0.25).
Clean and degraded audio overlap, so confidence cannot reliably separate a good answer from a bad one - **read-back is the real gate**.

Six turns is a small sample.
Widen the thresholds further if rehearsal produces re-asks on answers that sounded fine.

## The first journey call

What the customer heard: the opener, "Can I start with your full name?", "Sorry, I didn't catch that", "Sorry, are you still there?" twice, then the handoff line.
What the engine heard, at confidence 0.28, 0.21 and 0.30: "Uh, yeah, I'm done editing.", "Uh, 20 minutes.", "I just send the MD."

**The line was the first problem.**
Batch Scribe v2 over the Twilio recording, diarised, hears the customer as "Uh, yeah [static noise]", "Uh, [static noise]", "Pradeep [static noise]", "Oh, yes. I'm there. I'm there."
The echo call three minutes earlier on the same handset transcribed cleanly at confidence 1.0, so nothing in the code path separates a clean line from a static one.
Replaying the recording through the live STT socket (`pnpm voice:replay`) gives different garbage each run ("Uh, Jennifer.", "Pradeep Kumar."), with or without keyterms: the audio that reached Twilio was unintelligible, and no STT setting recovers that.
The recording is `RE11ae8a58...` on the Twilio account, 61 s; the echo call is `RE92e4bf94...`.
Next time use the handset rather than speaker, check signal, and watch the orchestrator log for `inbound audio stalled`, which the transport now prints for any hole over 250 ms in Twilio's frame cadence.

**The engine then made a bad line worse, three ways.**
All three are fixed and covered by `pnpm dialogue:check`.

- The name was prefilled on the lead and was still asked as an open question.
  A prefilled field is now confirmed with a yes/no read-back: `script.prefilled` in the journey, falling back to `confirm`, or to `ask` for a closed field whose question is already a yes/no.
  A one-word answer matched in code is what survives a bad line; the consent "yeah" got through on this call when the name did not.
- CONFUSION fired on the customer's second answer before that answer was looked at.
  The detector runs in parallel with extraction, and `attempts >= max_attempts` was already true when the reply to the re-ask arrived, so a second attempt could never succeed.
  The detector now only reports the count; `askField()` fires CONFUSION when a field would have to be asked once more than `max_attempts` allows.
- "Sorry, are you still there?" was armed off the agent's line alone.
  Every partial transcript now restarts the silence clock, so an email spelled out over ten seconds is not talked over.

**The voice.**
Measured from here over six short lines, median time to first audio: flash v2.5 475 ms, flash v2 501 ms, turbo v2.5 526 ms, turbo v2 851 ms.
Turbo v2 is the richer fine-tuned option if 350 ms more on dynamic lines is acceptable; pre-rendered lines never pay it.
To compare by ear, run `TTS_MODEL=<model> pnpm voice:check` and play `.voice-check/tts.ulaw`.

ElevenLabs levels each request on its own: across the pre-rendered lines, "Okay." sat 10 dB above the consent line that follows it.
`synthesize()` now brings every utterance to one RMS target (`TARGET_RMS` in `voice/tts.ts`) under a peak ceiling, and the cache key carries the target so old renders are not served.

## The second journey call

Same handset, ten minutes after the engine fixes above, on a clean line: customer confidences 0.6 to 1.0.
Name, date of birth, account holder and phone each closed on one word, and "no, it's healthcare101@gmail.com" corrected the prefilled email.
Then the street address, and four more things went wrong, each now fixed and checked:

- **The corrected email was written into the form as "it'sthehealthcare101@gmail.com", with no read-back.**
  Two defects: the email normaliser joined the preamble into the address, and a value given in answer to a read-back was confirmed on the spot.
  `normaliseEmail()` now strips the preamble ("uh, no, it's the") and trailing punctuation, and a value heard by voice is read back before it counts, however it arrived.
  Saying the same value back instead of "yes" still counts as a yes; only a different value gets the second read-back.
  The cooperative persona now asserts both.
- **"Uh, can you repeat it again?" was scored as a failed answer.**
  It consumed one of the two attempts, was re-asked with "Sorry, could you give me that street address again?", and the anger classifier rated it -1.
  `ruleIntent()` now returns `repeat`, and the engine says the last question again, word for word, before the model or the detector see the turn.
- **A pause mid-sentence committed "Uh, it's-" as the whole answer.**
  Scribe's VAD floor is half a second; the address arrived 1.2 s later, after the handoff had fired.
  A commit that ends in Scribe's cut-off dash, or on a word nothing ends on ("no, it's the"), is now held for `FRAGMENT_HOLD_MS` (2500) and joined to what follows.
- **The handoff itself cut the call.**
  The transfer was refused by guardrail 1 (see Gotchas), the bridging line was talked over by the customer still finishing their address, and the fallback hung up.
  The bridge line is now uninterruptible, the transfer is allowed, and the engine's hangup after a transfer is ignored.

Also fixed from this call: a bare "Okay." to a confirmation no longer goes to the model, so the "Okay." / "Right." / next-question rhythm is gone from prefilled confirmations.

## What to watch on the next journey call

- Does the consent gate fire before any field is asked, and is the disclosure audible at the top.
- Do spelled fields survive a real line: email and postcode are the risky ones.
- Does the read-back speak a human date ("7th of March, 1989") rather than an ISO string.
- Does state get inferred from the postcode and the question skipped entirely.
- Do incremental section PUTs land - watch the mock sandbox log for `saved step`.
- Does the console fill live at `localhost:3000`.
- Echo: the agent hearing itself. On speakerphone this leaked through the token-overlap defence on one turn. Try a handset.
- Do the prefilled fields land as one yes each: name, date of birth, phone and email should all be confirmations now.
- Does `inbound audio stalled` appear in the orchestrator log. If it does, the tunnel is the next suspect, not Scribe.
- Do the customer's confidences look like the echo call (0.5 to 1.0) or like the first journey call (0.2 to 0.3). The second means the line, and the fix is the handset, not the code.

## Pending

**Blocking a full demo**

- The journey has run over a real phone once and failed on the line. It has not yet completed over a real phone; everything below assumes that happens first.
- Warm handoff `<Dial>` transfer has still never rung the second handset live. It was refused by guardrail 1 on the second call; both that and the hangup that would have followed are fixed and covered by `pnpm transport:check`, but nobody has yet heard the whisper.
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
  voice/tts.ts                  TTS on the voice's fine-tuned model, loudness levelling, ulaw_8000, disk pre-render
  voice/llm/                    anthropic | openai | openrouter | gemini
  transports/twilio.ts          media stream, barge-in, echo defence, transfer
  calls.ts                      wires transport + engine to the SSE bus
apps/web/app/                   / operator console, /handoff human console
packages/shared/                the SSE event union both apps compile against
```

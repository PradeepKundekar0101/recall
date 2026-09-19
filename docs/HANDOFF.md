# RECALL - session handoff

Written 19 Sep 2026, after the first successful live phone call.
Updated the same night, after the first and second journey calls over a real phone, and again the next morning after the third and fourth.
Next task: **run the Energy journey over a real call again, and let the handoff ring the second handset.**

## Where things stand

The voice loop works on a real phone.
Twilio to Scribe to ElevenLabs and back, mulaw 8 kHz end to end with no transcode anywhere.
A live echo call ran six turns, all transcribed and echoed, at **760-870 ms to first audio** - inside the 800 ms budget.

The full journey works in simulation against live models: a cooperative call submits to the sandbox in about 15 s with 11 of 15 fields captured hands-free.
That was 13 of 15 until a customer restating a prefilled value stopped counting as hands-free; the field came from the web journey, so it should not have.
All ten eval personas pass (gate is 9/10), though the suite is not fully deterministic - see Known flakiness.

**The journey has now been run over a real phone four times.**
The first call (3f927a21, 01:55 IST) failed on a line full of static and handed off with nothing captured.
The second (35fbec5a, 02:47 IST) ran cleanly through name, date of birth, account holder, phone and a corrected email, then fell over at the street address and "got cut" when the handoff fired.
The third and fourth (07:50 and 07:52 IST) were both cut about eight seconds in by Twilio's answering-machine detection, mid-answer.
All four are dissected below, and every defect they exposed is fixed and checked.
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
The console reaches the same endpoint in three steps: pick the customer, seed or clear each field and write the agent a brief, then Dial.
The body may also carry `prefill` (a value seeds a field so it is confirmed in one line, `null` removes it so it is asked) and `agent_brief` (how the agent should talk; it shapes generated lines only, never the scripts).
Both are parsed in `leads/setup.ts` and refused whole on any bad value, and neither can touch the number that is dialled.

| Command | What it proves |
| --- | --- |
| `pnpm twilio:check` | Account, geo permissions per country, tunnel websocket upgrade, handoff handset |
| `pnpm voice:check` | Synthesises a phrase and feeds it back through Scribe. Needs `MOCK_VOICE=0` |
| `pnpm llm:check` | Structured extraction and streaming, with warm latency medians |
| `pnpm normalise:check` | Dates, digits, emails, enums, and how each value is read back. Milliseconds, no network |
| `pnpm dialogue:check` | The engine's turn logic against a fake line: prefilled values confirmed rather than asked, the second attempt heard before CONFUSION fires, nudges held while the customer talks, a yes said over the previous line not confirming the next, two finals a breath apart asking once, a question that was talked over asked again, and a reply queued behind the filler rather than on top of it. No vendors |
| `pnpm setup:check` | What the console sends before a dial: seeds and removals folded into the lead, bad fields and briefs refused whole, the dial target untouched, and the brief fenced inside the voice prompt. Milliseconds, no network |
| `pnpm tts:check` | mulaw round-trip and loudness levelling. Milliseconds, no network |
| `pnpm transport:check` | The Twilio transport against a fake Twilio and a fake media stream: dial, handshake, transfer, the hangup that must not follow it, the answering-machine verdict that must not end a live call, talking over the agent - a backchannel that must not stop the line, a turn-taker that must, and what was heard when it did - and two lines handed over at once, which must not overlap. Rings nothing |
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

**That pileup is what makes the console dial nothing, and the console used to hide it.**
`TRANSPORT` and `MOCK_VOICE` exported in a shell outrank `.env` by design, so a watcher started once from a shell carrying `TRANSPORT=sim MOCK_VOICE=1` serves every later dial from the simulator no matter what `.env` says.
Seventeen orchestrators were alive at once and two of them held exactly that; whichever owned :8080 decided whether the phone rang.
The symptom from the operator's chair is a full, convincing journey transcript appearing the instant Dial is pressed while no handset rings.
Two things give it away: every customer turn scores exactly 95%, which is `SimTransport`'s default confidence, and the whole conversation - opener, consent, a re-ask and a six-second silence nudge - spans six seconds of wall clock, which no spoken call can do.
`POST /calls` has always returned `simulated: true` for this, but the console threw the field away; it now shows `SIMULATED - NO PHONE DIALLED` in place of the TEST RUN chip and says so in the notice bar.

**The console 404s on every route when file descriptors run out.**
Next's dev watcher takes one descriptor per watched directory, and a GUI-launched process gets 256 of them (`launchctl limit maxfiles`).
With the pnpm store walked and a pile of orchestrator watchers already holding thousands, watchpack raises `EMFILE: too many open files`, the app directory scan comes back empty, and every route 404s - while the root layout still renders, so the tab title is right and the page is not.
`next build` succeeds throughout, which is what makes it read as a code problem when it is a descriptor problem.
`apps/web` now raises its own limit in the `dev` script and `next.config.mjs` keeps the watcher out of `node_modules`; if it returns, the log line to look for is `EMFILE`, not anything about routing.

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

**Twilio's answering-machine detection hangs up on live customers.**
`machineDetection: "Enable"` with `asyncAmd` posts a verdict while the call is already in progress, and the webhook used to end the call on `machine_start`.
Detection runs on the called leg for up to `machine_detection_timeout` *while our own opener is playing into it*, and anything continuous past Twilio's 2400 ms speech threshold reads as a machine greeting - the customer talking over a long opener, or that opener leaking back off their handset.
Two calls in one session died this way, both at 5.4-6.2 s of detection, mid-conversation.
`notifyAmd()` now records the verdict and never acts on it; a voicemail is closed by the silence nudges and the abandon timer instead, about twenty seconds in.
Covered by `pnpm transport:check`.

**Two transcripts a breath apart ran through the engine at once.**
`handleTurn()` guarded itself with a boolean, and a second final only cancelled the first turn's TTS; the first turn kept going through `extract()` and `decide()`.
Both turns reached `askNext()` for the same field, so the same question played twice, and a "yeah, go ahead" said over "Great, thanks" was taken as the yes to the name read-back that the first turn asked a moment later.
Turns now queue and run one at a time (`enqueue()` / `drain()` in `engine/dialogue.ts`), and the opener runs under the same lock.

**A "yes" belongs to the line it was said over, not to whichever line is current when it commits.**
The transport now reports when each utterance began (`UtteranceMeta.startedAt`, the first partial with words), and the engine compares it with when the current question became audible.
An utterance that started before the question could be heard - `ANSWER_REACTION_MS` (400) after first audio, covering Scribe's partial latency plus a human reaction - cannot answer, confirm or fail that question, and never moves the journey past it.
A bare yes or no in that position is logged and ignored; anything longer still goes to the extractor for whatever it volunteered.
The sim transport passes no timing, so nothing predates anything in `pnpm eval`.

**A question the customer talked over was never asked.**
`transport.speak()` now resolves with `{ completed, heard }`: whether the line played to the end and, if not, the sentences that had finished when it was cut.
The transcript keeps what was heard (marked with Scribe's trailing dash) rather than the scripted line, and drops the line if nothing was.
Once the interruption has been handled - "am I talking to a robot?", a repeat, an ignored late yes - the engine asks the cut question again, word for word, at no cost to the attempt count.
The handoff bridge is still uninterruptible.

**Two words are a customer agreeing along, not taking the turn.**
Barge-in fired on any two tokens, so "yeah okay" over a read-back cleared playback and the read-back was never finished.
`takesTurn()` in `transports/twilio.ts` needs three words, or one of the turn-taking words ("wait", "sorry", "hang on", "no", "what"...).
Backchannels still reach the engine as utterances; they just do not stop the line.
All four of the above are covered by `pnpm dialogue:check` and `pnpm transport:check`.

**Two lines could be on the wire at once, and the filler put them there.**
`armFiller()` fires `transport.speak()` without waiting for it, by design - the turn continues underneath it - so a reply that landed while "Okay." was still playing went out on top of it.
The audio is the obvious half.
The quiet half is that `speaking`, `lastSpokenTokens` and the mark resolvers all describe *one* utterance: the filler's mark cleared `speaking` while the reply was still on the wire, so barge-in was off for the rest of that reply and the reply reported itself as cut when it had been heard whole.
Both layers now serialise.
The engine queues every line it speaks, fillers included, because it is what decides the order; the transport queues too, because callers are not trusted to and it owns the wire.
A filler that is no longer needed by the time the wire is free is dropped rather than played late, so serialising does not cost a turn the 400 ms it was meant to hide.
`createEngine()` takes an injectable extractor, which is what lets `dialogue:check` slow extraction down enough for the filler to be due; `transport:check` drives two lines onto one wire directly.

**Editing orchestrator source kills the call that is on the line.**
`tsx watch` restarts on any file under `apps/orchestrator/src`, and a call lives entirely inside that process: transport, engine, silence timers, all of it.
The restart is silent from the operator's chair.
The row stays `live`, the console keeps showing `live`, the customer's next answer reaches nobody, and Twilio drops the leg a few seconds later when the media stream's peer disappears.
Call `39ad03d0` died exactly this way on 19 Sep at 11:15 IST: the last thing on the record is the agent reading the date of birth back, the answer to it was never heard, and the row was still `live` half an hour later.
Creating or deleting a scratch file in that tree counts, so do neither during a rehearsal call.
Boot now closes any row left open as `disconnected` - after the port bind succeeds, so a second orchestrator that loses the bind cannot close the first one's calls.

**A console with no event stream must not report a live call.**
`useCallStream` has always known whether the stream is up, and the status stat ignored it, so a call the console could no longer see still read `live`.
It says `no stream` now, once the stream has opened at least once and then dropped, and corrects itself on reconnect because the whole call replays.
Not yet committed: it is interleaved with the console's setup-flow work.

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

## The third journey call

Two calls, 07:50 and 07:52 IST, both cut about eight seconds in.
What the customer heard: the opener naming them, their own answer going through - the transcript is on the record - and then the line dropping.

Twilio's own call log has the whole sequence.
On `CAf5883512` the call was answered at 02:20:22 UTC, the async AMD verdict `machine_start` arrived at 02:20:28, and the orchestrator POSTed `status=completed` at 02:20:29.
On `CA4fdd84ec` the same three events land at 02:20:50, 02:20:54 and 02:20:54.
`machine_detection_duration` was 6139 ms and 6158 ms: AMD spent six seconds listening to a conversation and called it an answering machine.
The one call in that session AMD scored `human` (`CA424bb22d`, verdict at 5399 ms) ran 46 s and ended normally.

The chain was `/twilio/amd/:callId` -> `notifyVoicemail()` -> `end("voicemail")` -> the engine finalising as `no_answer` -> `hangup()`, which is the `status=completed` in the log one second behind every verdict.
AMD is advisory now - see Gotchas.
The other short calls in that session show no AMD hangup and no orchestrator update; they look like redials and hangups from this end, so watch for them separately if a call still cuts.

## What to watch on the next journey call

- Does the consent gate fire before any field is asked, and is the disclosure audible at the top.
- Do spelled fields survive a real line: email and postcode are the risky ones.
- Does the read-back speak a human date ("7th of March, 1989") rather than an ISO string.
- Does state get inferred from the postcode and the question skipped entirely.
- Do incremental section PUTs land - watch the mock sandbox log for `saved step`.
- Does the console fill live at `localhost:3000`.
- Echo: the agent hearing itself. On speakerphone this leaked through the token-overlap defence on one turn. Try a handset.
- Do the prefilled fields land as one yes each: name, date of birth, phone and email should all be confirmations now.
- Does `AMD: machine_start - advisory only, the call continues` appear in the log, and does the call carry on regardless.
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

**Known limitations found while debugging**

- `normalise` reads "1st sep 2002", "the 1st of September 2002" and "No it's 1st sep 2002" into `2002-09-01`, with a read-back, so correcting a date by voice works. It cannot read a year spelled out in words ("two thousand and two"), which returns `could not read a date` and costs an attempt.

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
  transports/twilio.ts          media stream, barge-in (takesTurn), echo defence, transfer
  calls.ts                      wires transport + engine to the SSE bus
apps/web/app/                   / operator console, /handoff human console
packages/shared/                the SSE event union both apps compile against
```

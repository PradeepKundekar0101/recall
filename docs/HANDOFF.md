# RECALL - session handoff

Written 19 Sep 2026, after the first successful live phone call.
Updated the same night, after the first and second journey calls over a real phone, and again the next morning after the third and fourth, and again after the fifth, sixth and seventh.
Updated again after rehearsal found the agent accepting answers the customer never gave, and after the eighth call escalated a customer for correcting his year of birth.
Next task: **run the Energy journey over a real call again, deliberately on speakerphone, and get a clean submit.**
Read **The eighth journey call** first - guardrail 3 was firing on ordinary answers, which is the shortest path from a working demo to a dead one.
Then **The agent answering itself**: that failure is acoustic echo, it is now gated rather than hoped about, and two of the numbers that govern it want retuning against a real speakerphone.
Then read **The three-minute cut**: the extra fields are seeded rather than asked now, the saves changed shape, and the section intros are finally spoken.
The sixth call is the one to read first: the warm transfer rang the second handset, the human answered, and the two of them talked for 87 seconds.

## Where things stand

The voice loop works on a real phone.
Twilio to Scribe to ElevenLabs and back, mulaw 8 kHz end to end with no transcode anywhere.
A live echo call ran six turns, all transcribed and echoed, at **760-870 ms to first audio** - inside the 800 ms budget.

The full journey works in simulation against live models: a cooperative call submits to the sandbox in about 15 s with 11 of 15 fields captured hands-free.
That was 13 of 15 until a customer restating a prefilled value stopped counting as hands-free; the field came from the web journey, so it should not have.
All ten eval personas pass (gate is 9/10), though the suite is not fully deterministic - see Known flakiness.

**The journey has now been run over a real phone seven times.**
The first call (3f927a21, 01:55 IST) failed on a line full of static and handed off with nothing captured.
The second (35fbec5a, 02:47 IST) ran cleanly through name, date of birth, account holder, phone and a corrected email, then fell over at the street address and "got cut" when the handoff fired.
The third and fourth (07:50 and 07:52 IST) were both cut about eight seconds in by Twilio's answering-machine detection, mid-answer.
The fifth (bd82d644, 11:27 IST) got as far as the warm handoff and then cut the customer off one second into it, after asking the same question twice and escalating on a customer who had answered.
The sixth (11af167e, 12:07 IST) handed off and **the second handset rang, was answered, and stayed bridged to the customer for 87 seconds** - the first time that has ever happened.
The seventh (aead90d7, 12:17 IST) escalated on a customer who had confirmed their date of birth, and then dropped them because the human did not pick up.
All seven are dissected below, and every defect they exposed is fixed and checked.

## Run it

Everything is already configured in `.env`; `TRANSPORT=pstn`, `MOCK_VOICE=0`, `CALL_MODE=journey`.

```bash
nvm use                      # Node 20 is pinned, see Gotchas
corepack pnpm twilio:check   # geo, tunnel, both handsets
corepack pnpm dev:api        # orchestrator on :8080, mock CRM mounted at /mock-crm
corepack pnpm dev:web        # console on :3000
```

The boot report prints `monitor ws://localhost:8080/monitor`.
That is the agent's own voice, live, for the **Monitor** toggle in the console's transcript pane - or for `ffplay` if `MONITOR_CMD=ffplay` is set.
Agent audio only; the customer is never on it.

`pnpm sandbox:mock` is no longer part of the run.
The mock CRM is mounted inside the orchestrator, so there is one process to start rather than two - one fewer thing to be down when the room is watching.
The boot report prints where saves are going; `saves http://localhost:8080/mock-crm (mounted here)` is what it should say.

Then dial:

```bash
curl -s -X POST localhost:8080/calls -H 'content-type: application/json' -d '{"lead_id":"L-1042"}'
```

The response says `simulated: true` if nothing was actually dialled.
Trust that field rather than the 201.
The console reaches the same endpoint in three steps: pick the customer, seed or clear each field and write the agent a brief, then Dial.
The body may also carry `prefill` (a value seeds a field so it is confirmed in one line, `null` removes it so it is asked) and `agent_brief` (how the agent should talk; it shapes generated lines only, never the scripts).
Both are parsed in `leads/setup.ts` and refused whole on any bad value, and neither can touch the number that is dialled.
Every call has its own page at `/calls/<call id>`; Dial lands there, and so does opening a call from `/calls`, the history.
`GET /calls` lists every call the audit table and the orchestrator's own buffer know about, and `GET /calls/:id/events` replays a finished call out of `call_events` when this process never ran it, closing the stream after the final status.
`GET /calls/:id/recording` streams the Twilio audio through with the account's credentials; Twilio's recording callback used to reach a transport that had already gone, so the url is now kept in the audit row and announced as a `call.recording` event, and the transcript pane shows a player once it lands.
The engine announces every prefilled field before the opener; until it did, the board showed the lead's own prefill - and anything seeded - as empty until confirmed.

| Command | What it proves |
| --- | --- |
| `pnpm twilio:check` | Account, geo permissions per country, tunnel websocket upgrade, handoff handset |
| `pnpm voice:check` | Synthesises a phrase and feeds it back through Scribe. Needs `MOCK_VOICE=0` |
| `pnpm llm:check` | Structured extraction and streaming, with warm latency medians |
| `pnpm normalise:check` | Dates, digits, emails, enums, and how each value is read back. Milliseconds, no network |
| `pnpm dialogue:check` | The engine's turn logic against a fake line: prefilled values confirmed rather than asked, the second attempt heard before CONFUSION fires, nudges held while the customer talks, a yes said over the previous line not confirming the next, two finals a breath apart asking once, a question that was talked over asked again, a reply queued behind the filler rather than on top of it, a field the form has no value for asked outright rather than confirmed at nothing, and a yes outranking the model's guess at intent. Also the echo gate: our own line coming back confirming nothing, a backchannel and a too-brief clip dropped, a real interruption still taking the floor, a one-word yes never gated, a bad line with the agent quiet still re-asked, and the tail-against-silence-window arithmetic. No vendors |
| `pnpm escalation:check` | The signals that end a call, against the turns that must not end one: a corrected year, a date beside a postcode, a phone number and a ten-digit NMI are all answers; a card spaced, unspaced, hyphenated, half-read or merely named is a card; and the evidence that reaches the console carries no digits. Milliseconds, no network |
| `pnpm setup:check` | What the console sends before a dial: seeds and removals folded into the lead, bad fields and briefs refused whole, the dial target untouched, the brief fenced inside the voice prompt, and every fixture carrying the number it will be rung on. Milliseconds, no network |
| `pnpm tts:check` | mulaw round-trip and loudness levelling. Milliseconds, no network |
| `pnpm transport:check` | The Twilio transport against a fake Twilio and a fake media stream that plays audio at the speed audio plays: dial, handshake, transfer, the hangup that must not follow it, the answering-machine verdict that must not end a live call, talking over the agent - a backchannel that must not stop the line, a turn-taker that must, and what was heard when it did - two lines handed over at once, which must not overlap, the media stream torn down by the redirect, which must not be read as the customer hanging up, what the customer has actually heard by mark rather than by guess, played text truncated to the last acknowledged mark on a barge-in, and the local monitor's framing and per-call routing. Rings nothing |
| `pnpm eval` | Ten simulator personas end to end. The per-field saves run for real against whatever `SANDBOX_URL` points at, so start the orchestrator first or the log fills with refused connections |
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

**Redirecting a call tears its media stream down, and that is not the customer hanging up.**
The `<Connect><Stream>` ends the moment the `<Dial>` redirect is applied, which is while the REST update is still in flight.
Anything that reads that teardown as a hangup will finalise the call and complete the leg that is ringing the human, one second after the transfer.
Read the fifth journey call before touching `transfer()`.
The other half of the same rule: closing our end of the socket is itself a way to end a `<Connect>` call, so once the call has been handed over the teardown is Twilio's to do, not ours.

**A closed field's ask can be a confirmation, and then it is useless without a value.**
"Is this number the best one to reach you on?" is the whole question for `phone`, and a yes only means something if the form is already holding a number.
Two of the three lead fixtures carried none, and the console can clear any field deliberately, so both states have to work: `prefilled` carries the confirmation, `ask` has to stand on its own.
The journey schema now refuses a closed field that is not bool or enum and has no `prefilled` script, so this cannot come back in JSON.

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

**A guardrail that fires wrongly is not a safe failure.**
Guardrail 3 read any eight digits anywhere in a sentence as a card number, so correcting a year of birth - "it's 1987, not 8-- 1986" - ended call 17552735 with nothing captured.
Digits only count together now if they were dictated together, and the bar is twelve rather than eight; see **The eighth journey call**.
The general lesson is the one that keeps being relearned here: the detectors that end calls need tests more than the paths that continue them, because a false positive on this side is silent, expensive and indistinguishable from a decision.

**A mark is the only evidence that anything was heard.**
Writing a frame to Twilio says nothing about playback: the buffer takes a whole reply in milliseconds and plays it over seconds.
Everything that asks "is our voice in the customer's room right now" - the half-duplex gate, what a cut line reports as heard - reads `playout()`, which is driven entirely by marks coming back.
If you add another path that writes audio, give it per-sentence marks through `sendSentence()` or the gate goes blind on those lines.
`pnpm transport:check` models a playhead rather than acknowledging marks on a timer, which is what makes that checkable at all; a fake that acks on a timer passes every one of those checks with the bug in.

**Pre-rendered lines were never actually being served.**
`synthesize()` gated the cache *lookup* on `cacheable`, which only `prerender()` passes - so the call path, which passes no options, consulted nothing and every pre-rendered line paid a full ElevenLabs round trip anyway.
Boot was spending the quota and the call was spending the latency, on the opener that has to land the instant the customer picks up.
Reading the cache is unconditional now; writing to it still is not, so a dynamic reply still never touches the disk.

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

## The fifth journey call

Call `bd82d644`, 19 Sep 11:27 IST, 78 seconds, lead L-1043 (Daniel).
The best call so far and the worst ending: consent, name, date of birth and account holder all closed on one word each, and then the contact section asked the same question twice, escalated a customer who had answered it, and cut them off on the way to the human.

What the customer heard, from 58:28:

```
Agent     Is this number the best one to reach you on?
Daniel    Yeah.
Agent     Is this number the best one to reach you on?
Daniel    Oh, yes, it is.
Agent     Got it.
Agent     I'm going to get a colleague to help you with this - one moment, they'll have everything you've told me so far.
                                                      (line dead, one second later)
```

Three separate defects, each fixed and checked.

**The number was never in the form, and the question was phrased as though it were.**
`phone` is a closed field whose script is a confirmation: "is this number the best one to reach you on?".
That only works when the form already holds a number, and the engine only treats it as a confirmation when it does - otherwise it speaks the same line as an ordinary question.
L-1043 carried no phone in its prefill, so the customer was asked to confirm nothing, and no answer could ever fill the field: a yes carries no number, and the closed-field shortcut in `decide()` only reads bool and enum.
Every answer failed, the attempts ran past `max_attempts`, and `askField()` fired CONFUSION.
The number was never in doubt: it is the one we had just dialled.
`loadLeads()` now seeds `prefill.phone` with it for every lead rather than only for fixtures that happened to carry the key, and `phone` and `plan_id` have been split into an open `ask` and a `prefilled` confirmation, so a field the operator clears is asked for outright.
The schema check now refuses any closed field that is not bool or enum and has no `prefilled` script, because that field can only ever be closed by confirming a known value.
Worth knowing: the eval suite always runs against `loadLeads()[0]`, which is L-1042, and L-1042 is the one fixture that did carry a phone.
That is why ten passing personas never saw this.

**"Yeah." was eaten by the read-back before it.**
A prefilled closed field - the account holder question - is confirmed by the yes/no shortcut in `decide()`, which returns before the branch that clears `awaitingConfirm`.
So the field stayed pending, and the next answer was read as a late yes to it rather than an answer to the question actually on the line.
The record shows it plainly: at 58:33.700 `account_holder` is re-emitted as confirmed with its old evidence ("Mm, yes.") a whole turn after it was confirmed, and the phone question is asked again in the same millisecond.
It only ever showed up when the following field was not prefilled too, because a prefilled one overwrote `awaitingConfirm` on its way past.
`askField()` now clears it whenever it puts a new question on the line.

**A yes to a read-back could be overruled by the model's guess at intent.**
Found while running the fixed journey end to end, not on the call itself.
Asked the phone question, a customer said "Yes, that's the one." - one character past the 20 the code uses to decide a yes without the model - so it went to the extractor, which returned no patch and `intent: question`.
The engine deflected it as an advice question and handed off a customer who had just agreed.
`decide()` already only trusts the model's intent when the turn produced nothing; a yes or no to a read-back, to the consent question or at the review gate is not nothing, and now counts as an answer before the switch sees it.
The same guess landing on "no" would have ended the call.

**Then the handoff cut the customer off.**
Twilio's log again, on `CA68ef69e5`:
the `<Dial>` redirect went out at 05:58:51 UTC, and our own `status=completed` on the customer's leg followed at 05:58:52.
The handoff handset's leg, `CA8b93b996`, is on the record at `no-answer` after 0 seconds - the Dial cancelled by its parent hanging up.
The recorded outcome is `disconnected`, not `handoff`, and that is what proves the ordering.

Redirecting a call ends the `<Connect><Stream>` it is running, so Twilio tears the media stream down *while the update is still in flight*.
`transfer()` set `this.transferred` only after the update returned, so the teardown arrived first and came back as an ordinary `hangup`: the engine finalised as `disconnected`, `finalise()` called `hangup()`, and `hangup()` completed the very leg that was ringing the human.
The `if (this.transferred) return` guard added after the second call was correct and simply came too late to help.
The intent to transfer is now recorded before the redirect goes out and reset only if it throws, a teardown after that point ends the call as `transferred`, and `end()` no longer closes the socket itself once transferred - closing our end of a `<Connect><Stream>` is its own way to end a call.
`pnpm transport:check` now drives a redirect that tears the stream down the way the real one does, and asserts that no `status=completed` ever follows it.

This is fixed against Twilio's own record of what went wrong, not against a guess, but nobody has yet heard the whisper on the second handset.
That rehearsal is still the next thing to do.

## The sixth and seventh journey calls

**The sixth (`11af167e`, 06:37 UTC) is the one worth celebrating.**
It escalated for CONFUSION like the fifth, and then the handoff did exactly what it was built to do.
Twilio's log: the customer's leg `CA2ac10229` ran 06:37:35 to 06:40:24, and the handoff handset's leg `CA5f3bce98` ran 06:38:57 to 06:40:24 - **87 seconds, status completed**.
The human answered, the whisper played to them alone, and the two legs ended together when the call was over.
The oldest item on this list is closed: the warm transfer works on a real phone, with a real second handset.

**The seventh (`aead90d7`, 06:47 UTC) escalated a customer who had confirmed, and then dropped them.**
What the customer heard, from 48:16:

```
Priya    Uh, no. Uh, it's 1st of September, 2002.      (0.90, captured correctly)
Agent    So that's the 1st of September, 2002?
Priya    "Thank you."                                   (0.50 - the recording has "Right.")
Agent    Sorry, could you give me your date of birth again?
Priya    (starting to answer again)
Agent    I'm going to get a colleague to help you with this...
                                                        (line dead nine seconds later)
```

The recording settles what was actually said.
Batch Scribe over `RE274c76eb`, diarised, has the customer saying **"Right."** at 49.3 s and, after the re-ask, "Uh-" and then "It's first of September, two thousand and two" at 56.5 s - which arrived as the handoff was already firing.
They answered correctly, confirmed correctly, and were handed to a human for it.

Two defects, both fixed.

**"Right." was not agreement.**
The yes pattern carried "alright", "all right" and "that's right", and "ok", "okay", "fine" and "sure" beside them, but not bare "right".
It does now.
Note what that costs to rely on, though: the live transcript rendered the word as "Thank you." at 0.50 confidence, so recognising more words is not a substitute for surviving a bad one - which is the second defect.

**A read-back nobody answered threw the value away.**
Neither a yes, a no, nor a value did exactly what a "no" does: clear the field and ask for it again, charging an attempt.
So a date captured at 0.90 was binned over one garbled reply to the confirmation, and the attempt that cost put the field one miss from CONFUSION.
A read-back is now said again once, behind "Sorry, I didn't catch that.", at no cost to the attempts; only a second miss gives up on the value and asks outright.
A "no" still clears it immediately, because a no is an answer.
This only applies to a reply too short to have been anything but a yes or a no - three words, the same boundary the transport uses for turn-taking.
Four words at a read-back is a correction we failed to make out, and the mumbler persona in `pnpm eval` is what holds that line: it answers an email read-back with "mmf shrrm at gmnl" and must still reach a human.
Making the engine more patient broke that persona before the word count went in, which is exactly what it is there for.

**Then the human did not pick up, and the customer was dropped in silence.**
The child leg `CA414c1085` shows `no-answer` after 1 second, and the customer's leg completed in the same second.
This is not the fifth call's bug coming back: Twilio's event log for `CA0d7dea` has only two updates from us, the original create and the `<Dial>` redirect, and no `status=completed` at all.
The `<Dial>` is simply the last verb in the document, so when it ended the call fell off the end of its TwiML and Twilio hung it up.
From the customer's chair: "I'm going to get a colleague to help you", a pause, and then nothing.
Fixed by giving the `<Dial>` an `action` URL. `/twilio/handoff-result/:callId` answers it: `completed` means the human took the call and there is nothing left to say, and anything else gets an honest sentence - "I couldn't reach a colleague just now, someone will call you straight back" - before the line goes down. The escalation packet is already on the human console with the transcript, which is what that sentence is promising. What is *not* built is taking a callback time by voice: the media stream is gone and the engine has finalised by then.

## How a yes is decided

Code first, model second, and the two directions are not equally safe.

The common words resolve in `normaliseBool` in single-digit milliseconds, which is what a third of the journey's questions need and what survives a bad line.
That list will never be finished, though.
"Right." only got into it because call `aead90d7` lost a date of birth to it, and gotcha, spot on, bang on and you got it were all waiting behind.

So anything the list cannot place is handed to the model - which was **already being called on exactly those turns**, because anything the code cannot resolve goes to the extractor.
It was simply never asked the question that mattered; it was asked for field values.
It now gets the read-back in front of it and answers yes, no or unclear.
There is no extra round trip and no extra latency on the common path.

A wrong "no" costs a turn and a re-ask.
A wrong "yes" writes a value the customer may have been objecting to into an energy signup.
So a "no" is taken as it comes, and a "yes" only counts for a reply short enough to have been one, with no digits in it.

Measured against the live model on a date-of-birth read-back: yes to "bang on, mate", "gotcha", "you got it", "mm", "aye"; no to "nah that's not me"; unclear to "sorry, what?" and "well that depends on which one you mean".
It also answers yes to "can you repeat that?" - which never reaches this code, because `ruleIntent` decides a repeat before the model is consulted.
That layering is what makes the guard affordable, and it is worth not disturbing.

Two traps the word list itself had, both now covered by `pnpm normalise:check`:
"no worries" and "no problem" are agreement, and the no pattern was reading the leading word at face value and clearing the value; and a yes word and a no word in one breath ("yeah nah, that's the one") resolved to no unless the turn contained "correct" or "that's right".
Anything still ambiguous returns undecided rather than a confident refusal, which hands it to the model rather than to a coin toss.

Consent and the review gate still use the code path alone.
A missed yes there re-asks rather than escalating, so it costs a turn and nothing else - but it is the obvious next place to extend this if rehearsal shows it.

## Confirming what the lead already carries

Every prefilled field used to cost its own read-back and its own yes.
A lead arriving with name, date of birth, phone, email and an address spent ten turns agreeing with itself before the first real question, and both of the calls that died recently died at a confirmation rather than at an answer.

Consecutive prefilled fields in one section are confirmed together now, through the same `confirm()` that has always batched fields volunteered in one breath.
Identity becomes "I have Priya Sharma, 7th of March, 1989. Is that right?", and a prefilled address becomes one line instead of four.

**What stays on a turn of its own, and why.**
Only lines that actually speak the value join a run.
"And are you the account holder for the energy bill?" and "is this number the best one to reach you on?" ask something rather than reading anything back, and a yes to a list of facts is not an answer to a question.
That is decided by the script rather than by a flag: no `{value}` in the line, nothing to contribute to a list.
A field `confirm()` would drop for having no confirm template stays out too - `state` has `confirm: "none"`, and batching it left the field sitting in `asking` until CONFUSION picked it up, which is how that rule was found.

**A "no" had to get better to pay for this.**
It used to clear the whole batch and re-ask the first field, which for a list means making the customer repeat the parts that were right.
Naming one of them now picks it out - "no, the date of birth is wrong" - and the rest stands.
A bare "no" asks which part rather than guessing, and the answer comes back through the same name scan, bounded so it cannot loop.
A correction is read off any field on the line rather than only the first, so "no, it's the 1st of September 2002" answering a name-and-date read-back lands on the date.

**Full section-level confirmation was considered and not built.**
Collecting a whole section and confirming it once at the end costs three things this is built on: a "no" stops being actionable, `flushCompletedSections()` has nothing to bank when a call drops mid-section, and an escalation hands the human a packet with nothing confirmed in it.
Prefilled values are the safe subset - they came from the web journey, so CIMET already holds them, and the read-back is a formality rather than the gate.
Values given by voice keep their immediate read-back, because that is the case the gate exists for.

## The eighth journey call: escalated for saying two years out loud

Call `17552735`, lead L-1043 (Daniel), 65 seconds, handed to a human 47 seconds in with **nothing captured and 0 of 15 hands-free**.

What the customer heard:

```
Agent    I have Daniel Okafor, 22nd of November, 1976. Is that right?
Daniel   Uh, yes, it is right, but, uh, it's 1987, not 8-- 1986.    (0.82, captured correctly)
Agent    Right.
Agent    I'm going to get a colleague to help you with this - one moment...
```

He was confirming his name and correcting his year of birth, which is the single most ordinary thing that happens on this call.
The console said **HANDED OFF - SENSITIVE, "long digit run"**: guardrail 3, the one that exists to cut in on somebody reading out a card number.

There is no card number in that sentence.
`looksLikeCardNumber` replaced every non-digit with a space before matching, so the letters between "1987" and "1986" became whitespace, and the pattern it then ran allowed unlimited whitespace *between* digits.
Nine digits scattered across a sentence read as one run of nine.
The span it matched, and reported as a card, was literally `"1987      8   1986"`.

**Any turn with eight digits anywhere in it fired guardrail 3**, and this journey is full of them:

| The customer says | Digits | Before |
| --- | --- | --- |
| "it's 1987, not 8-- 1986" | 9 | handed off |
| "Born 7 March 1989, postcode 2150" | 9 | handed off |
| "It's 0412 345 678" - the `phone` field | 10 | handed off |
| "My NMI is 6407 1234 567" - the `nmi` field | 11 | handed off |
| "22 11 1976" - a date read as digits | 8 | handed off |

The third and fourth are fields this journey asks for outright, and the second is the answer **The three-minute cut** deliberately invites by asking for the whole address in one breath.
This was not a rare edge; it was a mine under the middle of the happy path.

**The fix is that digits have to be dictated together to count together.**
A run is now digits separated by nothing but spaces and hyphens, matched against the raw text - a word between two numbers means they are two numbers.
The bar moved from eight digits to **twelve**, because a payment card is 13 to 19 digits and the longest number this journey ever asks anyone to read out is an eleven-digit NMI, so twelve is the first length that cannot be a legitimate answer.
Twelve digits of a sixteen-digit card is still mid-number, which is what "cut in before they finish" needs.
Naming a card - "the card is 4539 1488" - drops the bar back to eight, because saying the word removes the ambiguity the bar exists for.
Scribe's own PCI entity detection is unchanged and remains the primary defence: it fires mid-utterance, before any of this sees a committed transcript.

`redactDigits` now runs on exactly the same rule.
The old pair disagreed, which was its own bug in both directions: SENSITIVE fired on a sentence the console then printed in full, and a customer's own phone number was redacted out of a transcript whose form panel shows that number two panes across.

`pnpm escalation:check` is new and holds all of it, including every row of the table above.

**Something worth taking from this beyond the regex.**
A guardrail that fires wrongly is not a safe failure.
This one ended the call, wrote `0/15 hands-free` into the audit trail, and burned a warm transfer on a customer who was answering correctly - and it did it silently, in the sense that nothing on the console suggested the reason was wrong.
The card heuristic had never had a single test before this call.

## Taking a handoff back

An escalation that fires wrongly is now recoverable from the operator's chair.

`POST /calls/:id/handoff/cancel`, and a **Cancel - keep the agent on** button inside the handoff banner on the console.
The agent says "Actually - sorry about that, no need to pass you over. Let's keep going." and asks the question it was on again, word for word.

**The window is the bridging line**, which is several seconds of uninterruptible speech, and it closes at the instant the redirect is handed to Twilio.
After that the `<Connect><Stream>` has been torn down by the redirect and the engine has finalised, so there is no line left to resume on: the endpoint answers 409 with "the transfer is already placed - the colleague's phone is ringing" rather than pretending.
Reviving the voice loop behind a live `<Dial>` is still a rebuild, not a cancellation.

Three things the resume has to get right, all checked in `pnpm dialogue:check`:

- **The question is repeated, not re-asked.** `askField()` charges an attempt, and the field is very often already one attempt from the CONFUSION that caused the handoff - so re-asking would undo the cancel on the turn after it.
- **The detector is reset, streaks and all.** Only clearing `fired` would let the same accumulated pressure fire again immediately; and every path into the engine is guarded by `hasFired`, so leaving it set makes the resumed call sit mute until the abandon timer.
- **The silence clock stops for the handoff and restarts on resume.** It had always been left running underneath the bridging line, so "Sorry, are you still there?" could land on top of "I'm going to get a colleague" - invisible while a handoff always ended the call a moment later.

## The agent answering itself

Rehearsal on speakerphone produced the worst failure this product has: **the agent accepted answers the customer never gave.**

The cause is acoustic echo, and it is worth being precise about it, because every obvious fix addresses something else.
Our own TTS comes out of the customer's speakerphone and back into the customer's microphone.
It arrives on the inbound track as ordinary caller audio - correctly transcribed, at ordinary confidence, with our own words in it - and Scribe's VAD commits it as a turn.
Nothing at the telephony layer can separate it from speech, because at that layer it *is* speech: a microphone really did pick it up and the carrier really did send it.
On a handset held to the ear there is no acoustic path from earpiece to mouthpiece, which is why the same build behaves perfectly that way, and why "it works when I put it on Ear" is the tell rather than a fluke.

**What is not the fix, and why.**

- **Noise cancellation is not available on this leg.** Twilio's Krisp integration exists only in the Voice JS and Video SDKs, which are WebRTC clients. There is no Krisp option on a PSTN leg or on Media Streams. Krisp do license a server-side 8 kHz SDK, which is out of scope here.
- **Asking for the inbound track only changes nothing, and there is nothing to ask for.** Twilio documents `track` as a `<Start><Stream>` attribute and states that a bidirectional `<Connect><Stream>` can only receive the inbound track. We already use `<Connect><Stream>`, so this is true by construction and no attribute was added - putting an unsupported attribute on the one piece of TwiML every call depends on buys a default we already have. It would in any case only govern the outbound leg being looped back to us, which was never the path: the echo is in the customer's room.

**What the fix is: know what the customer has actually heard, and refuse anything that sounds like it.**

*Marks, one per sentence.*
Frames go into Twilio's buffer an order of magnitude faster than they play - a three-sentence reply is written in milliseconds and takes seconds to play - so "the last frame written" is not "the last thing heard".
Every sentence now carries its own mark (`<utterance id>:<sentence index>`), and `playedText` is the concatenation of the sentences whose marks Twilio has echoed back.
`ttsPlaying` goes false and `ttsEndedAt` is stamped only when the final mark of an utterance returns.
On barge-in the pending resolvers are dropped rather than run, which is what truncates `playedText` to the last acknowledged mark: audio a `clear` threw away was never in anyone's room.
This also replaced the old estimate of what a cut line had been heard - sentence durations against elapsed time - with Twilio's own answer.

*The half-duplex gate, in `engine/half-duplex.ts`, ahead of everything in `onTranscript`.*
While the agent is audible, or within `HALF_DUPLEX_TAIL_MS` of it, a transcript must clear three bars at once to count as the customer: at least three words, at least 500 ms of speech measured from Scribe's word timestamps, and not a fuzzy substring of `playedText` at 0.8 or better.
Anything else is discarded silently - no re-ask, no attempt charged, nothing on the wire.
Clearing all three is treated as a real barge-in: the LLM stream is cancelled, the TTS socket dropped, `clear` sent, and `playedText` truncated.

The similarity test is approximate substring matching rather than containment, because transcribed echo comes back with words dropped and names mangled - "I have Priya Sharma" becomes "have priya sharman".

*The answer gate.*
A segment that would write a value has to carry mean word confidence of at least `ANSWER_MIN_CONF`, at least two words - or one letter or digit token on a `spell` field - and produce a patch or an answer intent from `extract()`.
Otherwise it is dropped silently and a `transcript.dropped` event goes to the console with a reason: `echo`, `low_conf`, `too_short` or `no_intent`.

**Two things about the gate that were deliberate, and are worth knowing before retuning it.**

**It is scoped to suspect turns, and that scope is load-bearing.**
The silent drops apply while the agent is audible or inside the tail - the window in which both causes of this bug are active.
Outside it, a short or quiet or unparseable segment is the customer on a bad line, and the re-ask tuned over seven real calls serves them better than silence.
The reason this matters is not theoretical: a dropped segment prompts nothing, and a customer who only speaks in reply to us then never speaks again.
The mumbler in `pnpm eval` answers at 0.38 and has to reach a CONFUSION handoff; gated unconditionally it reaches the abandon timer instead, in silence.
`ANSWER_GATE_ALWAYS=1` gives the unconditional version, and the cost of it is exactly that.

**A recognised yes or no is exempt wherever one is meaningful.**
It is one word and carries no value, so every clause of the answer gate would reject it - and about a third of this journey's questions are closed.
The dangerous version of a phantom yes is one arriving while the agent is talking, and that dies in the half-duplex gate, which is the right layer for it.

**The tail is measured against when a transcript commits, not when it was spoken, and that arithmetic decides the number.**
Scribe does not commit until `STT_SILENCE_MS` of quiet has passed, so a real answer lands here at least 700 ms - plus the speech itself, plus the transcriber's latency - after our audio stopped, which is comfortably outside a 400 ms tail.
That is what keeps a genuine one-word "Yes." from being eaten.
The same arithmetic has a consequence in the other direction: an echo of the **last** sentence of a line ends as our playback ends, so it commits about `STT_SILENCE_MS` later and a 400 ms tail misses it.
`pnpm dialogue:check` asserts both halves of that, so changing one number without the other fails a check rather than surprising someone on a live call.
The default is left at 400 because the dangerous class is caught there regardless - an echo of the earlier sentences, which is the one carrying the name and date a read-back can falsely confirm, commits while playback is still running - but **rehearsal on speakerphone should try `HALF_DUPLEX_TAIL_MS=1200`**, which is where the closing question's echo starts being caught too.

**`ANSWER_MIN_CONF` defaults to 0.7 and that is higher than this account's own measurements justify.**
The six correctly-transcribed turns measured on a real call scored 1.00, 0.55, 0.69, 0.85, 1.00 and 1.00, so a 0.7 floor would have dropped two right answers.
It is a deliberate trade - a dropped answer costs a nudge, an accepted mishearing writes a wrong value into an energy signup - but if rehearsal shows the agent going quiet on answers that sounded fine, this is the number to lower, and 0.45 is where the measured distribution puts it.

**Scribe's VAD is tuned, and can be taken over entirely.**
`STT_SILENCE_MS` is 700, up from the 500 ms floor, because people pause longer than half a second in the middle of an address and a longer window is also a smaller chance of a clip of our own voice committing as a turn of its own.
`STT_VAD_THRESHOLD` raises the level at which speech is declared, which matters because echo arrives attenuated; it is only sent when set, since Scribe fails the whole socket on a parameter it dislikes and the call then runs with the agent talking and hearing nothing.
`STT_MANUAL_COMMIT=1` switches `commit_strategy` to `manual` and commits on our own silence timer instead, which unlike the server's knows whether the agent is talking.

**The first committed turn's raw word objects are logged once per session.**
The gates are defined on per-word `logprob` and on `start` / `end` timestamps, and the only way to know those fields are present and varying is to look at what a live call returns.
Look for `first committed words:` in the orchestrator log on the next real call and confirm it before trusting the confidence clause.

## Hearing the agent from the room

There is now a local monitor, because "the customer says it sounded broken" is not a debugging tool.

Every frame written to Twilio is also published on `ws://localhost:8080/monitor`, binary, tagged with the call id: one byte of id length, the id, then ulaw 8 kHz.
**Agent audio only.** The inbound track never passes through `sendFrames`, which is the single point this is tapped, so the monitor cannot become a way to listen to the customer - and it is also the one thing that could feed the echo path it exists to diagnose, if the console were played through a speaker in the same room.

The console has a **Monitor** toggle in the transcript pane head.
It decodes ulaw to PCM and plays through Web Audio, scheduled against the audio clock with a 100 ms jitter buffer rather than played on arrival - frames arrive far faster than realtime and in bursts, so playing them as they land would run the monitor steadily ahead of the call.
`MONITOR_CMD=ffplay` pipes the same audio to `ffplay -f mulaw -ar 8000 -i -` instead, paced to realtime on this side because ffplay has no schedule of its own.

The tap is in `sendFrames`, which every route to Twilio goes through - a line synthesised just now, a fixed line served from the pre-render cache, a sentence of a streamed reply - so there is no second write path to remember.

## The three-minute cut

The organiser confirmed there will be no sandbox and no mocked API from their side, and the demo slot is three minutes.
Both of those landed after the seven calls above.

**The journey is still all 17 fields.**
Cutting five of them was tried and reversed: the extras are seeded on the lead instead, so the agent confirms them rather than asking them, and the journey still answers the problem statement in full.
L-1042 now carries `nmi`, `concession: false` and `life_support: false` in its prefill on top of what it had.
The console's setup step can clear any of them to have the agent ask outright, which is the case worth rehearsing at least once.

**Seeding is not free for every field, and it is worth knowing which.**
A seeded field is only cheap when its line speaks its value - `prefilledRun()` requires `{value}` or `{value_spelled}` in `prefilledLine(field)`, and only those join a batched read-back.

| Field | Seeded costs | Why |
| --- | --- | --- |
| `full_name`, `dob` | nothing extra | They speak their values and batch into one line |
| `street`, `suburb`, `postcode` | nothing extra | Same, when the customer gives them in one breath |
| `concession`, `life_support` | one turn, same as asking | Closed bools. `speakableValue` renders a bool as "yes"/"no", which reads as nonsense in a sentence, so they deliberately have **no** `prefilled` script and `prefilledLine()` falls back to their `ask`. A line asserting "you don't hold a concession card" would simply be wrong when the operator seeds `true` |
| `nmi` | one turn, and it used to be the worst line in the call | Without a `prefilled` script it fell back to `confirm: "I have {value_spelled}..."` and spelled eleven digits - about nine seconds, on the path the handoff already flags as risky. It now has its own line that acknowledges the number without reading it back |
| `concession_type`, `move_in_date` | nothing | Conditional. With `concession: false` and an existing connection they never apply at all |

**The address is invited in one breath.**
`street.ask` is now "What's the supply address? Street, suburb and postcode is all I need."
The fact bus has always accepted several fields from one utterance and read them back together; the old wording simply never asked for them.
This is the single biggest lever on call length - four turns and about sixteen seconds - so the demo should say the whole address at once.
A customer who gives only the street still gets asked the suburb and the postcode, so the fallback is intact, and `state` is inferred from the postcode either way.

**The opener is 36 words, down from 52.**
It still discloses the automated assistant and the recording before anything else, which is the compliance requirement.
What went was saying it twice over.

**Section intros are spoken again, all six of them.**
They never were before: `askNext()` compared `currentSection()` against the section it had just read off the same `nextField()` call, so the comparison was always equal and only the first section could ever be introduced.
The engine tracks `introducedSection` now and compares against that.
Four of the six lines had been dead script since they were written.

**Measured on the cooperative persona, against live models:**

| Shape | Customer turns | Estimated speech |
| --- | --- | --- |
| Address in one breath, intros on | 15 | ~2:35 |
| Address in one breath, intros off | 15 | ~2:21 |
| Street only, intros on | 19 | ~2:51 |
| Street only, intros off | 19 | ~2:37 |

Those are agent words at 165 wpm plus 2.8 s per customer turn, not wall clock off a real call.
Rehearse it and replace these with real numbers.
If the slot gets tight, the intros are the cheapest fourteen seconds to give back - revert `introducedSection` in `askNext()` and they stop being spoken, exactly as they were for the first seven calls.

**Fields are saved one at a time, the moment they are confirmed.**
`flushCompletedSections()` is gone; `saveField()` fires off the form's `change` handler when a field reaches `confirmed`, and `flushConfirmedFields()` sweeps in `askNext()` and before a handoff.
A field is the unit the customer actually confirms, so a call that escalates halfway through Supply has saved the address it just heard rather than losing a part-finished section.
A correction takes its field back out of `savedFields`, so the replacement value is saved on its own - and that second PUT is visible in the console, which is worth doing on purpose in a rehearsal.
Nothing is sent before consent is on the record: `saveField` declines while `state.consent` is false, which is why the sweep exists.

**The saves go to a mock CRM the orchestrator mounts itself, at `/mock-crm`.**
They are ordinary HTTP with ordinary status codes - `PUT /journeys/:leadId/fields/:field` per field, `POST /journeys` at the end, which is still the one that validates.
`SANDBOX_URL` decides where they go and defaults to the mounted one when blank, so pointing at a real endpoint stays a config change and nothing in the save path knows the difference.
A save that fails comes back as a result with status 0 rather than an exception, because a save that could not be made is still something the operator needs to see.

**The console has an API logs pane**, full width under the three panes.
One row per request: method, path, status, round trip, and the request and response JSON on opening it.
It is the answer to "is it actually saving" being asked from the back of a room, and a failed save is a red row rather than a line in a log nobody is looking at.

## What to watch on the next journey call

- Does the consent gate fire before any field is asked, and is the disclosure audible at the top.
- Do spelled fields survive a real line: email and postcode are the risky ones.
- Does the read-back speak a human date ("7th of March, 1989") rather than an ISO string.
- Does state get inferred from the postcode and the question skipped entirely.
- Do the per-field PUTs land. The API logs pane is the place to watch; the orchestrator log prints `mock CRM: saved "<field>"` for each one.
- Does a correction produce a second PUT for the same field. Worth provoking once.
- Do all six section intros play, and does the call still fit the slot with them in.
- Does the seeded NMI get acknowledged rather than spelled back at eleven digits.
- Does the console fill live at `localhost:3000`.
- Echo: the agent hearing itself. This is now gated rather than hoped about - see **The agent answering itself**. Run one call deliberately *on speakerphone*, which is the condition the gate exists for, and watch the transcript pane for struck-through lines tagged `dropped - our own voice`. Seeing a few is the feature working. Seeing none on speakerphone means the gate is not firing and the tail is the first thing to raise (`HALF_DUPLEX_TAIL_MS=1200`).
- Is anything escalated that should not be. Read the reason on the banner rather than trusting it: this is the second time a signal has fired on a customer who was answering correctly. If it is wrong, press **Cancel - keep the agent on** in the banner and the call carries on from the same question.
- Provoke that cancel once on purpose. Ask for a person, let the bridging line start, then cancel - the agent should apologise, ask its question again, and the board should go back to `live`. Leave it too long and it will tell you the colleague's phone is already ringing, which is the honest answer.
- Does the agent go quiet on answers that sounded fine. That is the answer gate's confidence floor, and `ANSWER_MIN_CONF` is the number to lower - the default is stricter than this account's own measurements justify.
- Turn the **Monitor** toggle on at the top of the transcript pane and confirm the agent's voice comes out of the laptop. It is the cheapest way to tell a bad line from a bad render, and it needs no second handset.
- Confirm `first committed words:` appears once in the orchestrator log, and that the `logprob` values in it vary. The confidence clause of the answer gate is built on that field; if it is absent or always the same, drop the clause rather than trusting it.
- Do the prefilled fields land as one yes per run: name and date of birth together, then the account holder and the number as their own questions.
- If the customer says "no" to one of those runs, does naming the wrong one re-open only that one.
- Is any question asked twice. One repeat with no re-ask wording ("sorry, ...") in front of it means an answer was eaten by a stale read-back, which is the fifth call's second defect.
- Does the handoff leave the customer on the line while the second handset rings, and does the recorded outcome come back as `handoff` rather than `disconnected`. The outcome is the cheap tell: `disconnected` after a transfer means we hung up on them again.
- Does `AMD: machine_start - advisory only, the call continues` appear in the log, and does the call carry on regardless.
- Does `inbound audio stalled` appear in the orchestrator log. If it does, the tunnel is the next suspect, not Scribe.
- Do the customer's confidences look like the echo call (0.5 to 1.0) or like the first journey call (0.2 to 0.3). The second means the line, and the fix is the handset, not the code.

## Pending

**Blocking a full demo**

- The journey has run over a real phone once and failed on the line. It has not yet completed over a real phone; everything below assumes that happens first.
- ~~Warm handoff `<Dial>` transfer has never rung the second handset live.~~ Done on the sixth call: the handset rang, the human answered, the whisper played, and the bridge held for 87 seconds.
- ~~Nothing happens for the customer when the human does not answer.~~ Fixed: the `<Dial>` carries an `action` URL now, and `/twilio/handoff-result/:callId` says "I couldn't reach a colleague just now, someone will call you straight back" before hanging up. Untested on a real unanswered transfer - the route itself is exercised by hand, the TwiML is right, but nobody has declined a live handoff since.
- Taking a callback time by voice when the handoff misses is **not** built. The media stream is gone by then and the engine has finalised, so reviving the voice loop after a `<Dial>` is a real change, not a tweak. The human console has the packet, which is what the apology is promising.
- The operator console has never been watched during a real call.

**Waiting on CIMET**

- Real field list drops into `journey/energy.journey.json`; update `sandbox/mapping.ts`. Nothing else should need to change.
- There is no sandbox and no mocked API coming: the organiser confirmed that. `sandbox/mock-server.ts` is the stand-in, and `SANDBOX_URL` is the seam if that changes.
- The recording gives script phrasing and the manual baseline for the efficiency counter, which is currently `manual_baseline_s: 0`.

**Known limitations found while debugging**

- A value volunteered in answer to a read-back, for a field that is not in that read-back, is dropped. "Priya Sharma, and before you ask I'm the account holder" said to a name read-back confirms the name and then asks the account holder question anyway. Nothing is lost permanently; it costs a turn and a point of the efficiency number.
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
  engine/escalation.ts          six signals; five decided in code, and guardrail 3's digit runs
  engine/normalise.ts           dates, digits, emails, enums - never the model
  voice/stt/scribe.ts           Scribe v2 Realtime; deepgram.ts is the fallback
  voice/tts.ts                  TTS on the voice's fine-tuned model, loudness levelling, ulaw_8000, disk pre-render
  voice/llm/                    anthropic | openai | openrouter | gemini
  engine/half-duplex.ts         the echo gate: what was played, and whether this is the customer
  transports/twilio.ts          media stream, per-sentence marks, barge-in (takesTurn), transfer
  monitor.ts                    the agent's own audio, on a local websocket and optionally at ffplay
  calls.ts                      wires transport + engine to the SSE bus
apps/web/app/                   / operator console, /handoff human console
packages/shared/                the SSE event union both apps compile against
```

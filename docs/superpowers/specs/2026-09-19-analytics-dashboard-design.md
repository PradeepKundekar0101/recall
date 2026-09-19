# Analytics dashboard - design

Written 19 Sep 2026.
The console can show you one call in detail and a list of every call, but it cannot answer the two questions that decide whether this agent is ready: is it fast, and is it accurate.
This adds the surface that answers them.

## What this is for

An engineering dashboard, not a stage surface.
It leads with the turn latency budget, where the time inside a turn goes, and which fields the agent keeps fumbling.
The time axis is per-turn and per-call rather than per-day, so it reads honestly at five calls and still works at five hundred.

It is modelled on a reference dashboard that carried tiles for token usage, a TTS/LLM time-to-first-byte split, processing time and sentiment.
Three of those four have no source in this codebase today, so this spec adds the instrumentation that produces them.
Sentiment is deliberately dropped: there is no honest source for it here, and an invented number on an engineering dashboard is worse than a missing one.

## What already exists

The `calls` table carries outcome, duration, hands-free field counts and handoff reason.
`call_events` mirrors the whole SSE union as JSONB, which is what makes a finished call replayable after the orchestrator that ran it is gone.
`toolCall` in `voice/llm.ts` already measures and returns its own round trip, and pushes it onto a module-level array that `latencyMedian()` reads.
The `Transport.speak` interface already carries an `onFirstAudio` callback, which fires when the first frame reaches the wire.

## Two defects this uncovers

**The journey engine never measures turn latency.**
`latency.turn` is wired only for `EchoEngine`, through the `onTurnMeasured` hook in `calls.ts`.
`DialogueEngine` has the `onFirstAudio` hook available and uses it only to set `questionAudibleAt`.
So on every real journey call, the one number the rehearsal checklist asserts on is not being recorded at all.
Instrumenting the stage split fixes this as a side effect, because `first_audio_ms` is exactly that number.

**`test_run` is hardcoded `true`.**
Every row in `calls` is a test run, so the column cannot distinguish anything.
The distinction that matters for analytics is a different one, and it is a correctness issue rather than a preference - see Simulated calls below.

## Section 1 - Instrumentation

One new event on the SSE union, `turn.timing`, emitted once per agent reply.

Time zero is the committed transcript, not end of speech.
Scribe runs with `include_timestamps` on, but the local `ScribeWord` type models only `text`, `type` and `logprob`, so word end times are not known to be available.
Naming a boundary that can be defended is worth more than a more flattering one that cannot.

### Stages

| Field | Span | Why it is separate |
| --- | --- | --- |
| `think_ms` | transcript in hand to reply decided | Closed fields land here in single-digit ms; model turns do not |
| `llm_ttfb_ms` | request sent to first token | Null on closed fields, which never reach the model |
| `llm_total_ms` | request sent to last token | Already returned by `toolCall`, currently unused |
| `wire_wait_ms` | reply decided to wire free | `onTheWire` queues behind current playback. Without this, a reply waiting on the previous line makes TTS look slow |
| `tts_ttfb_ms` | text handed to TTS to first audio frame | Uses the existing `onFirstAudio` hook |
| `first_audio_ms` | transcript to first audio | The budget number |

The spans that tile the turn are `think_ms`, `wire_wait_ms` and `tts_ttfb_ms`.
The two LLM numbers are nested inside `think_ms` and are a breakdown of it, not a fourth slice.
`think_ms + wire_wait_ms + tts_ttfb_ms = first_audio_ms` on a turn that completed every stage.

### Also on the event

`prompt_tokens`, `completion_tokens`, `model`, `tts_chars`, and two booleans:

- `closed_field` - the answer was matched in code and never reached the model.
- `tts_cached` - the line played from the pre-render on disk and was never synthesised.

Those two booleans are the point of the whole event.
Without them the timing chart is three overlapping distributions pretending to be one, and the average across them means nothing.
With them the dashboard can say "cached script line: 40 ms, generated reply: 780 ms", which is the actual engineering answer.

### Cost on the hot path

Six `Date.now()` calls and one synchronous `bus.emitEvent`.
Token capture on the streaming path needs `stream_options: { include_usage: true }`, whose extra chunk arrives after the last text token and therefore cannot move first audio.
Nothing is awaited that is not already awaited.
The Supabase mirror stays the un-awaited best-effort write it already is.

## Section 2 - The API

### Simulated calls

A sim-transport call with `MOCK_VOICE=1` returns TTS instantly and stamps every customer turn at 95% confidence.
Averaging those into latency statistics would make the agent look several times faster than it is.
That is the same failure the handoff document warns about, a convincing transcript while nothing rang, reappearing as a metrics lie.

`simulated` currently lives only in the `call.hello` payload.
It gets one boolean column on `calls` via a numbered migration, written from the same expression the `POST /calls` response already uses.
The analytics window defaults to dialled calls only.

### Endpoint

One endpoint rather than four.
The dashboard is a single page, so a single request gives it one loading state and no waterfall.

```
GET /analytics?window=7d&source=dialled
```

`window` is one of `24h`, `7d`, `30d`, `all`.
`source` is `dialled` or `all`.

The response covers the page in one object:

- `totals` - outcome mix, handoff reasons by signal, call counts.
- `accuracy` - hands-free rate, submitted rate, median duration.
- `latency` - first-audio percentiles against the 800 ms budget, the three tiling stages plus the nested LLM breakdown, and a `by_kind` split across closed-field, generated and cached-line.
- `trend` - per day.
- `fields` - per field: asked, captured first try, re-asks, mean confidence.
- `usage` - tokens by model, TTS characters, cached versus synthesised.

### Percentiles, not averages

The reference dashboard shows averages.
For latency that is the wrong statistic, because it hides the tail that actually breaks calls.
p50 and p90, with min and max alongside.

### Code shape

A new `analytics/` module under the orchestrator, split in two:

- `query.ts` - Supabase reads. Aggregation over `call_events` JSONB, using the existing `call_events_type_idx`.
- `aggregate.ts` - pure functions over rows, no database.

The split exists so the arithmetic is testable without a database.
A 30-second in-process cache keyed on the query string means opening the page does not rescan.

If volume ever makes the JSONB scan slow, a materialised view or a narrow `call_turns` table can be introduced behind `query.ts` without the API changing shape.

### The call detail page needs no new endpoint

`turn.timing` events already arrive through `/calls/:id/events`, which replays from `call_events` for a call this process never ran.
That page aggregates the call it is already streaming.

## Section 3 - The UI

Route `/analytics`, added to `Nav.tsx` alongside Home and Past calls.

### Charting

Hand-rolled inline SVG, no chart library.
Recharts brings roughly 500 KB and its own visual defaults, which fight the restraint in `apps/web/DESIGN.md`, and the five shapes needed here are genuinely simple.
Components live in `components/analytics/` and take their colour entirely from the CSS variables already in `globals.css`.

The console stays light.
The reference screenshots are a dark developer-tools canvas, which `DESIGN.md` explicitly rules out.
This takes their information architecture and none of their palette.

### Layout, ordered by the question it answers

1. Four tiles - hands-free rate against the 25% criterion, first-audio p50 against the 800 ms budget, submitted rate, calls in window.
   Each tile shows the threshold it is being judged against.
2. First-audio distribution with the budget drawn as a vertical rule, beside where the time goes: the three tiling stages at p50, split three ways by turn kind.
   These two are the headline; everything above them is a summary of them.
3. Trend over days, and outcome mix.
4. Per-field table - asked, captured first try, re-asks, mean confidence.
   This is the accurate half, and the one surface that says which question the agent keeps fumbling.

### Thin data

A rule in the components, not a caveat in the copy.
Any chart whose window holds fewer than 10 calls renders the raw count and a plain note instead of a line.
The threshold is one exported constant, so it is changed in one place rather than argued about per chart.
Five dialled calls must not be drawn as a confident trend.

### Call detail

One new panel on `/calls/[id]`: per-turn stage breakdown and that call's token and character usage, built from the `turn.timing` events already streaming in.

## Section 4 - Error handling and testing

### Errors

Analytics must never be able to affect a call, which is the rule `db/repo.ts` already sets for the audit trail.

A provider that returns no `usage` object emits the event with null token counts rather than throwing inside the turn.
A stage timer that never fires, on a turn cancelled by barge-in mid-LLM, emits nulls for the stages it never reached, and that turn is excluded from percentiles rather than counted as zero.
The endpoint returns 503 with a readable reason when Supabase is unreachable, and the page renders it as a notice the way `/calls` already does.
No Supabase means the page says so plainly rather than showing zeroes that read as real measurements.

### Testing

Following the repo's existing `*.check.ts` convention.

`pnpm analytics:check` - pure aggregation over fixture rows, milliseconds, no network. Asserts:

- percentiles against hand-computed values.
- `think_ms + wire_wait_ms + tts_ttfb_ms = first_audio_ms` on a complete turn.
- closed-field turns excluded from LLM statistics.
- cached lines excluded from TTS synthesis statistics.
- simulated calls excluded from the dialled window.
- a window below 10 calls reporting thin rather than yielding a trend.
- a turn with null tokens leaving usage totals intact rather than poisoning them.

`pnpm dialogue:check` gains cases asserting one timing event per reply, and no event at all for a turn cancelled by barge-in.

The aggregation functions get their checks written first.
They are pure, and that is exactly where arithmetic errors hide.

## Out of scope

- Sentiment. No honest source.
- A dark theme. `DESIGN.md` rules it out and the console is coherent as it stands.
- Per-day trends presented as meaningful at current call volume. The thin-data rule exists to prevent exactly this.
- A `call_turns` table. `call_events` is the single audit mirror, and a second write path would give the call detail page two sources for one number that can disagree.

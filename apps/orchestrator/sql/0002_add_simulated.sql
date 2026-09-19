-- Tell a dialled call apart from a simulated one.
--
-- `test_run` cannot do this: it is written as a constant true on every row, so
-- it distinguishes nothing. What matters for analytics is whether a phone
-- actually rang. A sim-transport call with MOCK_VOICE=1 returns TTS instantly
-- and stamps every customer turn at 95% confidence, so averaging those into
-- latency statistics makes the agent look several times faster than it is.
--
-- Existing rows default to true. Every call written before this migration was
-- run predates any way of knowing, and counting an unknown as dialled would put
-- exactly the samples this column exists to exclude back into the numbers.
alter table calls add column if not exists simulated boolean not null default true;

create index if not exists calls_simulated_started_idx on calls (simulated, started_at desc);

-- One-time, destructive. Run once against the carried-over Supabase project,
-- before sql/schema.sql, then never again.
--
-- This project reuses the sarvam-buildin Supabase project (see SUPABASE_URL in
-- .env). That project already owns a table called `calls`, with an entirely
-- different shape: mission_id, counterparty_name, first_quote, rounds. Because
-- schema.sql creates its own `calls` with `if not exists`, the collision did not
-- announce itself - the create was skipped and the very next statement failed
-- with `42703: column "lead_id" does not exist`, three lines away from the actual
-- problem. Worse than the error: had the index line not been there, repo.ts would
-- have spent the demo inserting lead_id and journey_id into another project's
-- table.
--
-- `public_stats` is a view over `calls` and cannot outlive it.
--
-- Only the colliding objects are dropped. `missions`, `optouts` and `bhav_index`
-- do not collide with anything in schema.sql, so they are left where they are;
-- drop them separately if this project is meant to be cleared out entirely.
--
-- A JSON export of every table was taken on 2026-09-18, before this ran.

drop view  if exists public_stats;
drop table if exists calls cascade;

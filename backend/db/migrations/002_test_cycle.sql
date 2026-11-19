-- 002_test_cycle.sql - adds the "Start / End test cycle" columns to an EXISTING database.
--
-- What it does:
--   Adds the test_* columns to receiver_control (see schema.sql for what each means).
--   Load 001_receiver_control.sql first if the table doesn't exist yet. Safe to run more
--   than once, and never touches existing data. New databases don't need this.
--
-- How to run (from the repo root):
--   Local Docker database:
--     docker compose exec -T db psql -U dryer -d dryer -v ON_ERROR_STOP=1 -f /docker-entrypoint-initdb.d/migrations/002_test_cycle.sql
--   Timescale Cloud ($env:CLOUD_URL = your connection string):
--     docker compose exec -T db psql "$env:CLOUD_URL" -v ON_ERROR_STOP=1 -f /docker-entrypoint-initdb.d/migrations/002_test_cycle.sql

ALTER TABLE receiver_control
    ADD COLUMN IF NOT EXISTS test_command      text CHECK (test_command IN ('start', 'stop')),
    ADD COLUMN IF NOT EXISTS test_seconds      integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS test_command_id   bigint  NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS test_done_id      bigint  NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS test_requested_at timestamptz,
    ADD COLUMN IF NOT EXISTS test_result       text CHECK (test_result IN ('sent', 'expired'));

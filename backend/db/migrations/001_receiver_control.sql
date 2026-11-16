-- 001_receiver_control.sql - adds the remote Connect button's table to an EXISTING database.
--
-- What it does:
--   Creates receiver_control (see schema.sql for what each column means) and its row
--   for every device. Safe to run more than once: it changes nothing the second time,
--   and never touches existing data.
--   New databases don't need this - schema.sql and seed.sql already include it.
--   (Docker only runs .sql files directly in backend/db/, not this subfolder.)
--
-- How to run (from the repo root):
--   Local Docker database:
--     docker compose exec -T db psql -U dryer -d dryer -v ON_ERROR_STOP=1 -f /docker-entrypoint-initdb.d/migrations/001_receiver_control.sql
--   Timescale Cloud ($env:CLOUD_URL = your connection string, as in D1):
--     docker compose exec -T db psql "$env:CLOUD_URL" -v ON_ERROR_STOP=1 -f /docker-entrypoint-initdb.d/migrations/001_receiver_control.sql

CREATE TABLE IF NOT EXISTS receiver_control (
    device_id          text PRIMARY KEY REFERENCES devices (device_id),
    desired            text NOT NULL DEFAULT 'disconnected'
                       CHECK (desired IN ('connected', 'disconnected')),
    requested_at       timestamptz,
    receiver_online_at timestamptz,
    receiver_state     text CHECK (receiver_state IN ('standby', 'searching', 'connected', 'offline')),
    receiver_host      text
);

INSERT INTO receiver_control (device_id)
SELECT device_id FROM devices
ON CONFLICT (device_id) DO NOTHING;

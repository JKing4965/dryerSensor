-- schema.sql - database tables and views for the dryer lint sensor.
--
-- What it does:
--   Creates every table the backend writes to and the dashboard reads from,
--   plus the lint_status view that turns per-cycle numbers into
--   "calibrating / clean / check_soon / clean_now".
--
-- Talks to:
--   - Written by the Python receiver (backend/src/dryer_backend/db.py).
--   - Read by the Next.js API routes (frontend/src/lib/queries.ts).
--   - The "Filter cleaned" button inserts rows into events.
--
-- How it runs:
--   Docker runs every .sql file in backend/db/ in alphabetical order, but ONLY when
--   the database is first created. After changing this file, reset the database:
--       docker compose down -v
--       docker compose up -d
--   (This deletes all stored data.)
--
-- Units everywhere: pressure in Pa, temperature in degC, times as timestamptz (UTC).
-- Sign convention: dp = p_in - p_out. The inside sensor sits under the lint screen on
-- the blower's suction side, so dp is NEGATIVE while the dryer runs.

-- The volume mount replaces the image's own setup script, so switch TimescaleDB on here.
CREATE EXTENSION IF NOT EXISTS timescaledb;


-- ---------------------------------------------------------------------------
-- devices: one row per sensor board.
-- ---------------------------------------------------------------------------
CREATE TABLE devices (
    device_id   text PRIMARY KEY,                 -- matches DEVICE_ID in .env
    name        text NOT NULL,                    -- human-friendly label for the dashboard
    ble_name    text,                             -- name the board advertises over Bluetooth
    created_at  timestamptz NOT NULL DEFAULT now()
);


-- ---------------------------------------------------------------------------
-- readings: every sample from both sensors (TimescaleDB hypertable).
--   kind = 'baseline' -> idle reading taken while the dryer is off (cycle_no is NULL)
--   kind = 'cycle'    -> sample during a dryer cycle
-- ---------------------------------------------------------------------------
CREATE TABLE readings (
    time            timestamptz      NOT NULL,     -- real time of the sample
    device_id       text             NOT NULL REFERENCES devices (device_id),
    kind            text             NOT NULL CHECK (kind IN ('baseline', 'cycle')),
    boot_id         bigint,                        -- board power-up ID the sample came from
    board_ms        bigint,                        -- board's raw millis() value (for debugging / de-duplication)
    cycle_no        integer,                       -- board's cycle counter (NULL for baselines)
    seq             integer,                       -- sample number within the cycle
    p_in            double precision NOT NULL,     -- Pa, under the lint screen
    t_in            double precision NOT NULL,     -- degC, under the lint screen
    p_out           double precision NOT NULL,     -- Pa, room air
    t_out           double precision NOT NULL,     -- degC, room air
    dp              double precision GENERATED ALWAYS AS (p_in - p_out) STORED,
    dt              double precision GENERATED ALWAYS AS (t_in - t_out) STORED,
    source          text             NOT NULL DEFAULT 'live' CHECK (source IN ('live', 'flash')),
    time_estimated  boolean          NOT NULL DEFAULT false,  -- true if board time couldn't be synced
    received_at     timestamptz      NOT NULL DEFAULT now(),  -- when the computer got it
    CHECK ((kind = 'cycle') = (cycle_no IS NOT NULL))
);

SELECT create_hypertable('readings', by_range('time', INTERVAL '7 days'));

CREATE INDEX readings_device_time_idx  ON readings (device_id, time DESC);
CREATE INDEX readings_device_cycle_idx ON readings (device_id, cycle_no, seq) WHERE kind = 'cycle';


-- ---------------------------------------------------------------------------
-- cycles: one row per dryer run, plus the numbers computed when it ends.
-- ---------------------------------------------------------------------------
CREATE TABLE cycles (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    device_id       text        NOT NULL REFERENCES devices (device_id),
    cycle_no        integer     NOT NULL,          -- board's counter, kept in flash across reboots
    boot_id         bigint,
    started_at      timestamptz NOT NULL,
    ended_at        timestamptz,
    state           text        NOT NULL DEFAULT 'running'
                                CHECK (state IN ('running', 'complete', 'incomplete')),
    n_samples       integer     NOT NULL DEFAULT 0, -- samples stored so far
    n_expected      integer,                        -- sample count the board reported at cycle end
    last_seq        integer     NOT NULL DEFAULT -1,-- highest seq stored; lower/equal seqs are duplicates
    time_estimated  boolean     NOT NULL DEFAULT false,

    -- Pre-cycle baseline (latest idle reading before the cycle started)
    baseline_at     timestamptz,
    baseline_dp     double precision,               -- sensor offset: p_in - p_out with dryer off
    baseline_t_in   double precision,
    baseline_t_out  double precision,

    -- Features, filled in by backend/src/dryer_backend/features.py when the cycle ends
    dp_steady       double precision,               -- median offset-corrected dp in steady running (Pa)
    t_in_max        double precision,               -- hottest inside temperature (degC)
    dt_mean         double precision,               -- average inside-minus-outside temperature (degC)
    duration_s      double precision,               -- cycle length in seconds
    features_at     timestamptz,                    -- when the features were computed

    UNIQUE (device_id, cycle_no)
);

CREATE INDEX cycles_device_started_idx ON cycles (device_id, started_at DESC);


-- ---------------------------------------------------------------------------
-- events: things that happen outside the sensor data. For now only
-- 'filter_cleaned', inserted by the dashboard's "Filter cleaned" button.
-- ---------------------------------------------------------------------------
CREATE TABLE events (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    device_id   text        NOT NULL REFERENCES devices (device_id),
    time        timestamptz NOT NULL DEFAULT now(),
    type        text        NOT NULL CHECK (type IN ('filter_cleaned')),
    note        text
);

CREATE INDEX events_device_type_time_idx ON events (device_id, type, time DESC);


-- ---------------------------------------------------------------------------
-- device_status: one row per device, kept up to date by the receiver so the
-- dashboard can show "connected / idle / running / uploading" and sensor errors.
-- ---------------------------------------------------------------------------
CREATE TABLE device_status (
    device_id         text PRIMARY KEY REFERENCES devices (device_id),
    connected         boolean     NOT NULL DEFAULT false,
    last_seen         timestamptz,                 -- last message of any kind
    state             text,                        -- board state from the H (hello) line
    boot_id           bigint,
    backlog_count     integer,                     -- samples still waiting in the board's flash
    protocol_version  integer,
    -- Sensor error codes from the H line (docs/protocol.md 3.1): 0 ok, 1 missing, 2 broken
    sensor_in_error   smallint CHECK (sensor_in_error  IN (0, 1, 2)),  -- under the lint screen
    sensor_out_error  smallint CHECK (sensor_out_error IN (0, 1, 2)),  -- room air
    sensor_error_since timestamptz,                -- when either code last changed away from 0
    updated_at        timestamptz NOT NULL DEFAULT now()
);


-- ---------------------------------------------------------------------------
-- lint_settings: tunable thresholds for lint_status (single row, id = 1).
-- Change them without resetting the database, e.g.:
--   UPDATE lint_settings SET check_soon_score = 0.20 WHERE id = 1;
-- ---------------------------------------------------------------------------
CREATE TABLE lint_settings (
    id                 integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    reference_cycles   integer          NOT NULL DEFAULT 2,     -- cycles after cleaning that define "clean"
    check_soon_score   double precision NOT NULL DEFAULT 0.15,  -- score at/above this -> check_soon
    clean_now_score    double precision NOT NULL DEFAULT 0.35,  -- score at/above this -> clean_now
    vent_score         double precision NOT NULL DEFAULT -0.25, -- score at/below this (+ hotter) -> vent flag
    min_ref_dp_pa      double precision NOT NULL DEFAULT 5.0    -- |reference dp| below this = no usable signal
);


-- ---------------------------------------------------------------------------
-- receiver_control: the dashboard's Connect button <-> the standby receiver on the PC.
--   desired              written by the dashboard: 'connected' or 'disconnected'
--   receiver_*           heartbeat written every ~3 s by `python -m dryer_backend.remote`
--                        (times use the database clock, so PC clock errors don't matter)
-- Existing databases get this table from migrations/001_receiver_control.sql.
-- ---------------------------------------------------------------------------
CREATE TABLE receiver_control (
    device_id          text PRIMARY KEY REFERENCES devices (device_id),
    desired            text NOT NULL DEFAULT 'disconnected'
                       CHECK (desired IN ('connected', 'disconnected')),
    requested_at       timestamptz,                -- when desired last changed
    receiver_online_at timestamptz,                -- last heartbeat
    receiver_state     text CHECK (receiver_state IN ('standby', 'searching', 'connected', 'offline')),
    receiver_host      text                        -- computer name of the receiver
);


-- ---------------------------------------------------------------------------
-- Views (lint_history, lint_status) live in views.sql so they can be changed and
-- re-applied without deleting data.
-- ---------------------------------------------------------------------------

-- views.sql - the lint logic: turns per-cycle numbers into a lint verdict.
--
-- What it does:
--   lint_history  one row per complete cycle: its lint score and status at the time
--                 (used for the dashboard's trend chart)
--   lint_status   one row per device: the CURRENT verdict (latest cycle, or
--                 "calibrating" right after the filter was cleaned)
--
-- How the verdict works:
--   reference  = average dp_steady of the first <reference_cycles> complete cycles
--                after the latest 'filter_cleaned' event before that cycle
--   score      = (ref_dp - dp_steady) / |ref_dp|
--                > 0  -> dp became MORE negative than when clean (lint on the screen)
--                < 0  -> dp moved toward zero (less airflow, e.g. clogged exhaust duct)
--   status     = calibrating  (fewer than <reference_cycles> cycles since cleaning)
--                no_signal    (reference dp smaller than min_ref_dp_pa, can't judge)
--                clean / check_soon / clean_now   (score vs. thresholds)
--   possible_vent_blockage = score <= vent_score AND the cycle ran hotter than reference
--   Thresholds come from the lint_settings table (schema.sql).
--
-- Talks to:
--   - Reads cycles (features filled in by backend/src/dryer_backend/features.py),
--     events ('filter_cleaned' rows from the dashboard button) and lint_settings.
--   - Read by the dashboard (frontend/src/lib/queries.ts).
--
-- How to apply:
--   Runs automatically when the database is first created (after schema.sql and seed.sql).
--   After editing this file, re-apply it WITHOUT losing data (from the repo root):
--       docker compose exec -T db psql -U dryer -d dryer -f /docker-entrypoint-initdb.d/views.sql

DROP VIEW IF EXISTS lint_status;
DROP VIEW IF EXISTS lint_history;


CREATE VIEW lint_history AS
WITH settings AS (
    SELECT * FROM lint_settings WHERE id = 1
),
usable AS (
    -- complete cycles with features, each tagged with the cleaning that preceded it
    SELECT c.*,
           (SELECT max(e.time) FROM events e
             WHERE e.device_id = c.device_id
               AND e.type = 'filter_cleaned'
               AND e.time < c.started_at) AS cleaned_at
    FROM cycles c
    WHERE c.state = 'complete' AND c.dp_steady IS NOT NULL
),
ranked AS (
    SELECT u.*,
           row_number() OVER (PARTITION BY u.device_id, u.cleaned_at ORDER BY u.started_at)
               AS n_since_cleaning
    FROM usable u
),
refs AS (
    SELECT r.device_id, r.cleaned_at,
           avg(r.dp_steady) AS ref_dp,
           avg(r.t_in_max)  AS ref_t_in_max
    FROM ranked r, settings s
    WHERE r.n_since_cleaning <= s.reference_cycles
    GROUP BY r.device_id, r.cleaned_at
),
scored AS (
    SELECT r.device_id,
           r.id AS cycle_id,
           r.cycle_no,
           r.started_at,
           r.cleaned_at,
           r.n_since_cleaning,
           r.dp_steady,
           r.t_in_max,
           r.duration_s,
           f.ref_dp,
           f.ref_t_in_max,
           r.n_since_cleaning < s.reference_cycles AS calibrating,
           CASE
               WHEN r.n_since_cleaning < s.reference_cycles THEN NULL
               WHEN abs(f.ref_dp) < s.min_ref_dp_pa THEN NULL
               ELSE (f.ref_dp - r.dp_steady) / abs(f.ref_dp)
           END AS score,
           s.check_soon_score, s.clean_now_score, s.vent_score
    FROM ranked r
    JOIN refs f ON f.device_id = r.device_id AND f.cleaned_at IS NOT DISTINCT FROM r.cleaned_at
    CROSS JOIN settings s
)
SELECT device_id,
       cycle_id,
       cycle_no,
       started_at,
       cleaned_at,
       n_since_cleaning,
       dp_steady,
       t_in_max,
       duration_s,
       ref_dp,
       score,
       CASE
           WHEN calibrating               THEN 'calibrating'
           WHEN score IS NULL             THEN 'no_signal'
           WHEN score >= clean_now_score  THEN 'clean_now'
           WHEN score >= check_soon_score THEN 'check_soon'
           ELSE 'clean'
       END AS status,
       coalesce(score <= vent_score AND t_in_max > ref_t_in_max, false) AS possible_vent_blockage
FROM scored;


CREATE VIEW lint_status AS
WITH last_clean AS (
    SELECT d.device_id, max(e.time) AS cleaned_at
    FROM devices d
    LEFT JOIN events e ON e.device_id = d.device_id AND e.type = 'filter_cleaned'
    GROUP BY d.device_id
),
latest AS (
    SELECT DISTINCT ON (device_id) *
    FROM lint_history
    ORDER BY device_id, started_at DESC
)
SELECT d.device_id,
       lc.cleaned_at                         AS last_cleaned_at,
       coalesce(l.n_since_cleaning, 0)       AS cycles_since_cleaning,
       l.ref_dp,
       l.cycle_id                            AS latest_cycle_id,
       l.started_at                          AS latest_cycle_at,
       l.dp_steady                           AS latest_dp,
       l.t_in_max                            AS latest_t_in_max,
       l.score,
       coalesce(l.status, 'calibrating')     AS status,
       coalesce(l.possible_vent_blockage, false) AS possible_vent_blockage
FROM devices d
JOIN last_clean lc ON lc.device_id = d.device_id
-- only count the latest cycle if it came after the latest cleaning
LEFT JOIN latest l ON l.device_id = d.device_id
                  AND (lc.cleaned_at IS NULL OR l.started_at > lc.cleaned_at);

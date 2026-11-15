/**
 * queries.ts - every SQL query the dashboard runs (server only).
 *
 * What it does:
 *   Small async functions that query the database and return plain objects
 *   shaped like the types in types.ts. API routes call these; pages never write
 *   SQL themselves, so all database access is in this one file.
 *
 * Talks to:
 *   - src/lib/db.ts for the connection pool.
 *   - Tables/views from backend/db/schema.sql and views.sql.
 *   - Used by the API routes in src/app/api/.
 */
import "server-only";

import { getPool } from "./db";
import type { ChartPoint, CycleListItem, CycleSummary, DeviceStatus } from "./types";

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/** Device, its live status, and its most recent cycle. Null if the device doesn't exist. */
export async function getDeviceStatus(deviceId: string): Promise<DeviceStatus | null> {
  const { rows } = await getPool().query(
    `SELECT d.device_id, d.name,
            s.connected, s.last_seen, s.state, s.backlog_count,
            s.sensor_in_error, s.sensor_out_error, s.sensor_error_since, s.updated_at,
            c.id AS cycle_id, c.cycle_no, c.state AS cycle_state,
            c.started_at, c.ended_at, c.n_samples,
            now() AS server_time
       FROM devices d
       LEFT JOIN device_status s ON s.device_id = d.device_id
       LEFT JOIN LATERAL (
            SELECT * FROM cycles WHERE device_id = d.device_id
            ORDER BY started_at DESC LIMIT 1) c ON true
      WHERE d.device_id = $1`,
    [deviceId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    deviceId: r.device_id,
    name: r.name,
    connected: r.connected ?? false,
    lastSeen: iso(r.last_seen),
    boardState: r.state,
    backlogCount: r.backlog_count,
    sensorInError: r.sensor_in_error,
    sensorOutError: r.sensor_out_error,
    sensorErrorSince: iso(r.sensor_error_since),
    latestCycle:
      r.cycle_id == null
        ? null
        : {
            id: Number(r.cycle_id), // bigint arrives as a string from pg
            cycleNo: r.cycle_no,
            state: r.cycle_state,
            startedAt: iso(r.started_at)!,
            endedAt: iso(r.ended_at),
            nSamples: r.n_samples,
          },
    updatedAt: iso(r.updated_at),
    serverTime: iso(r.server_time)!,
  };
}

const num = (v: unknown): number | null => (v == null ? null : Number(v));

/**
 * One cycle's summary. With cycleId = null, the device's most recent cycle
 * (the running one, if a cycle is in progress).
 *
 * offset_pa: the cycle's own pre-cycle baseline ΔP, or else the last idle reading
 * from the 6 hours before it started (same rule as backend features.py).
 */
export async function getCycleSummary(
  deviceId: string,
  cycleId: number | null = null,
): Promise<CycleSummary | null> {
  const { rows } = await getPool().query(
    `SELECT c.id, c.cycle_no, c.state, c.started_at, c.ended_at, c.n_samples, c.n_expected,
            c.time_estimated, c.dp_steady, c.t_in_max, c.duration_s, c.dt_mean,
            c.baseline_at, c.baseline_t_in, c.baseline_t_out,
            COALESCE(c.baseline_dp, (
                SELECT r.dp FROM readings r
                 WHERE r.device_id = c.device_id AND r.kind = 'baseline'
                   AND r.time <= c.started_at AND r.time > c.started_at - interval '6 hours'
                 ORDER BY r.time DESC LIMIT 1)) AS offset_pa,
            h.status AS lint_status, h.score AS lint_score
       FROM cycles c
       LEFT JOIN lint_history h ON h.cycle_id = c.id
      WHERE c.device_id = $1 AND ($2::bigint IS NULL OR c.id = $2)
      ORDER BY c.started_at DESC
      LIMIT 1`,
    [deviceId, cycleId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: Number(r.id),
    cycleNo: r.cycle_no,
    state: r.state,
    startedAt: iso(r.started_at)!,
    endedAt: iso(r.ended_at),
    nSamples: r.n_samples,
    nExpected: r.n_expected,
    timeEstimated: r.time_estimated,
    offsetPa: num(r.offset_pa),
    dpSteady: num(r.dp_steady),
    tInMax: num(r.t_in_max),
    durationS: num(r.duration_s),
    dtMean: num(r.dt_mean),
    baselineAt: iso(r.baseline_at),
    baselineTIn: num(r.baseline_t_in),
    baselineTOut: num(r.baseline_t_out),
    lintStatus: r.lint_status ?? null,
    lintScore: num(r.lint_score),
  };
}

/** The newest `limit` cycles, newest first, each with its lint status at the time. */
export async function getCycles(deviceId: string, limit = 200): Promise<CycleListItem[]> {
  const { rows } = await getPool().query(
    `SELECT c.id, c.cycle_no, c.state, c.started_at, c.ended_at, c.n_samples, c.n_expected,
            c.time_estimated, c.dp_steady, c.t_in_max,
            COALESCE(c.duration_s, EXTRACT(EPOCH FROM (COALESCE(c.ended_at, now()) - c.started_at)))
                AS duration_s,
            h.status AS lint_status, h.score AS lint_score
       FROM cycles c
       LEFT JOIN lint_history h ON h.cycle_id = c.id
      WHERE c.device_id = $1
      ORDER BY c.started_at DESC
      LIMIT $2`,
    [deviceId, limit],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    cycleNo: r.cycle_no,
    state: r.state,
    startedAt: iso(r.started_at)!,
    endedAt: iso(r.ended_at),
    nSamples: r.n_samples,
    nExpected: r.n_expected,
    timeEstimated: r.time_estimated,
    dpSteady: num(r.dp_steady),
    tInMax: num(r.t_in_max),
    durationS: num(r.duration_s),
    lintStatus: r.lint_status ?? null,
    lintScore: num(r.lint_score),
  }));
}

/**
 * A cycle's samples for charting, averaged into at most ~maxPoints time buckets
 * by the database (time_bucket), so a long cycle stays fast on a phone.
 * ΔP has the cycle's sensor offset subtracted when it is known.
 */
export async function getCyclePoints(
  deviceId: string,
  cycle: CycleSummary,
  maxPoints = 500,
): Promise<ChartPoint[]> {
  const { rows } = await getPool().query(
    `WITH span AS (
         SELECT min(time) AS t0, max(time) AS t1 FROM readings
          WHERE device_id = $1 AND kind = 'cycle' AND cycle_no = $2)
     SELECT time_bucket(GREATEST(interval '1 second', (span.t1 - span.t0) / $3::int), r.time) AS t,
            avg(r.dp) AS dp, avg(r.t_in) AS t_in, avg(r.t_out) AS t_out,
            bool_or(r.source = 'flash') AS flash
       FROM readings r, span
      WHERE r.device_id = $1 AND r.kind = 'cycle' AND r.cycle_no = $2
      GROUP BY 1
      ORDER BY 1`,
    [deviceId, cycle.cycleNo, maxPoints],
  );
  const offset = cycle.offsetPa ?? 0;
  return rows.map((r) => ({
    t: (r.t as Date).getTime(),
    dp: Number(r.dp) - offset,
    tIn: Number(r.t_in),
    tOut: Number(r.t_out),
    flash: r.flash,
  }));
}

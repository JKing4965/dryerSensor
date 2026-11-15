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
import type { DeviceStatus } from "./types";

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/** Device, its live status, and its most recent cycle. Null if the device doesn't exist. */
export async function getDeviceStatus(deviceId: string): Promise<DeviceStatus | null> {
  const { rows } = await getPool().query(
    `SELECT d.device_id, d.name,
            s.connected, s.last_seen, s.state, s.backlog_count,
            s.sensor_in_error, s.sensor_out_error, s.sensor_error_since,
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
    serverTime: iso(r.server_time)!,
  };
}

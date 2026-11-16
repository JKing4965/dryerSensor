/**
 * GET /api/status - the board's live status as JSON.
 *
 * What it does:
 *   Returns the device, whether the receiver is connected to it, its state
 *   (idle / running / uploading), sensor error codes, and its latest cycle.
 *   Shape: DeviceStatus in src/lib/types.ts. On failure: { error, detail } with
 *   status 503 (database down) or 404 (device missing).
 *
 * Talks to:
 *   - src/lib/queries.ts -> database (device_status, cycles tables).
 *   - Polled by the Live page (step F2).
 *
 * Try it: http://localhost:3000/api/status
 */
import { connection, NextResponse } from "next/server";

import { isAuthorized, unauthorized } from "@/lib/auth";
import { DEVICE_ID } from "@/lib/db";
import { getDeviceStatus } from "@/lib/queries";
import type { ApiError, DeviceStatus } from "@/lib/types";

export async function GET(): Promise<NextResponse<DeviceStatus | ApiError>> {
  await connection(); // always read fresh data; never pre-build this response
  if (!(await isAuthorized())) return unauthorized();
  try {
    const status = await getDeviceStatus(DEVICE_ID);
    if (!status) {
      return NextResponse.json(
        { error: `Device "${DEVICE_ID}" not found`, detail: "Check DEVICE_ID in frontend/.env.local" },
        { status: 404 },
      );
    }
    return NextResponse.json(status);
  } catch (e) {
    return NextResponse.json(
      {
        error: "Database unavailable",
        detail: `${e instanceof Error ? e.message : e}. Is it running? (docker compose up -d)`,
      },
      { status: 503 },
    );
  }
}

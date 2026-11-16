/**
 * GET /api/live - chart data for the current (or most recent) dryer cycle.
 *
 * What it does:
 *   Returns { cycle, points }: the cycle's summary (CycleSummary) and its samples
 *   averaged into at most ~500 points (ChartPoint[]), with ΔP offset-corrected.
 *   cycle is null (and points empty) before any cycle has been recorded.
 *   On failure: { error, detail } with status 503.
 *
 * Talks to:
 *   - src/lib/queries.ts -> database (cycles, readings).
 *   - Polled every 2 s by src/components/LiveView.tsx.
 *
 * Try it: http://localhost:3000/api/live
 */
import { connection, NextResponse } from "next/server";

import { isAuthorized, unauthorized } from "@/lib/auth";
import { DEVICE_ID } from "@/lib/db";
import { getCyclePoints, getCycleSummary } from "@/lib/queries";
import type { ApiError, LiveData } from "@/lib/types";

export async function GET(): Promise<NextResponse<LiveData | ApiError>> {
  await connection(); // always read fresh data
  if (!(await isAuthorized())) return unauthorized();
  try {
    const cycle = await getCycleSummary(DEVICE_ID);
    const points = cycle ? await getCyclePoints(DEVICE_ID, cycle) : [];
    return NextResponse.json({ cycle, points });
  } catch (e) {
    return NextResponse.json(
      { error: "Database unavailable", detail: e instanceof Error ? e.message : String(e) },
      { status: 503 },
    );
  }
}

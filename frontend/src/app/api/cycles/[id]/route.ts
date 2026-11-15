/**
 * GET /api/cycles/[id] - one cycle's summary and chart data.
 *
 * What it does:
 *   Returns { cycle, points } (CycleDetail in src/lib/types.ts): the cycle's summary,
 *   pre-cycle baseline, features and lint status, plus its samples averaged into
 *   at most ~500 points with ΔP offset-corrected.
 *   [id] is the database id (cycles.id), not the board's cycle number.
 *   404 if there is no such cycle; 503 if the database is down.
 *
 * Talks to:
 *   - src/lib/queries.ts (getCycleSummary, getCyclePoints) -> database.
 *   - Used by the cycle detail page (src/app/cycles/[id]/page.tsx).
 *
 * Try it: http://localhost:3000/api/cycles/1
 */
import { connection, NextResponse } from "next/server";

import { DEVICE_ID } from "@/lib/db";
import { getCyclePoints, getCycleSummary } from "@/lib/queries";
import type { ApiError, CycleDetail } from "@/lib/types";

export async function GET(
  _req: Request,
  ctx: RouteContext<"/api/cycles/[id]">,
): Promise<NextResponse<CycleDetail | ApiError>> {
  await connection(); // always read fresh data
  const id = Number((await ctx.params).id);
  if (!Number.isSafeInteger(id) || id < 1) {
    return NextResponse.json({ error: "Cycle id must be a positive whole number" }, { status: 400 });
  }
  try {
    const cycle = await getCycleSummary(DEVICE_ID, id);
    if (!cycle) return NextResponse.json({ error: `No cycle with id ${id}` }, { status: 404 });
    const points = await getCyclePoints(DEVICE_ID, cycle);
    return NextResponse.json({ cycle, points });
  } catch (e) {
    return NextResponse.json(
      { error: "Database unavailable", detail: e instanceof Error ? e.message : String(e) },
      { status: 503 },
    );
  }
}

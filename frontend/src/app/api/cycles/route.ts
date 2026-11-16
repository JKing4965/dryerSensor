/**
 * GET /api/cycles - list of dryer cycles, newest first.
 *
 * What it does:
 *   Returns CycleListItem[] (src/lib/types.ts): the newest 200 cycles with their
 *   start, length, state, ΔP, max inside temperature and lint status at the time.
 *   Optional ?limit=N (1-1000). On failure: { error, detail } with status 503.
 *
 * Talks to:
 *   - src/lib/queries.ts (getCycles) -> database (cycles + lint_history view).
 *   - Used by the Cycles page (src/app/cycles/page.tsx).
 *
 * Try it: http://localhost:3000/api/cycles
 */
import { connection, NextResponse, type NextRequest } from "next/server";

import { isAuthorized, unauthorized } from "@/lib/auth";
import { DEVICE_ID } from "@/lib/db";
import { getCycles } from "@/lib/queries";
import type { ApiError, CycleListItem } from "@/lib/types";

export async function GET(req: NextRequest): Promise<NextResponse<CycleListItem[] | ApiError>> {
  await connection(); // always read fresh data
  if (!(await isAuthorized())) return unauthorized();
  const limit = Math.min(1000, Math.max(1, Number(req.nextUrl.searchParams.get("limit")) || 200));
  try {
    return NextResponse.json(await getCycles(DEVICE_ID, limit));
  } catch (e) {
    return NextResponse.json(
      { error: "Database unavailable", detail: e instanceof Error ? e.message : String(e) },
      { status: 503 },
    );
  }
}

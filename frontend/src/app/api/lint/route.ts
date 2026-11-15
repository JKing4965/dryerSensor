/**
 * GET /api/lint - the lint verdict, its thresholds and the recent lint trend.
 *
 * What it does:
 *   Returns LintData (src/lib/types.ts):
 *     lint      current verdict (calibrating / no_signal / clean / check_soon / clean_now),
 *               vent warning, last cleaning, cycles since, reference ΔP, latest score
 *     settings  thresholds from the lint_settings table
 *     history   the newest 30 cycles' steady ΔP and verdicts, oldest first
 *   ?history=0 skips the history (used by the reminder banner on every page).
 *   On failure: { error, detail } with status 503.
 *
 * Talks to:
 *   - src/lib/queries.ts (getLintData) -> lint_status / lint_history views, lint_settings.
 *   - Used by the Lint page and src/components/LintReminder.tsx.
 *
 * Try it: http://localhost:3000/api/lint
 */
import { connection, NextResponse, type NextRequest } from "next/server";

import { DEVICE_ID } from "@/lib/db";
import { getLintData } from "@/lib/queries";
import type { ApiError, LintData } from "@/lib/types";

export async function GET(req: NextRequest): Promise<NextResponse<LintData | ApiError>> {
  await connection(); // always read fresh data
  const withHistory = req.nextUrl.searchParams.get("history") !== "0";
  try {
    const data = await getLintData(DEVICE_ID, withHistory ? 30 : 0);
    if (!data) {
      return NextResponse.json({ error: `Device "${DEVICE_ID}" or lint settings not found` }, { status: 404 });
    }
    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json(
      { error: "Database unavailable", detail: e instanceof Error ? e.message : String(e) },
      { status: 503 },
    );
  }
}

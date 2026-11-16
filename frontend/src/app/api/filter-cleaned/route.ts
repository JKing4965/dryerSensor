/**
 * POST /api/filter-cleaned - record "the lint screen was cleaned just now".
 *
 * What it does:
 *   Inserts a 'filter_cleaned' row into the events table. The lint verdict
 *   (backend/db/views.sql) then starts over: "calibrating" until the next cycles
 *   define what a clean filter looks like.
 *   Body (JSON, optional): { "note": "text" } (max 200 characters).
 *   Returns FilterCleanedResult: 201 when recorded; 200 with created=false if a
 *   cleaning was already recorded in the last minute (double-click guard).
 *
 *   Safety: requires login when login is on (401), and only accepts Content-Type
 *   application/json from this dashboard's own origin, so another website open in
 *   the same browser can't trigger it.
 *
 * Talks to:
 *   - src/lib/queries.ts (recordFilterCleaned) -> events table.
 *   - Called by src/components/FilterCleanedButton.tsx.
 */
import { NextResponse, type NextRequest } from "next/server";

import { isAuthorized, rejectForeignPost, unauthorized } from "@/lib/auth";
import { DEVICE_ID } from "@/lib/db";
import { recordFilterCleaned } from "@/lib/queries";
import type { ApiError, FilterCleanedResult } from "@/lib/types";

export async function POST(req: NextRequest): Promise<NextResponse<FilterCleanedResult | ApiError>> {
  if (!(await isAuthorized())) return unauthorized();
  const rejected = rejectForeignPost(req);
  if (rejected) return rejected;

  // An empty or invalid body is fine: the note is optional.
  const body = (await req.json().catch(() => null)) as { note?: unknown } | null;
  const note = typeof body?.note === "string" && body.note.trim() ? body.note.trim().slice(0, 200) : null;

  try {
    const result = await recordFilterCleaned(DEVICE_ID, note);
    return NextResponse.json(result, { status: result.created ? 201 : 200 });
  } catch (e) {
    return NextResponse.json(
      { error: "Database unavailable", detail: e instanceof Error ? e.message : String(e) },
      { status: 503 },
    );
  }
}

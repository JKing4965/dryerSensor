/**
 * POST /api/test-cycle - start or end a test cycle without vibration.
 *
 * What it does:
 *   Body { "action": "start", "minutes": 10 }  -> the board starts a cycle now and ends it
 *                                                  by itself after 10 minutes
 *        { "action": "start", "minutes": 0 }   -> starts a cycle that runs until "stop"
 *        { "action": "stop" }                  -> ends the current cycle now
 *   The request is stored in receiver_control; the standby receiver on the PC sends it
 *   to the board (M,1[,seconds] / M,0, docs/protocol.md section 4) within ~3 s, if the
 *   board is connected. Requests that wait longer than 60 s are dropped as "expired".
 *   Watch the result in GET /api/receiver (test.pending / test.result).
 *   Requires login when login is on; only accepts JSON from this dashboard's origin.
 *   Errors: { error, detail } with 400 / 401 / 403 / 415 / 503.
 *
 * Talks to:
 *   - src/lib/queries.ts (requestTestCycle). Used by src/components/ReceiverControl.tsx.
 *   - backend/src/dryer_backend/remote.py forwards it to the board.
 */
import { NextResponse, type NextRequest } from "next/server";

import { isAuthorized, rejectForeignPost, unauthorized } from "@/lib/auth";
import { DEVICE_ID } from "@/lib/db";
import { requestTestCycle } from "@/lib/queries";
import type { ApiError } from "@/lib/types";

const MAX_MINUTES = 24 * 60; // the firmware accepts up to 86400 s

export async function POST(req: NextRequest): Promise<NextResponse<{ ok: true } | ApiError>> {
  if (!(await isAuthorized())) return unauthorized();
  const rejected = rejectForeignPost(req);
  if (rejected) return rejected;

  const body = (await req.json().catch(() => null)) as { action?: unknown; minutes?: unknown } | null;
  const action = body?.action;
  if (action !== "start" && action !== "stop") {
    return NextResponse.json({ error: 'action must be "start" or "stop"' }, { status: 400 });
  }
  let seconds = 0;
  if (action === "start" && body?.minutes !== undefined) {
    const minutes = Number(body.minutes);
    if (!Number.isFinite(minutes) || minutes < 0 || minutes > MAX_MINUTES) {
      return NextResponse.json({ error: `minutes must be between 0 and ${MAX_MINUTES}` }, { status: 400 });
    }
    seconds = Math.round(minutes * 60);
  }
  try {
    await requestTestCycle(DEVICE_ID, action, seconds);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { error: "Database unavailable", detail: e instanceof Error ? e.message : String(e) },
      { status: 503 },
    );
  }
}

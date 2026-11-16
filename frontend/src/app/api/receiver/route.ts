/**
 * /api/receiver - start or stop the Bluetooth receiver from the dashboard.
 *
 * What it does:
 *   GET   -> ReceiverStatus (controlEnabled, running?, pid, start time, exit code, recent log)
 *   POST  { "action": "start" } -> launches the Python receiver (--source ble)
 *         { "action": "stop" }  -> asks it to stop cleanly (waits up to 10 s)
 *   Only the fixed receiver command can be started; nothing from the request is
 *   passed to it. Requires login when login is on, and only accepts JSON from this
 *   dashboard's own origin.
 *   On Vercel (or with RECEIVER_CONTROL=off) control is off: POST returns 403, and the
 *   Live page shows a status line instead of the button.
 *   Errors: { error, detail } with 400 / 401 / 403 / 415 / 500.
 *
 * Talks to:
 *   - src/lib/receiver.ts (the child process). Used by src/components/ReceiverControl.tsx.
 */
import { connection, NextResponse, type NextRequest } from "next/server";

import { isAuthorized, rejectForeignPost, unauthorized } from "@/lib/auth";
import { controlEnabled, start, status, stop } from "@/lib/receiver";
import type { ApiError, ReceiverStatus } from "@/lib/types";

export async function GET(): Promise<NextResponse<ReceiverStatus | ApiError>> {
  await connection();
  if (!(await isAuthorized())) return unauthorized();
  return NextResponse.json(status());
}

export async function POST(req: NextRequest): Promise<NextResponse<ReceiverStatus | ApiError>> {
  if (!(await isAuthorized())) return unauthorized();
  const rejected = rejectForeignPost(req);
  if (rejected) return rejected;
  if (!controlEnabled()) {
    return NextResponse.json(
      { error: "Receiver control is off here", detail: "The receiver runs on the computer next to the dryer." },
      { status: 403 },
    );
  }
  const body = (await req.json().catch(() => null)) as { action?: unknown } | null;
  try {
    if (body?.action === "start") return NextResponse.json(start());
    if (body?.action === "stop") return NextResponse.json(await stop());
    return NextResponse.json({ error: 'action must be "start" or "stop"' }, { status: 400 });
  } catch (e) {
    return NextResponse.json(
      { error: "Couldn't start the receiver", detail: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}

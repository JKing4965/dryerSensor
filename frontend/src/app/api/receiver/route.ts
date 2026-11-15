/**
 * /api/receiver - start or stop the Bluetooth receiver from the dashboard.
 *
 * What it does:
 *   GET   -> ReceiverStatus (running?, pid, start time, exit code, recent log lines)
 *   POST  { "action": "start" } -> launches the Python receiver (--source ble)
 *         { "action": "stop" }  -> asks it to stop cleanly (waits up to 10 s)
 *   Only the fixed receiver command can be started; nothing from the request is
 *   passed to it. Like /api/filter-cleaned, POST only accepts JSON from this
 *   dashboard's own origin, so another website can't trigger it.
 *   Errors: { error, detail } with 400 / 403 / 415 / 500.
 *
 * Talks to:
 *   - src/lib/receiver.ts (the child process). Used by src/components/ReceiverControl.tsx.
 */
import { connection, NextResponse, type NextRequest } from "next/server";

import { start, status, stop } from "@/lib/receiver";
import type { ApiError, ReceiverStatus } from "@/lib/types";

export async function GET(): Promise<NextResponse<ReceiverStatus>> {
  await connection();
  return NextResponse.json(status());
}

export async function POST(req: NextRequest): Promise<NextResponse<ReceiverStatus | ApiError>> {
  if (!req.headers.get("content-type")?.includes("application/json")) {
    return NextResponse.json({ error: "Send Content-Type: application/json" }, { status: 415 });
  }
  const origin = req.headers.get("origin");
  if (origin && origin !== req.nextUrl.origin) {
    return NextResponse.json({ error: "Requests from other sites are not allowed" }, { status: 403 });
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

/**
 * /api/receiver - the remote Connect / Disconnect button.
 *
 * What it does:
 *   GET  -> ReceiverStatus: what the button last asked for, whether the standby receiver
 *           on the PC is online (heartbeat within 15 s), its state (standby / searching /
 *           connected / offline) and computer name; locally also the receiver this
 *           server started, with its log.
 *   POST { "action": "connect" }    -> receiver_control.desired = connected. On a local
 *                                      dashboard with no standby receiver online, also
 *                                      starts one (src/lib/receiver.ts).
 *        { "action": "disconnect" } -> desired = disconnected (the receiver drops the
 *                                      Bluetooth link and waits).
 *   Works the same on Vercel - the standby receiver picks the change up within ~3 s.
 *   Requires login when login is on; POST only accepts JSON from this dashboard's origin.
 *   Errors: { error, detail } with 400 / 401 / 403 / 415 / 500 / 503.
 *
 * Talks to:
 *   - src/lib/queries.ts (receiver_control), src/lib/receiver.ts (local launcher).
 *   - backend/src/dryer_backend/remote.py reads and heartbeats the same row.
 *   - Used by src/components/ReceiverControl.tsx.
 */
import { connection, NextResponse, type NextRequest } from "next/server";

import { isAuthorized, rejectForeignPost, unauthorized } from "@/lib/auth";
import { DEVICE_ID } from "@/lib/db";
import { getReceiverControl, setReceiverDesired } from "@/lib/queries";
import { canLaunch, isLaunched, launch, launcherStatus } from "@/lib/receiver";
import type { ApiError, ReceiverStatus } from "@/lib/types";

async function currentStatus(): Promise<ReceiverStatus> {
  const control = await getReceiverControl(DEVICE_ID);
  const local = canLaunch();
  return { ...control, canLaunch: local, launcher: local ? launcherStatus() : null };
}

function dbError(e: unknown): NextResponse<ApiError> {
  return NextResponse.json(
    { error: "Database unavailable", detail: e instanceof Error ? e.message : String(e) },
    { status: 503 },
  );
}

export async function GET(): Promise<NextResponse<ReceiverStatus | ApiError>> {
  await connection();
  if (!(await isAuthorized())) return unauthorized();
  try {
    return NextResponse.json(await currentStatus());
  } catch (e) {
    return dbError(e);
  }
}

export async function POST(req: NextRequest): Promise<NextResponse<ReceiverStatus | ApiError>> {
  if (!(await isAuthorized())) return unauthorized();
  const rejected = rejectForeignPost(req);
  if (rejected) return rejected;
  const body = (await req.json().catch(() => null)) as { action?: unknown } | null;
  if (body?.action !== "connect" && body?.action !== "disconnect") {
    return NextResponse.json({ error: 'action must be "connect" or "disconnect"' }, { status: 400 });
  }
  try {
    await setReceiverDesired(DEVICE_ID, body.action === "connect" ? "connected" : "disconnected");
    if (body.action === "connect" && canLaunch() && !isLaunched()) {
      const { online } = await getReceiverControl(DEVICE_ID);
      if (!online) {
        try {
          launch();
        } catch (e) {
          return NextResponse.json(
            { error: "Couldn't start the receiver", detail: e instanceof Error ? e.message : String(e) },
            { status: 500 },
          );
        }
      }
    }
    return NextResponse.json(await currentStatus());
  } catch (e) {
    return dbError(e);
  }
}

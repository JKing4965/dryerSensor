/**
 * POST /api/login - log in to the dashboard with the shared password.
 *
 * What it does:
 *   Body { "password": "..." }. Right password -> sets the HTTP-only login cookie
 *   (30 days) and returns { ok: true }. Wrong password -> 401 after a short pause,
 *   which slows down guessing. If login is turned off (no DASHBOARD_PASSWORD), it
 *   returns { ok: true, loginDisabled: true }.
 *   Only accepts JSON from the dashboard's own origin.
 *
 * Talks to:
 *   - src/lib/auth.ts. Called by src/app/login/page.tsx.
 */
import { NextResponse, type NextRequest } from "next/server";

import { authEnabled, authSecret, checkPassword, rejectForeignPost, sessionCookie } from "@/lib/auth";
import { createToken } from "@/lib/authCore";

export async function POST(req: NextRequest) {
  const rejected = rejectForeignPost(req);
  if (rejected) return rejected;
  if (!authEnabled()) return NextResponse.json({ ok: true, loginDisabled: true });

  const body = (await req.json().catch(() => null)) as { password?: unknown } | null;
  const typed = typeof body?.password === "string" ? body.password : "";
  if (!checkPassword(typed)) {
    await new Promise((r) => setTimeout(r, 600));
    return NextResponse.json({ error: "Wrong password" }, { status: 401 });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(sessionCookie(createToken(authSecret()), req.nextUrl.protocol === "https:"));
  return res;
}

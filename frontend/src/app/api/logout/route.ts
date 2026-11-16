/**
 * POST /api/logout - log out of the dashboard.
 *
 * What it does:
 *   Deletes the login cookie and returns { ok: true }. The browser then goes to /login.
 *   Only accepts JSON from the dashboard's own origin.
 *
 * Talks to:
 *   - src/lib/auth.ts. Called by src/components/LogoutButton.tsx.
 */
import { NextResponse, type NextRequest } from "next/server";

import { clearedCookie, rejectForeignPost } from "@/lib/auth";

export async function POST(req: NextRequest) {
  const rejected = rejectForeignPost(req);
  if (rejected) return rejected;
  const res = NextResponse.json({ ok: true });
  res.cookies.set(clearedCookie(req.nextUrl.protocol === "https:"));
  return res;
}

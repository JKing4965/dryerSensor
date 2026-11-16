/**
 * proxy.ts - the login gate in front of every page (Next.js 16 "Proxy", formerly Middleware).
 *
 * What it does:
 *   When login is on (DASHBOARD_PASSWORD set), every request without a valid login
 *   cookie is stopped here:
 *     - pages        -> redirected to /login?next=<the page they wanted>
 *     - /api/* calls -> 401 { error: "Not logged in" }
 *   /login, /api/login and static files are always allowed.
 *   When login is off, everything passes through unchanged.
 *   This is the first layer; every API route checks the cookie again (Next.js advises
 *   not relying on Proxy alone).
 *
 * Talks to:
 *   - src/lib/auth.ts for the settings and cookie check. Runs on Node.js (Next 16 default).
 */
import { NextResponse, type NextRequest } from "next/server";

import { AUTH_COOKIE, authEnabled, tokenValid } from "@/lib/auth";

const ALWAYS_OPEN = ["/login", "/api/login"];

export function proxy(req: NextRequest) {
  if (!authEnabled()) return NextResponse.next();
  const { pathname, search } = req.nextUrl;
  if (ALWAYS_OPEN.includes(pathname)) return NextResponse.next();
  if (tokenValid(req.cookies.get(AUTH_COOKIE)?.value)) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Not logged in" }, { status: 401 });
  }
  const login = new URL("/login", req.url);
  login.searchParams.set("next", pathname + search);
  return NextResponse.redirect(login);
}

export const config = {
  // everything except Next.js build files and the favicon
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};

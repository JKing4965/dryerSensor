/**
 * auth.ts - dashboard login settings and helpers (server only).
 *
 * What it does:
 *   - authEnabled(): login is ON only when DASHBOARD_PASSWORD is set (Vercel), and
 *     OFF otherwise, so local development and teammates' setups work unchanged.
 *   - isAuthorized(): true if login is off, or the request has a valid login cookie.
 *     Every API route calls it (second layer behind src/proxy.ts).
 *   - sessionCookie() / clearedCookie(): what /api/login and /api/logout set.
 *
 * Settings (frontend/.env.local locally, Vercel project settings when deployed):
 *   DASHBOARD_PASSWORD  the shared password (unset = no login)
 *   AUTH_SECRET         long random string that signs the cookie. If unset, a key
 *                       derived from the password is used, so changing the password
 *                       logs everyone out. Changing AUTH_SECRET also logs everyone out.
 *
 * Talks to:
 *   - src/lib/authCore.ts (token + password logic), src/proxy.ts, src/app/api/*.
 */
import "server-only";

import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { passwordMatches, SESSION_DAYS, verifyToken } from "./authCore";
import type { ApiError } from "./types";

export const AUTH_COOKIE = "dryer_session";

export function authEnabled(): boolean {
  return Boolean(process.env.DASHBOARD_PASSWORD);
}

export function authSecret(): string {
  return process.env.AUTH_SECRET || `derived-from-password:${process.env.DASHBOARD_PASSWORD ?? ""}`;
}

export function checkPassword(typed: string): boolean {
  const configured = process.env.DASHBOARD_PASSWORD;
  return Boolean(configured) && passwordMatches(typed, configured!);
}

export function tokenValid(token: string | undefined): boolean {
  return verifyToken(authSecret(), token);
}

/** For route handlers: true if login is off or the request carries a valid cookie. */
export async function isAuthorized(): Promise<boolean> {
  if (!authEnabled()) return true;
  return tokenValid((await cookies()).get(AUTH_COOKIE)?.value);
}

export function unauthorized(): NextResponse<ApiError> {
  return NextResponse.json({ error: "Not logged in" }, { status: 401 });
}

export function sessionCookie(token: string, secure: boolean) {
  return {
    name: AUTH_COOKIE,
    value: token,
    httpOnly: true,
    secure,
    sameSite: "lax" as const,
    path: "/",
    maxAge: SESSION_DAYS * 24 * 3600,
  };
}

export function clearedCookie(secure: boolean) {
  return { ...sessionCookie("", secure), maxAge: 0 };
}

/** Same-origin JSON check shared by every POST route (blocks other websites). */
export function rejectForeignPost(req: Request & { nextUrl: URL }): NextResponse<ApiError> | null {
  if (!req.headers.get("content-type")?.includes("application/json")) {
    return NextResponse.json({ error: "Send Content-Type: application/json" }, { status: 415 });
  }
  const origin = req.headers.get("origin");
  if (origin && origin !== req.nextUrl.origin) {
    return NextResponse.json({ error: "Requests from other sites are not allowed" }, { status: 403 });
  }
  return null;
}

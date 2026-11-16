/**
 * authCore.ts - the security logic behind the dashboard login, with no Next.js imports.
 *
 * What it does:
 *   - createToken() / verifyToken(): the login cookie's value. It is
 *     "<expiry unix seconds>.<HMAC-SHA256 signature>", so it can't be forged or
 *     extended without the secret, and it stops working after 30 days.
 *   - passwordMatches(): compares a typed password with the configured one in
 *     constant time (no timing hints about how many characters were right).
 *   Kept free of Next.js imports so it can be tested with Node's own test runner.
 *
 * Talks to:
 *   - Used by src/lib/auth.ts (settings, cookies) and src/proxy.ts.
 *   - Tested by src/lib/authCore.test.ts (npm test).
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_DAYS = 30;
const TOKEN_VERSION = "v1";

function sign(secret: string, expiresUnix: number): string {
  return createHmac("sha256", secret).update(`${TOKEN_VERSION}.${expiresUnix}`).digest("hex");
}

/** A new cookie value valid for SESSION_DAYS from `nowMs`. */
export function createToken(secret: string, nowMs: number = Date.now()): string {
  const expires = Math.floor(nowMs / 1000) + SESSION_DAYS * 24 * 3600;
  return `${expires}.${sign(secret, expires)}`;
}

/** True if the cookie value was made with this secret and hasn't expired. */
export function verifyToken(secret: string, token: string | undefined | null, nowMs: number = Date.now()): boolean {
  if (!token) return false;
  const dot = token.indexOf(".");
  if (dot <= 0) return false;
  const expires = Number(token.slice(0, dot));
  const given = token.slice(dot + 1);
  if (!Number.isSafeInteger(expires) || expires * 1000 <= nowMs) return false;
  const expected = sign(secret, expires);
  if (given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

/** Constant-time password check (hashing first makes both sides the same length). */
export function passwordMatches(typed: string, configured: string): boolean {
  const a = createHash("sha256").update(typed, "utf8").digest();
  const b = createHash("sha256").update(configured, "utf8").digest();
  return timingSafeEqual(a, b);
}

/**
 * authCore.test.ts - tests for the login cookie and password check (src/lib/authCore.ts).
 *
 * What it checks:
 *   - a fresh token is accepted; tampered, wrong-secret, expired and garbage tokens are not
 *   - the token expires after SESSION_DAYS
 *   - password comparison accepts only the exact password (case, length, empty)
 *
 * How to run (from frontend/; needs Node 22.18 or newer for TypeScript files):
 *   npm test
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { createToken, passwordMatches, SESSION_DAYS, verifyToken } from "./authCore.ts";

const SECRET = "test-secret-123";
const NOW = Date.UTC(2026, 10, 16, 12, 0, 0);
const DAY_MS = 24 * 3600 * 1000;

test("fresh token is valid", () => {
  assert.equal(verifyToken(SECRET, createToken(SECRET, NOW), NOW), true);
});

test("token from another secret is rejected", () => {
  assert.equal(verifyToken(SECRET, createToken("other-secret", NOW), NOW), false);
});

test("tampered expiry or signature is rejected", () => {
  const token = createToken(SECRET, NOW);
  const [expires, sig] = token.split(".");
  assert.equal(verifyToken(SECRET, `${Number(expires) + 999999}.${sig}`, NOW), false);
  const flipped = sig.slice(0, -1) + (sig.endsWith("0") ? "1" : "0");
  assert.equal(verifyToken(SECRET, `${expires}.${flipped}`, NOW), false);
});

test("token expires after SESSION_DAYS", () => {
  const token = createToken(SECRET, NOW);
  assert.equal(verifyToken(SECRET, token, NOW + (SESSION_DAYS - 1) * DAY_MS), true);
  assert.equal(verifyToken(SECRET, token, NOW + SESSION_DAYS * DAY_MS + 1000), false);
});

test("garbage and missing tokens are rejected", () => {
  for (const t of [undefined, null, "", ".", "abc", "123.", ".abc", "1e9.zz", "NaN.abc"]) {
    assert.equal(verifyToken(SECRET, t, NOW), false, String(t));
  }
});

test("password must match exactly", () => {
  assert.equal(passwordMatches("Lint-Screen-42", "Lint-Screen-42"), true);
  assert.equal(passwordMatches("lint-screen-42", "Lint-Screen-42"), false);
  assert.equal(passwordMatches("Lint-Screen-4", "Lint-Screen-42"), false);
  assert.equal(passwordMatches("", "Lint-Screen-42"), false);
});

/**
 * LogoutButton.tsx - the "Log out" link in the header.
 *
 * What it does:
 *   Calls POST /api/logout (deletes the login cookie), then goes to /login.
 *   Only shown when login is on (src/app/layout.tsx decides).
 *
 * Talks to:
 *   - POST /api/logout (src/app/api/logout/route.ts).
 */
"use client";

export default function LogoutButton() {
  async function logout() {
    await fetch("/api/logout", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    // Full page load on purpose: drops every component's cached data along with the login.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.assign("/login");
  }
  return (
    <button type="button" onClick={logout} className="text-sm text-muted underline-offset-2 hover:underline">
      Log out
    </button>
  );
}

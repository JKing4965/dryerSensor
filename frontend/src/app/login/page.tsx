/**
 * login/page.tsx - the login page ("/login").
 *
 * What it does:
 *   A password form. On the right password, /api/login sets the login cookie and the
 *   browser goes back to the page it came from (the ?next= value, default "/").
 *   src/proxy.ts sends anyone without a valid cookie here when login is on.
 *   A browser component; it reads ?next= from the address bar when submitting.
 *
 * Talks to:
 *   - POST /api/login (src/app/api/login/route.ts).
 */
"use client";

import { useState, type FormEvent } from "react";

/** Only same-site paths, so ?next= can't send someone to another website. */
function safeNext(): string {
  const next = new URLSearchParams(window.location.search).get("next") ?? "/";
  return next.startsWith("/") && !next.startsWith("//") ? next : "/";
}

export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? res.statusText);
      }
      window.location.assign(safeNext()); // full load so every component starts logged in
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <section className="mx-auto max-w-sm space-y-4 pt-8">
      <h2 className="text-lg font-semibold">Log in</h2>
      <form onSubmit={submit} className="space-y-3 rounded-lg border border-border bg-card p-4">
        <label className="block text-sm">
          <span className="text-muted">Dashboard password</span>
          <input
            type="password"
            autoComplete="current-password"
            autoFocus
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 block w-full rounded-md border border-border bg-background px-3 py-2"
          />
        </label>
        <button
          type="submit"
          disabled={busy || !password}
          className="w-full rounded-md bg-accent px-4 py-2.5 font-medium text-white disabled:opacity-60"
        >
          {busy ? "Checking…" : "Log in"}
        </button>
        {error && (
          <p role="alert" className="text-sm text-bad">
            {error}
          </p>
        )}
      </form>
    </section>
  );
}

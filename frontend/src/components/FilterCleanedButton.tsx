/**
 * FilterCleanedButton.tsx - the "Filter cleaned" button (with a confirm step).
 *
 * What it does:
 *   1st press: asks "Mark the lint screen as cleaned now?" with Yes / Cancel.
 *   Yes: sends POST /api/filter-cleaned, disables itself while saving (so a
 *   double-click can't send twice), shows the result, then refreshes every
 *   polling component on the page so the verdict and the reminder banner update.
 *   The server also ignores a second press within one minute.
 *
 * Talks to:
 *   - POST /api/filter-cleaned (src/app/api/filter-cleaned/route.ts)
 *   - refreshAll() from src/lib/usePolling.ts
 */
"use client";

import { useState } from "react";

import type { FilterCleanedResult } from "@/lib/types";
import { refreshAll } from "@/lib/usePolling";

type Phase = "idle" | "confirm" | "saving" | "done" | "error";

export default function FilterCleanedButton() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState<string | null>(null);

  async function save() {
    if (phase === "saving") return;
    setPhase("saving");
    try {
      const res = await fetch("/api/filter-cleaned", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? res.statusText);
      const r = body as FilterCleanedResult;
      setMessage(
        r.created
          ? `Saved at ${new Date(r.time).toLocaleTimeString()}. The next cycles become the new "clean" reference.`
          : `Already recorded at ${new Date(r.time).toLocaleTimeString()}.`,
      );
      setPhase("done");
      refreshAll();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  }

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      {phase === "confirm" || phase === "saving" ? (
        <div className="space-y-3">
          <p className="font-medium">Mark the lint screen as cleaned now?</p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={save}
              disabled={phase === "saving"}
              className="flex-1 rounded-md bg-accent px-4 py-2.5 font-medium text-white disabled:opacity-60 sm:flex-none"
            >
              {phase === "saving" ? "Saving…" : "Yes, I cleaned it"}
            </button>
            <button
              type="button"
              onClick={() => setPhase("idle")}
              disabled={phase === "saving"}
              className="flex-1 rounded-md border border-border px-4 py-2.5 font-medium sm:flex-none"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted">Just cleaned the lint screen? Record it so the monitor starts fresh.</p>
          <button
            type="button"
            onClick={() => {
              setMessage(null);
              setPhase("confirm");
            }}
            className="w-full rounded-md bg-accent px-4 py-2.5 font-medium text-white sm:w-auto"
          >
            Filter cleaned
          </button>
        </div>
      )}
      {message && (
        <p role="status" className={`mt-3 text-sm ${phase === "error" ? "text-bad" : "text-ok"}`}>
          {phase === "error" ? `Couldn't save: ${message}` : `✓ ${message}`}
        </p>
      )}
    </div>
  );
}

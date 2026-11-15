/**
 * LintReminder.tsx - the reminder banner shown at the top of EVERY page.
 *
 * What it does:
 *   Polls /api/lint?history=0 every 30 s. While the verdict is "check soon" or
 *   "clean now", or the exhaust duct looks blocked, shows a banner with a link to
 *   the Lint page. Otherwise renders nothing. Pressing "Filter cleaned" refreshes
 *   it right away (refreshAll in usePolling.ts), so it disappears immediately.
 *
 * Talks to:
 *   - GET /api/lint; wording from src/lib/lint.ts. Placed in src/app/layout.tsx.
 */
"use client";

import Link from "next/link";

import { LINT } from "@/components/Chips";
import { lintAdvice, needsReminder, VENT_ADVICE } from "@/lib/lint";
import type { LintData } from "@/lib/types";
import { usePolling } from "@/lib/usePolling";

export default function LintReminder() {
  const { data } = usePolling<LintData>("/api/lint?history=0", 30_000);
  if (!data || !needsReminder(data.lint)) return null;

  const { lint, settings } = data;
  const lintIssue = lint.status === "check_soon" || lint.status === "clean_now";
  const severe = lint.status === "clean_now" || lint.possibleVentBlockage;
  const chip = LINT[lint.status];

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pt-4">
      <div
        role="alert"
        className={`flex flex-wrap items-center justify-between gap-2 rounded-lg border-2 p-3 text-sm ${
          severe ? "border-bad/60 bg-bad/10" : "border-warn/60 bg-warn/10"
        }`}
      >
        <div>
          {lintIssue && (
            <p className="font-semibold">
              <span aria-hidden="true">{chip.icon}</span> {lintAdvice(lint, settings).headline}
            </p>
          )}
          {lint.possibleVentBlockage && (
            <p className={lintIssue ? "mt-1" : "font-semibold"}>
              <span aria-hidden="true">⚠</span> {VENT_ADVICE}
            </p>
          )}
        </div>
        <Link href="/lint" className="whitespace-nowrap font-medium text-accent underline-offset-2 hover:underline">
          Lint details →
        </Link>
      </div>
    </div>
  );
}

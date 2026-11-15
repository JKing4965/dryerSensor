/**
 * lint/page.tsx - the Lint page ("/lint"): lint verdict, trend and "Filter cleaned".
 *
 * What it does:
 *   Polls /api/lint every 10 s and shows:
 *     - LintStatusCard: verdict + advice + details, and the exhaust-duct warning
 *     - FilterCleanedButton: records a cleaning (with a confirm step)
 *     - LintTrendChart: steady ΔP of recent cycles with cleanings and threshold lines
 *     - a short "how it works" note with the current thresholds
 *   A browser component (it refreshes itself).
 *
 * Talks to:
 *   - GET /api/lint via src/lib/usePolling.ts; the components above.
 */
"use client";

import FilterCleanedButton from "@/components/FilterCleanedButton";
import LintStatusCard from "@/components/LintStatusCard";
import LintTrendChart from "@/components/LintTrendChart";
import { Card, ErrorBox } from "@/components/ui";
import type { LintData } from "@/lib/types";
import { usePolling } from "@/lib/usePolling";

export default function LintPage() {
  const { data, error, loading } = usePolling<LintData>("/api/lint", 10_000);
  const pct = (x: number) => `${Math.round(x * 100)}%`;

  return (
    <section className="space-y-4">
      <h2 className="text-lg font-semibold">Lint</h2>
      {error && !data && <ErrorBox title="Can't load the lint status" detail={error} />}
      {loading && <Card>Loading…</Card>}
      {data && (
        <>
          <LintStatusCard lint={data.lint} settings={data.settings} />
          <FilterCleanedButton />
          <Card>
            <h3 className="text-sm font-semibold">Steady ΔP per cycle</h3>
            <p className="mb-2 text-xs text-muted">
              Lower = the blower has to pull harder through the screen = more lint. Latest {data.history.length}{" "}
              cycles.
            </p>
            <LintTrendChart data={data} />
          </Card>
          <details className="rounded-lg border border-border bg-card p-3 text-sm">
            <summary className="cursor-pointer font-medium">How the verdict works</summary>
            <p className="mt-2 text-muted">
              After each cleaning, the first {data.settings.referenceCycles} cycles set the &quot;clean&quot;
              reference ΔP. Each later cycle is compared with it: {pct(data.settings.checkSoonScore)} more suction
              means <em>check soon</em>, {pct(data.settings.cleanNowScore)} means <em>clean now</em>. If ΔP instead
              moves {pct(-data.settings.ventScore)} toward zero while the dryer runs hotter, the exhaust duct is
              probably blocked. Thresholds live in the database table <code>lint_settings</code>.
            </p>
          </details>
        </>
      )}
    </section>
  );
}

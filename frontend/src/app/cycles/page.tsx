/**
 * cycles/page.tsx - the Cycles page ("/cycles"): history of dryer cycles.
 *
 * What it does:
 *   Polls /api/cycles every 10 s and shows a count summary plus CycleTable.
 *   Clicking a cycle's start time opens /cycles/[id] with its full charts.
 *   A browser component (it refreshes itself).
 *
 * Talks to:
 *   - GET /api/cycles via src/lib/usePolling.ts; CycleTable.tsx for the table.
 */
"use client";

import CycleTable from "@/components/CycleTable";
import { Card, ErrorBox } from "@/components/ui";
import type { CycleListItem } from "@/lib/types";
import { usePolling } from "@/lib/usePolling";

export default function CyclesPage() {
  const { data, error, loading } = usePolling<CycleListItem[]>("/api/cycles", 10_000);
  const incomplete = data?.filter((c) => c.state === "incomplete").length ?? 0;
  const running = data?.some((c) => c.state === "running");

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold">Cycles</h2>
        {data && data.length > 0 && (
          <p className="text-sm text-muted">
            {data.length} cycle{data.length === 1 ? "" : "s"}
            {running && " · 1 running"}
            {incomplete > 0 && ` · ${incomplete} incomplete`}
          </p>
        )}
      </div>
      {error && <ErrorBox title="Can't load cycles" detail={error} />}
      {loading && <Card>Loading…</Card>}
      {data && data.length === 0 && <Card>No dryer cycles recorded yet.</Card>}
      {data && data.length > 0 && <CycleTable cycles={data} />}
      {incomplete > 0 && (
        <p className="text-xs text-muted">
          Incomplete = the board never sent the cycle&apos;s end signal (for example it lost power), so the cycle is
          left out of the lint verdict.
        </p>
      )}
    </section>
  );
}

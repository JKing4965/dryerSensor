/**
 * CycleDetailView.tsx - everything on one cycle's page ("/cycles/12").
 *
 * What it does:
 *   Shows the cycle's state and lint verdict, its numbers (steady ΔP, hottest inside
 *   temperature, average temperature rise, length, samples), the idle reading taken
 *   just before it started (sensor offset), and its full ΔP / temperature charts.
 *   Refreshes every 5 s, so a running cycle keeps growing.
 *   [id] is the database id (cycles.id) used in links from the Cycles table.
 *
 * Talks to:
 *   - Rendered by src/app/cycles/[id]/page.tsx inside <Suspense>, because it reads
 *     the cycle id from the URL (useParams).
 *   - GET /api/cycles/[id] via src/lib/usePolling.ts
 *   - CycleCharts, Chips and ui components
 */
"use client";

import Link from "next/link";
import { useParams } from "next/navigation";

import { CycleStateChip, LintChip } from "@/components/Chips";
import CycleCharts from "@/components/CycleCharts";
import { Card, ErrorBox, Note, Stat } from "@/components/ui";
import { dateTime, degC, duration, pa } from "@/lib/format";
import type { CycleDetail, CycleSummary } from "@/lib/types";
import { usePolling } from "@/lib/usePolling";

export default function CycleDetailView() {
  const { id } = useParams<{ id: string }>();
  const { data, error, loading } = usePolling<CycleDetail>(`/api/cycles/${encodeURIComponent(id)}`, 5000);

  return (
    <section className="space-y-4">
      <Link href="/cycles" className="text-sm text-accent underline-offset-2 hover:underline">
        ← All cycles
      </Link>
      {error && !data && <ErrorBox title="Can't load this cycle" detail={error} />}
      {loading && <Card>Loading…</Card>}
      {data && <CycleBody cycle={data.cycle} points={data.points} />}
    </section>
  );
}

function CycleBody({ cycle, points }: CycleDetail) {
  const end = cycle.endedAt ? Date.parse(cycle.endedAt) : (points.at(-1)?.t ?? null);
  const lengthMs = cycle.durationS !== null ? cycle.durationS * 1000 : end && end - Date.parse(cycle.startedAt);
  const missing = cycle.nExpected != null ? cycle.nExpected - cycle.nSamples : 0;

  return (
    <>
      <div className="space-y-1">
        <h2 className="flex flex-wrap items-center gap-2 text-lg font-semibold">
          Cycle #{cycle.cycleNo}
          <CycleStateChip state={cycle.state} />
          <LintChip status={cycle.lintStatus} />
        </h2>
        <p className="text-sm text-muted">
          {dateTime(cycle.startedAt)}
          {cycle.endedAt ? ` – ${dateTime(cycle.endedAt)}` : " – still running"}
        </p>
      </div>

      {cycle.state === "incomplete" && (
        <Note>
          The board never sent this cycle&apos;s end signal (for example it lost power), so it isn&apos;t used for
          the lint verdict.
        </Note>
      )}
      {missing > 0 && (
        <Note>
          {missing} of {cycle.nExpected} samples never arrived, so the charts have gaps.
        </Note>
      )}
      {cycle.timeEstimated && (
        <Note>Times for this cycle are estimates: the board restarted before it could upload it.</Note>
      )}

      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Stat
          label="ΔP steady"
          value={pa(cycle.dpSteady)}
          hint={cycle.lintScore != null ? `${scoreText(cycle.lintScore)} vs. clean filter` : undefined}
        />
        <Stat label="Max inside temp" value={degC(cycle.tInMax)} />
        <Stat label="Avg inside − outside" value={degC(cycle.dtMean)} />
        <Stat label="Length" value={duration(lengthMs ?? null)} />
        <Stat label="Samples" value={`${cycle.nSamples}${cycle.nExpected ? ` / ${cycle.nExpected}` : ""}`} />
      </dl>

      <Baseline cycle={cycle} />
      <CycleCharts points={points} tableRows={60} />
    </>
  );
}

function Baseline({ cycle }: { cycle: CycleSummary }) {
  return (
    <Card>
      <h3 className="text-sm font-semibold">Before the cycle started</h3>
      {cycle.baselineAt ? (
        <p className="mt-1 text-sm">
          Idle reading at {dateTime(cycle.baselineAt)}: inside {degC(cycle.baselineTIn)}, outside{" "}
          {degC(cycle.baselineTOut)}, sensor offset {pa(cycle.offsetPa)} (subtracted from ΔP).
        </p>
      ) : cycle.offsetPa !== null ? (
        <p className="mt-1 text-sm">
          The board had no idle reading of its own; the last one before the cycle gave a sensor offset of{" "}
          {pa(cycle.offsetPa)}.
        </p>
      ) : (
        <p className="mt-1 text-sm text-muted">
          No idle reading before this cycle, so ΔP still includes the small offset between the sensors.
        </p>
      )}
    </Card>
  );
}

/** 0.24 -> "24% more suction", -0.3 -> "30% less suction" */
function scoreText(score: number): string {
  const pct = Math.round(Math.abs(score) * 100);
  return score >= 0 ? `${pct}% more suction` : `${pct}% less suction`;
}

/**
 * LiveView.tsx - everything on the Live page, refreshed every 2 seconds.
 *
 * What it does:
 *   Polls /api/status and /api/live and shows:
 *     - the "Connect to sensor" card (ReceiverControl), which starts/stops the receiver
 *     - the connection badge (StatusBadge) and any sensor problem (SensorErrorBanner)
 *     - the current cycle (or the most recent one): number, state, start, length,
 *       with a link to its detail page
 *     - the latest ΔP / inside / outside temperature values
 *     - the cycle's ΔP and temperature charts and data table (CycleCharts)
 *
 * Talks to:
 *   - GET /api/status, GET /api/live (src/app/api/), via src/lib/usePolling.ts
 *   - StatusBadge, SensorErrorBanner, CycleCharts, Chips, ui components
 */
"use client";

import Link from "next/link";

import { CycleStateChip } from "@/components/Chips";
import CycleCharts from "@/components/CycleCharts";
import ReceiverControl from "@/components/ReceiverControl";
import SensorErrorBanner from "@/components/SensorErrorBanner";
import StatusBadge from "@/components/StatusBadge";
import { Card, ErrorBox, Note, Stat } from "@/components/ui";
import { dateTime, degC, duration, pa } from "@/lib/format";
import type { ChartPoint, CycleSummary, DeviceStatus, LiveData } from "@/lib/types";
import { usePolling } from "@/lib/usePolling";

const POLL_MS = 2000;

export default function LiveView() {
  const status = usePolling<DeviceStatus>("/api/status", POLL_MS);
  const live = usePolling<LiveData>("/api/live", POLL_MS);

  if (status.loading && live.loading) return <Card>Loading…</Card>;
  const error = status.error ?? live.error;

  return (
    <div className="space-y-4">
      <ReceiverControl device={status.data} />
      {error && <ErrorBox title="Can't load live data" detail={error} />}
      {status.data && (
        <>
          <StatusBadge status={status.data} />
          <SensorErrorBanner status={status.data} />
        </>
      )}
      {live.data &&
        (live.data.cycle ? (
          <CyclePanel cycle={live.data.cycle} points={live.data.points} />
        ) : (
          <Card>
            <p className="font-medium">No dryer cycles recorded yet.</p>
            <p className="mt-1 text-sm text-muted">
              Start the receiver (from <code>backend/</code>):{" "}
              <code>uv run python -m dryer_backend.ingest --source ble</code>, or try the simulator with{" "}
              <code>--source sim</code>.
            </p>
          </Card>
        ))}
    </div>
  );
}

function CyclePanel({ cycle, points }: { cycle: CycleSummary; points: ChartPoint[] }) {
  const last = points.at(-1);
  const start = Date.parse(cycle.startedAt);
  const end = cycle.endedAt ? Date.parse(cycle.endedAt) : (last?.t ?? start);
  const running = cycle.state === "running";

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-base font-semibold">
          {running ? "Current cycle" : "Most recent cycle"}
          <Link href={`/cycles/${cycle.id}`} className="text-accent underline-offset-2 hover:underline">
            #{cycle.cycleNo}
          </Link>
          <CycleStateChip state={cycle.state} />
        </h3>
        <p className="text-sm text-muted">
          started {dateTime(cycle.startedAt)} · {duration(end - start)}
        </p>
      </div>

      {cycle.timeEstimated && (
        <Note>Times for this cycle are estimates: the board restarted before it could upload it.</Note>
      )}
      {cycle.offsetPa === null && (
        <Note>No idle reading before this cycle, so ΔP includes the small offset between the two sensors.</Note>
      )}

      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="ΔP now" value={pa(last?.dp)} />
        <Stat label="Inside temp" value={degC(last?.tIn)} />
        <Stat label="Outside temp" value={degC(last?.tOut)} />
        <Stat label="Samples" value={`${cycle.nSamples}${cycle.nExpected ? ` / ${cycle.nExpected}` : ""}`} />
      </dl>

      <CycleCharts points={points} />
    </section>
  );
}

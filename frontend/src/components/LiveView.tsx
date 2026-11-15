/**
 * LiveView.tsx - everything on the Live page, refreshed every 2 seconds.
 *
 * What it does:
 *   Polls /api/status and /api/live and shows:
 *     - the connection badge (StatusBadge) and any sensor problem (SensorErrorBanner)
 *     - the current cycle (or the most recent one): number, state, start, length
 *     - the latest ΔP / inside / outside temperature values
 *     - a ΔP chart (offset-corrected) and an inside-vs-outside temperature chart.
 *       Data uploaded later from the board's memory is drawn DASHED.
 *     - a data table under "Show data" for anyone who can't read the charts
 *
 * Talks to:
 *   - GET /api/status, GET /api/live (src/app/api/), via src/lib/usePolling.ts
 *   - StatusBadge, SensorErrorBanner, TimeSeriesChart components
 */
"use client";

import type { ReactNode } from "react";

import SensorErrorBanner from "@/components/SensorErrorBanner";
import StatusBadge from "@/components/StatusBadge";
import TimeSeriesChart, { type Row } from "@/components/TimeSeriesChart";
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
      {error && (
        <div role="alert" className="rounded-lg border border-bad/50 bg-bad/10 p-3 text-sm">
          <p className="font-semibold text-bad">Can&apos;t load live data</p>
          <p className="mt-1 break-words text-muted">{error}</p>
        </div>
      )}
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
  const anyFlash = points.some((p) => p.flash);

  const dpRows = splitByFlash(points);
  const tempRows: Row[] = points.map((p) => ({ t: p.t, tIn: p.tIn, tOut: p.tOut }));

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-base font-semibold">
          {running ? "Current cycle" : "Most recent cycle"} #{cycle.cycleNo}
        </h3>
        <p className="text-sm text-muted">
          {cycle.state} · started {new Date(start).toLocaleString()} · {minutes(end - start)}
        </p>
      </div>

      {cycle.timeEstimated && (
        <Note>Times for this cycle are estimates: the board restarted before it could upload it.</Note>
      )}
      {cycle.offsetPa === null && (
        <Note>No idle reading before this cycle, so ΔP includes the small offset between the two sensors.</Note>
      )}

      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="ΔP now" value={last ? `${last.dp.toFixed(1)} Pa` : "—"} />
        <Stat label="Inside temp" value={last ? `${last.tIn.toFixed(1)} °C` : "—"} />
        <Stat label="Outside temp" value={last ? `${last.tOut.toFixed(1)} °C` : "—"} />
        <Stat label="Samples" value={`${cycle.nSamples}${cycle.nExpected ? ` / ${cycle.nExpected}` : ""}`} />
      </dl>

      {points.length === 0 ? (
        <Card>No samples for this cycle yet.</Card>
      ) : (
        <>
          <Card>
            <h4 className="text-sm font-semibold">Pressure difference under the lint screen (ΔP)</h4>
            <p className="mb-2 text-xs text-muted">
              Inside minus outside, sensor offset removed. More negative = harder to pull air through the screen.
              {anyFlash && " Dashed = uploaded later from the board's memory."}
            </p>
            <TimeSeriesChart
              ariaLabel="Pressure difference over time"
              data={dpRows}
              unit="Pa"
              series={[
                { key: "dp", label: "ΔP", color: "var(--series-1)" },
                { key: "dpFlash", label: "ΔP", color: "var(--series-1)", dashed: true, hidden: true },
              ]}
            />
          </Card>
          <Card>
            <h4 className="mb-2 text-sm font-semibold">Temperature</h4>
            <TimeSeriesChart
              ariaLabel="Inside and outside temperature over time"
              data={tempRows}
              unit="°C"
              series={[
                { key: "tIn", label: "Inside", color: "var(--series-2)" },
                { key: "tOut", label: "Outside", color: "var(--series-1)" },
              ]}
            />
          </Card>
          <DataTable points={points} />
        </>
      )}
    </section>
  );
}

/**
 * Two keys so live and flash parts can be drawn solid and dashed. Each boundary
 * point goes into both, so the line has no gap where the style changes.
 */
function splitByFlash(points: ChartPoint[]): Row[] {
  return points.map((p, i) => {
    const next = points[i + 1];
    const inLive = !p.flash || (next !== undefined && !next.flash);
    const inFlash = p.flash || (next !== undefined && next.flash);
    return { t: p.t, dp: inLive ? p.dp : null, dpFlash: inFlash ? p.dp : null };
  });
}

function DataTable({ points }: { points: ChartPoint[] }) {
  const rows = points.slice(-30).reverse();
  return (
    <details className="rounded-lg border border-border bg-card p-3 text-sm">
      <summary className="cursor-pointer font-medium">Show data (latest {rows.length} points)</summary>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full text-right tabular-nums">
          <thead className="text-xs text-muted">
            <tr>
              <th className="py-1 text-left font-medium">Time</th>
              <th className="py-1 font-medium">ΔP (Pa)</th>
              <th className="py-1 font-medium">Inside (°C)</th>
              <th className="py-1 font-medium">Outside (°C)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.t} className="border-t border-border">
                <td className="py-1 text-left">
                  {new Date(p.t).toLocaleTimeString()}
                  {p.flash && <span className="text-muted"> (saved)</span>}
                </td>
                <td className="py-1">{p.dp.toFixed(1)}</td>
                <td className="py-1">{p.tIn.toFixed(1)}</td>
                <td className="py-1">{p.tOut.toFixed(1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function minutes(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60000));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="text-lg font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

function Note({ children }: { children: ReactNode }) {
  return <p className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-sm">{children}</p>;
}

function Card({ children }: { children: ReactNode }) {
  return <div className="rounded-lg border border-border bg-card p-4">{children}</div>;
}

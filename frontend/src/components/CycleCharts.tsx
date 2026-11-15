/**
 * CycleCharts.tsx - the ΔP chart, temperature chart and data table for one cycle.
 *
 * What it does:
 *   Takes a cycle's chart points (from /api/live or /api/cycles/[id]) and draws:
 *     - ΔP under the lint screen (offset-corrected). Parts uploaded later from the
 *       board's memory are DASHED, live parts solid.
 *     - inside vs outside temperature
 *     - "Show data" table with the latest points, for anyone who can't read charts
 *   A browser component (charts are interactive).
 *
 * Talks to:
 *   - TimeSeriesChart.tsx for drawing. Used by LiveView.tsx and the cycle detail page.
 */
"use client";

import TimeSeriesChart, { type Row } from "@/components/TimeSeriesChart";
import { Card } from "@/components/ui";
import type { ChartPoint } from "@/lib/types";

export default function CycleCharts({ points, tableRows = 30 }: { points: ChartPoint[]; tableRows?: number }) {
  if (points.length === 0) return <Card>No samples for this cycle yet.</Card>;
  const anyFlash = points.some((p) => p.flash);
  const tempRows: Row[] = points.map((p) => ({ t: p.t, tIn: p.tIn, tOut: p.tOut }));
  return (
    <>
      <Card>
        <h4 className="text-sm font-semibold">Pressure difference under the lint screen (ΔP)</h4>
        <p className="mb-2 text-xs text-muted">
          Inside minus outside, sensor offset removed. More negative = harder to pull air through the screen.
          {anyFlash && " Dashed = uploaded later from the board's memory."}
        </p>
        <TimeSeriesChart
          ariaLabel="Pressure difference over time"
          data={splitByFlash(points)}
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
      <DataTable points={points} max={tableRows} />
    </>
  );
}

/**
 * Two keys so live and flash parts can be drawn solid and dashed. Each boundary
 * point goes into both, so the line has no gap where the style changes.
 */
export function splitByFlash(points: ChartPoint[]): Row[] {
  return points.map((p, i) => {
    const next = points[i + 1];
    const inLive = !p.flash || (next !== undefined && !next.flash);
    const inFlash = p.flash || (next !== undefined && next.flash);
    return { t: p.t, dp: inLive ? p.dp : null, dpFlash: inFlash ? p.dp : null };
  });
}

function DataTable({ points, max }: { points: ChartPoint[]; max: number }) {
  const rows = points.slice(-max).reverse();
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

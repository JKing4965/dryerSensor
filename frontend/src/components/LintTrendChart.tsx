/**
 * LintTrendChart.tsx - steady ΔP per cycle, so you can watch lint build up.
 *
 * What it does:
 *   One dot per recent cycle (oldest left), joined by a line. Lower = more suction
 *   needed = more lint. Also draws:
 *     - vertical "Cleaned" lines where the filter was cleaned between cycles
 *     - horizontal guide lines for the current period: the clean reference, and the
 *       "Check soon" / "Clean now" levels from the lint_settings thresholds
 *   Hovering a dot shows the cycle's date, ΔP and verdict.
 *
 * Talks to:
 *   - Receives LintData from src/app/lint/page.tsx. Recharts for drawing.
 */
"use client";

import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { LINT } from "@/components/Chips";
import { dateTime } from "@/lib/format";
import { scoreText } from "@/lib/lint";
import type { LintData, LintHistoryPoint } from "@/lib/types";

type Row = LintHistoryPoint & { i: number };

const dayFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const hourFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

export default function LintTrendChart({ data }: { data: LintData }) {
  const rows: Row[] = data.history.map((h, i) => ({ ...h, i }));
  if (rows.length === 0) {
    return <p className="text-sm text-muted">No finished cycles with lint numbers yet.</p>;
  }

  // All cycles on one day -> label ticks with the time, otherwise with the date.
  const sameDay = new Set(rows.map((r) => dayFmt.format(new Date(r.startedAt)))).size === 1;
  const tickFmt = sameDay ? hourFmt : dayFmt;

  // Cleanings that happened between two plotted cycles.
  const cleanings = rows.slice(1).filter((r, k) => r.cleanedAt !== rows[k].cleanedAt).map((r) => r.i - 0.5);

  // Guide lines for the current period (if it has a reference yet).
  const ref = data.lint.refDp;
  const guides =
    ref !== null && data.lint.status !== "calibrating"
      ? [
          { y: ref, label: "Clean", color: "var(--muted)" },
          { y: ref - data.settings.checkSoonScore * Math.abs(ref), label: "Check soon", color: "var(--warn)" },
          { y: ref - data.settings.cleanNowScore * Math.abs(ref), label: "Clean now", color: "var(--bad)" },
        ]
      : [];

  return (
    <figure aria-label="Steady pressure difference per cycle">
      <div style={{ height: 240 }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={rows} margin={{ top: 12, right: 72, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--border)" />
            <XAxis
              dataKey="i"
              type="number"
              domain={[-0.5, rows.length - 0.5]}
              allowDecimals={false}
              tickFormatter={(i: number) => (rows[i] ? tickFmt.format(new Date(rows[i].startedAt)) : "")}
              tick={{ fill: "var(--muted)", fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              minTickGap={24}
            />
            <YAxis
              width={52}
              domain={["auto", "auto"]}
              tickFormatter={(v: number) => v.toFixed(0)}
              tick={{ fill: "var(--muted)", fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              label={{ value: "Pa", position: "insideTopLeft", fill: "var(--muted)", fontSize: 11, dy: -10 }}
            />
            {guides.map((g) => (
              <ReferenceLine
                key={g.label}
                y={g.y}
                stroke={g.color}
                strokeDasharray="4 4"
                strokeWidth={1}
                ifOverflow="extendDomain"
                label={{ value: g.label, position: "right", fill: "var(--muted)", fontSize: 11 }}
              />
            ))}
            {cleanings.map((x) => (
              <ReferenceLine
                key={x}
                x={x}
                stroke="var(--ok)"
                strokeWidth={1.5}
                label={{ value: "Cleaned", position: "insideTopLeft", fill: "var(--muted)", fontSize: 11 }}
              />
            ))}
            <Tooltip
              cursor={{ stroke: "var(--muted)", strokeWidth: 1 }}
              isAnimationActive={false}
              content={(p) => <TrendTooltip active={p.active} row={p.payload?.[0]?.payload as Row | undefined} />}
            />
            <Line
              dataKey="dpSteady"
              type="linear"
              stroke="var(--series-1)"
              strokeWidth={2}
              dot={{ r: 4, fill: "var(--series-1)", stroke: "var(--card)", strokeWidth: 2 }}
              activeDot={{ r: 6, stroke: "var(--card)", strokeWidth: 2 }}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </figure>
  );
}

function TrendTooltip({ active, row }: { active?: boolean; row?: Row }) {
  if (!active || !row) return null;
  const chip = LINT[row.status];
  const moved = scoreText(row.score);
  return (
    <div className="rounded-md border border-border bg-card px-3 py-2 text-xs shadow-sm">
      <p className="text-muted">
        {dateTime(row.startedAt)} · cycle #{row.cycleNo}
      </p>
      <p className="mt-1 font-medium tabular-nums">ΔP {row.dpSteady.toFixed(1)} Pa</p>
      <p className="mt-0.5">
        <span aria-hidden="true">{chip.icon}</span> {chip.label}
        {moved && <span className="text-muted"> · {moved}</span>}
      </p>
      {row.possibleVentBlockage && <p className="mt-0.5">⚠ exhaust duct may be blocked</p>}
    </div>
  );
}

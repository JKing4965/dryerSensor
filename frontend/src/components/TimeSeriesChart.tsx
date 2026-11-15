/**
 * TimeSeriesChart.tsx - a line chart over time (used for ΔP and temperatures).
 *
 * What it does:
 *   Draws one or more lines from `data` (each row has `t` = ms since 1970 plus one
 *   value per series key). Hovering shows a crosshair with the time and every value.
 *   Style rules (from the team's chart guidelines):
 *     - 2 px lines, no dots, faint horizontal grid only, one y-axis
 *     - with 2+ series: a legend above the chart and the series name at each line's end
 *     - a series with dashed: true is drawn dashed (used for data uploaded from the
 *       board's memory), so the difference never relies on color alone
 *     - text uses text colors, never the series color
 *   Built on Recharts; a browser component.
 *
 * Talks to:
 *   - Used by LiveView.tsx (and the cycle detail page in step F3).
 *   - Colors come from CSS variables in src/app/globals.css.
 */
"use client";

import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

export type Row = { t: number } & Record<string, number | null>;

export interface Series {
  key: string;
  label: string;
  color: string; // e.g. "var(--series-1)"
  dashed?: boolean;
  /** Hide from legend/tooltip (for the second half of a split solid/dashed line). */
  hidden?: boolean;
}

interface Props {
  data: Row[];
  series: Series[];
  unit: string;
  height?: number;
  digits?: number;
  ariaLabel: string;
}

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const timeFmtLong = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
});

export default function TimeSeriesChart({ data, series, unit, height = 220, digits = 1, ariaLabel }: Props) {
  const visible = series.filter((s) => !s.hidden);
  // Under 10 minutes of data, minute-only ticks would repeat ("4:28, 4:28, ..."): show seconds.
  const spanMs = data.length > 1 ? data[data.length - 1].t - data[0].t : 0;
  const tickFmt = spanMs < 10 * 60_000 ? timeFmtLong : timeFmt;
  const showLegend = visible.length >= 2;
  const lastIndex = (key: string) => {
    for (let i = data.length - 1; i >= 0; i--) if (data[i][key] != null) return i;
    return -1;
  };

  return (
    <figure aria-label={ariaLabel}>
      {showLegend && (
        <ul className="mb-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
          {visible.map((s) => (
            <li key={s.key} className="flex items-center gap-1.5">
              <svg width="16" height="6" aria-hidden="true">
                <line x1="0" y1="3" x2="16" y2="3" stroke={s.color} strokeWidth="2" strokeLinecap="round" />
              </svg>
              {s.label}
            </li>
          ))}
        </ul>
      )}
      <div style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: showLegend ? 56 : 12, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--border)" />
            <XAxis
              dataKey="t"
              type="number"
              scale="time"
              domain={["dataMin", "dataMax"]}
              tickFormatter={(t: number) => tickFmt.format(t)}
              tick={{ fill: "var(--muted)", fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              minTickGap={40}
            />
            <YAxis
              width={52}
              domain={["auto", "auto"]}
              tickFormatter={(v: number) => `${v.toFixed(0)}`}
              tick={{ fill: "var(--muted)", fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              label={{ value: unit, position: "insideTopLeft", fill: "var(--muted)", fontSize: 11, dy: -8 }}
            />
            <Tooltip
              cursor={{ stroke: "var(--muted)", strokeWidth: 1 }}
              isAnimationActive={false}
              content={(p) => (
                <ChartTooltip
                  active={p.active}
                  row={p.payload?.[0]?.payload as Row | undefined}
                  series={visible}
                  unit={unit}
                  digits={digits}
                />
              )}
            />
            {series.map((s) => {
              const end = showLegend && !s.hidden ? lastIndex(s.key) : -1;
              return (
                <Line
                  key={s.key}
                  dataKey={s.key}
                  name={s.label}
                  type="linear"
                  stroke={s.color}
                  strokeWidth={2}
                  strokeDasharray={s.dashed ? "6 4" : undefined}
                  strokeLinecap="round"
                  dot={false}
                  activeDot={s.hidden ? false : { r: 4, strokeWidth: 2, stroke: "var(--card)" }}
                  connectNulls={false}
                  isAnimationActive={false}
                  label={(lp: { index?: number; x?: number | string; y?: number | string }) =>
                    lp.index === end ? (
                      <text
                        key={`end-${s.key}`}
                        x={Number(lp.x) + 6}
                        y={Number(lp.y)}
                        dy={4}
                        fontSize={11}
                        fill="var(--muted)"
                      >
                        {s.label}
                      </text>
                    ) : (
                      <g key={`nolabel-${s.key}-${lp.index}`} />
                    )
                  }
                />
              );
            })}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </figure>
  );
}

interface TooltipProps {
  active?: boolean;
  row?: Row;
  series: Series[];
  unit: string;
  digits: number;
}

function ChartTooltip({ active, row, series, unit, digits }: TooltipProps) {
  if (!active || !row) return null;
  // A line split into solid "x" + dashed "xFlash" halves shows once, under the visible key.
  const shown = new Map<string, { color: string; value: number }>();
  for (const s of series) {
    const value = row[s.key] ?? row[`${s.key}Flash`];
    if (value != null && !shown.has(s.label)) shown.set(s.label, { color: s.color, value });
  }
  return (
    <div className="rounded-md border border-border bg-card px-3 py-2 text-xs shadow-sm">
      <p className="mb-1 text-muted">{timeFmtLong.format(row.t)}</p>
      {[...shown].map(([name, { color, value }]) => (
        <p key={name} className="flex items-center gap-2">
          <span className="inline-block h-0.5 w-3 rounded" style={{ background: color }} aria-hidden="true" />
          <span className="text-muted">{name}</span>
          <span className="ml-auto font-medium tabular-nums">
            {value.toFixed(digits)} {unit}
          </span>
        </p>
      ))}
    </div>
  );
}

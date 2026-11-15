/**
 * CycleTable.tsx - the table of dryer cycles on the Cycles page.
 *
 * What it does:
 *   One row per cycle, newest first: start time (links to the cycle's page),
 *   length, steady ΔP, hottest inside temperature, lint verdict and state.
 *   Incomplete cycles, missing samples and estimated times are marked.
 *   On a phone the less important columns are hidden and the state moves under the date.
 *
 * Talks to:
 *   - Receives CycleListItem[] from src/app/cycles/page.tsx (which polls /api/cycles).
 *   - Chips.tsx for the state / lint labels.
 */
import Link from "next/link";

import { CycleStateChip, LintChip } from "@/components/Chips";
import { dateTime, degC, duration, pa } from "@/lib/format";
import type { CycleListItem } from "@/lib/types";

export default function CycleTable({ cycles }: { cycles: CycleListItem[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-card">
      <table className="w-full text-sm">
        <thead className="border-b border-border text-left text-xs text-muted">
          <tr>
            <th className="px-3 py-2 font-medium">Started</th>
            <th className="hidden px-3 py-2 text-right font-medium sm:table-cell">Length</th>
            <th className="px-3 py-2 text-right font-medium">ΔP steady</th>
            <th className="hidden px-3 py-2 text-right font-medium sm:table-cell">Max inside</th>
            <th className="px-3 py-2 font-medium">Lint</th>
            <th className="hidden px-3 py-2 font-medium sm:table-cell">State</th>
          </tr>
        </thead>
        <tbody>
          {cycles.map((c) => {
            const missing = c.nExpected != null ? c.nExpected - c.nSamples : 0;
            return (
              <tr key={c.id} className="border-t border-border first:border-t-0 hover:bg-border/30">
                <td className="px-3 py-2 align-top">
                  <Link
                    href={`/cycles/${c.id}`}
                    className="font-medium text-accent underline-offset-2 hover:underline"
                  >
                    {dateTime(c.startedAt)}
                  </Link>
                  {c.timeEstimated && (
                    <span className="ml-1 text-xs text-muted" title="Time is an estimate (board restarted)">
                      (approx.)
                    </span>
                  )}
                  <div className="text-xs text-muted">cycle #{c.cycleNo}</div>
                  {missing > 0 && <div className="text-xs text-warn">{missing} samples missing</div>}
                  {c.state !== "complete" && (
                    <div className="mt-1 sm:hidden">
                      <CycleStateChip state={c.state} />
                    </div>
                  )}
                </td>
                <td className="hidden px-3 py-2 whitespace-nowrap text-right align-top tabular-nums sm:table-cell">
                  {duration(c.durationS === null ? null : c.durationS * 1000)}
                </td>
                <td className="px-3 py-2 whitespace-nowrap text-right align-top tabular-nums">{pa(c.dpSteady)}</td>
                <td className="hidden px-3 py-2 whitespace-nowrap text-right align-top tabular-nums sm:table-cell">
                  {degC(c.tInMax)}
                </td>
                <td className="px-3 py-2 align-top">
                  <LintChip status={c.lintStatus} />
                </td>
                <td className="hidden px-3 py-2 align-top sm:table-cell">
                  <CycleStateChip state={c.state} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

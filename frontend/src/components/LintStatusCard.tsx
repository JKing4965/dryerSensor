/**
 * LintStatusCard.tsx - the big lint verdict box at the top of the Lint page.
 *
 * What it does:
 *   Shows the verdict with an icon + label + plain-language advice, then the details
 *   behind it: when the screen was last cleaned, cycles since, the "clean" reference
 *   ΔP, the latest cycle's ΔP and how far it has moved. A separate red box appears
 *   when the exhaust duct looks blocked.
 *
 * Talks to:
 *   - Receives LintData from src/app/lint/page.tsx. Words from src/lib/lint.ts.
 */
import Link from "next/link";

import { LINT } from "@/components/Chips";
import { dateTime, pa } from "@/lib/format";
import { lintAdvice, scoreText, VENT_ADVICE } from "@/lib/lint";
import type { LintSettings, LintStatus } from "@/lib/types";

const BOX: Record<LintStatus["status"], string> = {
  calibrating: "border-border",
  no_signal: "border-border",
  clean: "border-ok/50",
  check_soon: "border-warn/60 bg-warn/5",
  clean_now: "border-bad/60 bg-bad/5",
};

const TEXT: Record<LintStatus["status"], string> = {
  calibrating: "text-muted",
  no_signal: "text-muted",
  clean: "text-ok",
  check_soon: "text-warn",
  clean_now: "text-bad",
};

export default function LintStatusCard({ lint, settings }: { lint: LintStatus; settings: LintSettings }) {
  const { headline, advice } = lintAdvice(lint, settings);
  const chip = LINT[lint.status];
  const moved = scoreText(lint.score);

  return (
    <div className="space-y-3">
      <div role="status" className={`rounded-lg border-2 bg-card p-4 ${BOX[lint.status]}`}>
        <p className={`flex items-center gap-2 text-sm font-semibold ${TEXT[lint.status]}`}>
          <span aria-hidden="true">{chip.icon}</span>
          {chip.label}
        </p>
        <p className="mt-1 text-xl font-semibold">{headline}</p>
        <p className="mt-1 text-sm">{advice}</p>

        <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted">Last cleaned</dt>
          <dd>{lint.lastCleanedAt ? dateTime(lint.lastCleanedAt) : "never recorded"}</dd>
          <dt className="text-muted">Cycles since</dt>
          <dd>{lint.cyclesSinceCleaning}</dd>
          <dt className="text-muted">Clean reference ΔP</dt>
          <dd>{pa(lint.refDp)}</dd>
          <dt className="text-muted">Latest cycle ΔP</dt>
          <dd>
            {lint.latestCycleId ? (
              <Link href={`/cycles/${lint.latestCycleId}`} className="text-accent underline-offset-2 hover:underline">
                {pa(lint.latestDp)}
              </Link>
            ) : (
              "—"
            )}
            {moved && <span className="text-muted"> · {moved}</span>}
          </dd>
        </dl>
      </div>

      {lint.possibleVentBlockage && (
        <div role="alert" className="rounded-lg border-2 border-bad/60 bg-bad/5 p-4">
          <p className="flex items-center gap-2 text-sm font-semibold text-bad">
            <span aria-hidden="true">⚠</span> Check the exhaust duct
          </p>
          <p className="mt-1 text-sm">{VENT_ADVICE}</p>
        </div>
      )}
    </div>
  );
}

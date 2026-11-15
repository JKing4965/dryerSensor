/**
 * ui.tsx - small layout pieces shared by every page.
 *
 * What it does:
 *   Card (bordered box), Stat (label + big value tile), Note (yellow info line),
 *   ErrorBox (red "something failed" box). Styling only, no data logic.
 *
 * Talks to:
 *   - Used by LiveView.tsx, the Cycles pages and the Lint page.
 */
import type { ReactNode } from "react";

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-lg border border-border bg-card p-4 ${className}`}>{children}</div>;
}

export function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="text-lg font-semibold tabular-nums">{value}</dd>
      {hint && <dd className="text-xs text-muted">{hint}</dd>}
    </div>
  );
}

export function Note({ children }: { children: ReactNode }) {
  return <p className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-sm">{children}</p>;
}

export function ErrorBox({ title, detail }: { title: string; detail?: string | null }) {
  return (
    <div role="alert" className="rounded-lg border border-bad/50 bg-bad/10 p-3 text-sm">
      <p className="font-semibold text-bad">{title}</p>
      {detail && <p className="mt-1 break-words text-muted">{detail}</p>}
    </div>
  );
}

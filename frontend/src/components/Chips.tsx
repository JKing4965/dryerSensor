/**
 * Chips.tsx - small labels for a cycle's state and its lint verdict.
 *
 * What it does:
 *   CycleStateChip: "▶ Running", "✓ Complete", "⚠ Incomplete" (no end signal).
 *   LintChip: "Calibrating", "No signal", "✓ Clean", "! Check soon", "⚠ Clean now".
 *   Every chip has an icon + words, so meaning never depends on color alone.
 *
 * Talks to:
 *   - Used by the Cycles pages (and the Lint page in step F4).
 *   - Status values come from backend/db/views.sql.
 */
import type { CycleState, LintStatusValue } from "@/lib/types";

const base = "inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium";

const CYCLE: Record<CycleState, { icon: string; label: string; className: string }> = {
  running: { icon: "▶", label: "Running", className: "border-accent/40 text-accent" },
  complete: { icon: "✓", label: "Complete", className: "border-border text-muted" },
  incomplete: { icon: "⚠", label: "Incomplete", className: "border-warn/50 text-warn" },
};

export function CycleStateChip({ state }: { state: CycleState }) {
  const c = CYCLE[state];
  return (
    <span
      className={`${base} ${c.className}`}
      title={state === "incomplete" ? "The board never sent this cycle's end signal" : undefined}
    >
      <span aria-hidden="true">{c.icon}</span>
      {c.label}
    </span>
  );
}

export const LINT: Record<LintStatusValue, { icon: string; label: string; className: string }> = {
  calibrating: { icon: "…", label: "Calibrating", className: "border-border text-muted" },
  no_signal: { icon: "?", label: "No signal", className: "border-border text-muted" },
  clean: { icon: "✓", label: "Clean", className: "border-ok/40 text-ok" },
  check_soon: { icon: "!", label: "Check soon", className: "border-warn/50 text-warn" },
  clean_now: { icon: "⚠", label: "Clean now", className: "border-bad/50 text-bad" },
};

export function LintChip({ status }: { status: LintStatusValue | null }) {
  if (!status) return <span className="text-xs text-muted">—</span>;
  const c = LINT[status];
  return (
    <span className={`${base} ${c.className}`}>
      <span aria-hidden="true">{c.icon}</span>
      {c.label}
    </span>
  );
}

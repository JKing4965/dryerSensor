/**
 * cycles/page.tsx - the Cycles page ("/cycles"): history of dryer cycles.
 *
 * What it does (step F1 version):
 *   Placeholder so the navigation works. Step F3 adds the cycle table
 *   (date, duration, ΔP, max temperature, state) with links to each cycle's charts.
 *
 * Talks to:
 *   - Nothing yet. From F3: GET /api/cycles.
 */
export default function CyclesPage() {
  return (
    <section className="space-y-4">
      <h2 className="text-lg font-semibold">Cycles</h2>
      <p className="rounded-lg border border-border bg-card p-4 text-sm text-muted">
        Cycle history arrives in step F3.
      </p>
    </section>
  );
}

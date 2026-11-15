/**
 * lint/page.tsx - the Lint page ("/lint"): lint status and the "Filter cleaned" button.
 *
 * What it does (step F1 version):
 *   Placeholder so the navigation works. Step F4 adds the lint status card,
 *   the ΔP trend since the last cleaning, and the "Filter cleaned" button.
 *
 * Talks to:
 *   - Nothing yet. From F4: GET /api/lint and POST /api/filter-cleaned.
 */
export default function LintPage() {
  return (
    <section className="space-y-4">
      <h2 className="text-lg font-semibold">Lint</h2>
      <p className="rounded-lg border border-border bg-card p-4 text-sm text-muted">
        Lint status and the Filter cleaned button arrive in step F4.
      </p>
    </section>
  );
}

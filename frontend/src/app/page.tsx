/**
 * page.tsx - the Live page (home page, "/").
 *
 * What it does:
 *   Page title plus LiveView, which polls the API every 2 s and shows the connection
 *   badge, sensor errors, the current cycle's numbers and its ΔP / temperature charts.
 *
 * Talks to:
 *   - src/components/LiveView.tsx (all live logic lives there, in the browser).
 */
import LiveView from "@/components/LiveView";

export default function LivePage() {
  return (
    <section className="space-y-4">
      <h2 className="text-lg font-semibold">Live</h2>
      <LiveView />
    </section>
  );
}

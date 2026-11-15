/**
 * cycles/[id]/page.tsx - one dryer cycle in detail ("/cycles/12").
 *
 * What it does:
 *   Renders CycleDetailView inside <Suspense>. The view reads the cycle id from the
 *   URL, which Next.js' cacheComponents mode only allows inside a Suspense boundary.
 *   [id] is the database id (cycles.id) used in links from the Cycles table.
 *
 * Talks to:
 *   - src/components/CycleDetailView.tsx (all the page content and data loading).
 */
import { Suspense } from "react";

import CycleDetailView from "@/components/CycleDetailView";
import { Card } from "@/components/ui";

export default function CycleDetailPage() {
  return (
    <Suspense fallback={<Card>Loading…</Card>}>
      <CycleDetailView />
    </Suspense>
  );
}

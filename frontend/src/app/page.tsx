/**
 * page.tsx - the Live page (home page, "/").
 *
 * What it does (step F1 version):
 *   Shows a simple card with the board's status read straight from the database,
 *   to prove the dashboard can reach it. Step F2 turns this into the live view
 *   (status badge, sensor-error banner, ΔP and temperature charts refreshing every 2 s).
 *
 * Talks to:
 *   - src/lib/queries.ts (getDeviceStatus) on the server.
 */
import { connection } from "next/server";
import { Suspense } from "react";

import { DEVICE_ID } from "@/lib/db";
import { getDeviceStatus } from "@/lib/queries";

export default function LivePage() {
  return (
    <section className="space-y-4">
      <h2 className="text-lg font-semibold">Live</h2>
      <Suspense fallback={<Card>Loading status…</Card>}>
        <StatusCard />
      </Suspense>
    </section>
  );
}

async function StatusCard() {
  await connection(); // read the database on every request
  let status;
  try {
    status = await getDeviceStatus(DEVICE_ID);
  } catch (e) {
    return (
      <Card>
        <p className="font-medium text-bad">Can&apos;t reach the database.</p>
        <p className="mt-1 text-sm text-muted">
          Start it with <code>docker compose up -d</code>. ({e instanceof Error ? e.message : String(e)})
        </p>
      </Card>
    );
  }
  if (!status) {
    return <Card>Device &quot;{DEVICE_ID}&quot; not found. Check DEVICE_ID in frontend/.env.local.</Card>;
  }
  const rows: [string, string][] = [
    ["Device", `${status.name} (${status.deviceId})`],
    ["Receiver connected", status.connected ? "yes" : "no"],
    ["Board state", status.boardState ?? "—"],
    ["Last message", status.lastSeen ? new Date(status.lastSeen).toLocaleString() : "never"],
    [
      "Latest cycle",
      status.latestCycle
        ? `#${status.latestCycle.cycleNo} · ${status.latestCycle.state} · ${status.latestCycle.nSamples} samples`
        : "none yet",
    ],
  ];
  return (
    <Card>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted">{k}</dt>
            <dd className="font-medium break-words">{v}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return <div className="rounded-lg border border-border bg-card p-4">{children}</div>;
}

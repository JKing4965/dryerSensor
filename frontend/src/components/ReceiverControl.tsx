/**
 * ReceiverControl.tsx - the "Connect to sensor" / "Disconnect" card on the Live page.
 *
 * What it does:
 *   Connect starts the Python Bluetooth receiver on this computer (POST /api/receiver);
 *   it then searches for the board and connects by itself. Disconnect stops it cleanly.
 *   The card shows what's happening: searching, connected, stopped, or an error, plus the
 *   receiver's recent log under "Receiver log".
 *   If a receiver started in a terminal is already connected, the button is disabled:
 *   the board accepts only one connection, so stop that one first (Ctrl+C).
 *
 * Talks to:
 *   - GET/POST /api/receiver (src/app/api/receiver/route.ts), polled every 2 s.
 *   - Receives the board's DeviceStatus from LiveView.tsx to tell "searching" from "connected".
 */
"use client";

import { useState } from "react";

import { linkState } from "@/lib/status";
import type { DeviceStatus, ReceiverStatus } from "@/lib/types";
import { refreshAll, usePolling } from "@/lib/usePolling";

export default function ReceiverControl({ device }: { device: DeviceStatus | null }) {
  const { data: rx, refresh } = usePolling<ReceiverStatus>("/api/receiver", 2000);
  const [busy, setBusy] = useState<"start" | "stop" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const boardLinked = device ? linkState(device).kind !== "disconnected" : false;
  const runningHere = rx?.running ?? false;
  const runningElsewhere = !runningHere && boardLinked;
  const crashed = !runningHere && rx?.exitCode != null && rx.exitCode !== 0;

  async function act(action: "start" | "stop") {
    setBusy(action);
    setError(null);
    try {
      const res = await fetch("/api/receiver", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.detail ?? body?.error ?? res.statusText);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
      refresh();
      refreshAll();
    }
  }

  let headline: string;
  let detail: string;
  if (busy === "start") [headline, detail] = ["Starting…", "Launching the Bluetooth receiver."];
  else if (busy === "stop") [headline, detail] = ["Disconnecting…", "Saving buffered data and closing the link."];
  else if (runningHere && boardLinked) [headline, detail] = ["Connected to the sensor", "Data is being recorded."];
  else if (runningHere) [headline, detail] = ["Searching for the sensor…", "Is the board powered and nearby? It retries by itself."];
  else if (runningElsewhere)
    [headline, detail] = [
      "Connected by another receiver",
      "A receiver started in a terminal is connected. Stop it there (Ctrl+C) to control it here.",
    ];
  else if (crashed) [headline, detail] = ["Receiver stopped with an error", "See the receiver log below."];
  else [headline, detail] = ["Not connected", "Connect to start recording from the sensor."];

  const canConnect = !runningHere && !runningElsewhere && busy === null;
  const canDisconnect = runningHere && busy === null;
  const log = rx?.log ?? [];

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted">Bluetooth sensor</p>
          <p className={`font-semibold ${crashed ? "text-bad" : ""}`}>{headline}</p>
          <p className="text-sm text-muted">{detail}</p>
        </div>
        {runningHere || busy === "stop" ? (
          <button
            type="button"
            onClick={() => act("stop")}
            disabled={!canDisconnect}
            className="w-full rounded-md border border-border px-4 py-2.5 font-medium disabled:opacity-60 sm:w-auto"
          >
            {busy === "stop" ? "Disconnecting…" : "Disconnect"}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => act("start")}
            disabled={!canConnect}
            className="w-full rounded-md bg-accent px-4 py-2.5 font-medium text-white disabled:opacity-60 sm:w-auto"
          >
            {busy === "start" ? "Connecting…" : "Connect to sensor"}
          </button>
        )}
      </div>
      {error && <p role="alert" className="mt-3 break-words text-sm text-bad">{error}</p>}
      {log.length > 0 && (
        <details className="mt-3 text-sm" open={crashed}>
          <summary className="cursor-pointer text-muted">Receiver log ({log.length} lines)</summary>
          <pre className="mt-2 max-h-56 overflow-auto rounded-md border border-border bg-background p-2 font-mono text-xs leading-relaxed whitespace-pre-wrap">
            {log.join("\n")}
          </pre>
        </details>
      )}
    </div>
  );
}

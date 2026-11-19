/**
 * ReceiverControl.tsx - the "Connect to sensor" / "Disconnect" card on the Live page.
 *
 * What it does:
 *   Connect / Disconnect ask the standby receiver on the PC (through the database) to
 *   connect to or leave the board. It works the same locally and on Vercel; the receiver
 *   reacts within ~3 s. The card shows:
 *     - PC receiver offline           (no heartbeat): Connect still allowed - it
 *                                      connects as soon as the receiver comes online
 *     - Ready on <PC>                  online, not asked to connect
 *     - Searching for the sensor…      asked to connect, board not found yet
 *     - Connected to the sensor        data is flowing
 *   On a local dashboard, Connect also starts the standby receiver if none is online,
 *   and its log appears under "Receiver log".
 *   While connected, the card also holds the "Test cycle" controls (TestCycleControl.tsx),
 *   for starting a cycle without vibration.
 *
 * Talks to:
 *   - GET/POST /api/receiver (src/app/api/receiver/route.ts), polled every 2 s.
 *   - Receives the board's DeviceStatus from LiveView.tsx (to spot a terminal receiver).
 */
"use client";

import { useState } from "react";

import TestCycleControl from "@/components/TestCycleControl";
import { agoText, linkState, secondsSince } from "@/lib/status";
import type { DeviceStatus, ReceiverStatus } from "@/lib/types";
import { refreshAll, usePolling } from "@/lib/usePolling";

export default function ReceiverControl({ device }: { device: DeviceStatus | null }) {
  const { data: rx, refresh } = usePolling<ReceiverStatus>("/api/receiver", 2000);
  const [busy, setBusy] = useState<"connect" | "disconnect" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function act(action: "connect" | "disconnect") {
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

  const boardLinked = device ? linkState(device).kind !== "disconnected" : false;
  const wantsConnected = rx?.desired === "connected";
  const launcher = rx?.launcher ?? null;
  const crashed = launcher != null && !launcher.running && launcher.exitCode != null && launcher.exitCode !== 0;
  const where = rx?.host ? ` on ${rx.host}` : "";

  let headline = "Checking…";
  let detail = "";
  if (rx) {
    if (!rx.online && boardLinked) {
      headline = "Connected by a receiver started in a terminal";
      detail = "Stop it there (Ctrl+C) to use these buttons, or keep using it.";
    } else if (!rx.online) {
      headline = crashed ? "Receiver stopped with an error" : "PC receiver offline";
      detail = wantsConnected
        ? "It will connect as soon as the receiver on the PC is running."
        : rx.canLaunch
          ? "Press Connect to start the receiver on this computer."
          : `Start it on the PC: uv run python -m dryer_backend.remote${
              rx.lastHeartbeat ? ` (last seen ${agoText(secondsSince(rx.lastHeartbeat, new Date().toISOString()))})` : ""
            }`;
    } else if (rx.state === "connected") {
      headline = "Connected to the sensor";
      detail = `Data is being recorded${where}.`;
    } else if (wantsConnected) {
      headline = "Searching for the sensor…";
      detail = `Receiver${where} is looking for the board. Is it powered and nearby?`;
    } else {
      headline = "Ready";
      detail = `Receiver${where} is online. Press Connect to link to the sensor.`;
    }
  }
  if (busy === "connect") [headline, detail] = ["Connecting…", "Sending the request to the receiver."];
  if (busy === "disconnect") [headline, detail] = ["Disconnecting…", "Asking the receiver to drop the link."];

  const showDisconnect = wantsConnected;
  const disabled = busy !== null || !rx || (!rx.online && boardLinked);
  const log = launcher?.log ?? [];

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-muted">Bluetooth sensor</p>
          <p className={`font-semibold ${crashed ? "text-bad" : ""}`}>{headline}</p>
          <p className="break-words text-sm text-muted">{detail}</p>
        </div>
        {showDisconnect ? (
          <button
            type="button"
            onClick={() => act("disconnect")}
            disabled={disabled}
            className="w-full rounded-md border border-border px-4 py-2.5 font-medium disabled:opacity-60 sm:w-auto"
          >
            {busy === "disconnect" ? "Disconnecting…" : "Disconnect"}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => act("connect")}
            disabled={disabled}
            className="w-full rounded-md bg-accent px-4 py-2.5 font-medium text-white disabled:opacity-60 sm:w-auto"
          >
            {busy === "connect" ? "Connecting…" : "Connect to sensor"}
          </button>
        )}
      </div>
      {error && (
        <p role="alert" className="mt-3 break-words text-sm text-bad">
          {error}
        </p>
      )}
      {rx && rx.online && wantsConnected && (
        <TestCycleControl
          rx={rx}
          device={device}
          onChange={() => {
            refresh();
            refreshAll();
          }}
        />
      )}
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

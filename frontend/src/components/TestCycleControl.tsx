/**
 * TestCycleControl.tsx - "Start / End test cycle" (testing without vibration).
 *
 * What it does:
 *   For bench or lint-simulation testing: starts a cycle on the board right now, with no
 *   vibration needed, either for a set time (5 / 10 / 20 / 45 min, it ends by itself) or
 *   until "End cycle now". "End cycle now" also ends a normal, vibration-started cycle.
 *   The sensors still read for real, so the cycle gets real ΔP, temperatures and lint
 *   numbers. Shown inside the Bluetooth card once the board is connected; it also shows
 *   whether the last request reached the board ("Sent to the board" / "not sent").
 *
 * Talks to:
 *   - POST /api/test-cycle; the result arrives through ReceiverControl's /api/receiver poll.
 *   - The board gets M,1[,seconds] / M,0 (docs/protocol.md section 4).
 */
"use client";

import { useState } from "react";

import type { DeviceStatus, ReceiverStatus } from "@/lib/types";

const DURATIONS = [
  { minutes: 5, label: "5 min" },
  { minutes: 10, label: "10 min" },
  { minutes: 20, label: "20 min" },
  { minutes: 45, label: "45 min" },
  { minutes: 0, label: "Until I end it" },
];

interface Props {
  rx: ReceiverStatus;
  device: DeviceStatus | null;
  onChange: () => void;
}

export default function TestCycleControl({ rx, device, onChange }: Props) {
  const [minutes, setMinutes] = useState(10);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connected = rx.state === "connected";
  const cycleRunning = device?.boardState === "running" || device?.latestCycle?.state === "running";
  const t = rx.test;
  const recent = t.recent; // requested in the last 2 minutes (decided by the database clock)

  async function send(action: "start" | "stop") {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/test-cycle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(action === "start" ? { action, minutes } : { action }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.detail ?? body?.error ?? res.statusText);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      onChange();
    }
  }

  let status: string | null = null;
  if (t.pending) status = "Sending to the board…";
  else if (recent && t.result === "sent")
    status = t.command === "start" ? "✓ Test cycle started on the board" : "✓ Cycle ended on the board";
  else if (recent && t.result === "expired") status = "Not sent: the board wasn't connected within 60 s.";

  return (
    <div className="mt-4 border-t border-border pt-3">
      <p className="text-sm font-medium">Test cycle</p>
      <p className="text-xs text-muted">
        Starts a cycle without vibration, for bench or lint-simulation tests. The sensors still record for real.
      </p>
      {!connected ? (
        <p className="mt-2 text-sm text-muted">Connect to the sensor to run a test cycle.</p>
      ) : (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {!cycleRunning && (
            <>
              <label className="sr-only" htmlFor="test-duration">
                Test cycle length
              </label>
              <select
                id="test-duration"
                value={minutes}
                onChange={(e) => setMinutes(Number(e.target.value))}
                disabled={busy || t.pending}
                className="rounded-md border border-border bg-background px-2 py-2 text-sm"
              >
                {DURATIONS.map((d) => (
                  <option key={d.minutes} value={d.minutes}>
                    {d.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => send("start")}
                disabled={busy || t.pending}
                className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
              >
                Start test cycle
              </button>
            </>
          )}
          {cycleRunning && (
            <button
              type="button"
              onClick={() => send("stop")}
              disabled={busy || t.pending}
              className="rounded-md border border-border px-4 py-2 text-sm font-medium disabled:opacity-60"
            >
              End cycle now
            </button>
          )}
        </div>
      )}
      {status && (
        <p role="status" className={`mt-2 text-sm ${t.result === "expired" && !t.pending ? "text-warn" : "text-muted"}`}>
          {status}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-2 break-words text-sm text-bad">
          {error}
        </p>
      )}
    </div>
  );
}

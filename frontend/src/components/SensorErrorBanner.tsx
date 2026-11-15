/**
 * SensorErrorBanner.tsx - red warning shown while a pressure/temperature sensor has a problem.
 *
 * What it does:
 *   If the board reports error code 1 (sensor not found) or 2 (bad readings) for
 *   either sensor, shows which sensor, what's wrong, and since when. While a sensor
 *   is in error the board sends no readings, so charts will have a gap.
 *   Renders nothing when both sensors are OK.
 *
 * Talks to:
 *   - Receives a DeviceStatus from LiveView.tsx. Messages come from src/lib/status.ts.
 */
import { sensorProblems } from "@/lib/status";
import type { DeviceStatus } from "@/lib/types";

export default function SensorErrorBanner({ status }: { status: DeviceStatus }) {
  const problems = sensorProblems(status);
  if (problems.length === 0) return null;
  const since = status.sensorErrorSince ? new Date(status.sensorErrorSince).toLocaleTimeString() : null;
  return (
    <div role="alert" className="rounded-lg border border-bad/50 bg-bad/10 p-3 text-sm">
      <p className="flex items-center gap-2 font-semibold text-bad">
        <span aria-hidden="true">⚠</span> Sensor problem{since ? ` since ${since}` : ""}
      </p>
      <ul className="mt-1 list-disc pl-6">
        {problems.map((p) => (
          <li key={p}>{p}</li>
        ))}
      </ul>
      <p className="mt-1 text-muted">No readings are recorded until it is fixed.</p>
    </div>
  );
}

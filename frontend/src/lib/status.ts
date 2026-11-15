/**
 * status.ts - turns the raw device status into what the dashboard shows.
 *
 * What it does:
 *   linkState() decides the badge: disconnected / uploading / running / idle.
 *   The receiver writes device_status at least every 30 s while connected (every
 *   board hello), so if the last write is older than STALE_AFTER_S the receiver
 *   is treated as gone, even if it crashed without marking itself disconnected.
 *   sensorProblems() lists sensor error messages for the red banner.
 *
 * Talks to:
 *   - Used by StatusBadge.tsx and SensorErrorBanner.tsx. Pure functions, no I/O.
 */
import { SENSOR_ERROR_LABEL, type DeviceStatus, type SensorErrorCode } from "./types";

export const STALE_AFTER_S = 65;

export type LinkKind = "disconnected" | "uploading" | "running" | "idle";

export interface LinkState {
  kind: LinkKind;
  label: string;
}

export function secondsSince(isoTime: string | null, nowIso: string): number | null {
  if (!isoTime) return null;
  return (Date.parse(nowIso) - Date.parse(isoTime)) / 1000;
}

export function linkState(s: DeviceStatus): LinkState {
  const age = secondsSince(s.updatedAt, s.serverTime);
  if (!s.connected || age === null || age > STALE_AFTER_S) {
    return { kind: "disconnected", label: "Disconnected" };
  }
  if (s.boardState === "uploading") {
    const n = s.backlogCount ? ` (${s.backlogCount} samples)` : "";
    return { kind: "uploading", label: `Uploading saved data${n}` };
  }
  if (s.boardState === "running") {
    const no = s.latestCycle?.state === "running" ? ` · cycle #${s.latestCycle.cycleNo}` : "";
    return { kind: "running", label: `Dryer running${no}` };
  }
  return { kind: "idle", label: "Connected · dryer idle" };
}

export function sensorProblems(s: DeviceStatus): string[] {
  const out: string[] = [];
  const add = (where: string, code: SensorErrorCode | null) => {
    if (code) out.push(`${where} sensor ${SENSOR_ERROR_LABEL[code]}`);
  };
  add("Inside (under the lint screen)", s.sensorInError);
  add("Outside (room air)", s.sensorOutError);
  return out;
}

/** "just now", "42 s ago", "5 min ago", "3 h ago" */
export function agoText(seconds: number | null): string {
  if (seconds === null) return "never";
  if (seconds < 5) return "just now";
  if (seconds < 90) return `${Math.round(seconds)} s ago`;
  if (seconds < 90 * 60) return `${Math.round(seconds / 60)} min ago`;
  return `${Math.round(seconds / 3600)} h ago`;
}

/**
 * StatusBadge.tsx - the "Disconnected / Uploading / Dryer running / Idle" pill.
 *
 * What it does:
 *   Shows the board's connection state as an icon + text (never color alone),
 *   plus when the last message arrived. The state logic lives in src/lib/status.ts.
 *
 * Talks to:
 *   - Receives a DeviceStatus from LiveView.tsx (which polls /api/status).
 */
import { agoText, linkState, secondsSince, type LinkKind } from "@/lib/status";
import type { DeviceStatus } from "@/lib/types";

const STYLE: Record<LinkKind, { icon: string; className: string }> = {
  disconnected: { icon: "○", className: "border-border text-muted" },
  uploading: { icon: "⇡", className: "border-accent/40 text-accent" },
  running: { icon: "▶", className: "border-accent/40 text-accent" },
  idle: { icon: "●", className: "border-ok/40 text-ok" },
};

export default function StatusBadge({ status }: { status: DeviceStatus }) {
  const link = linkState(status);
  const { icon, className } = STYLE[link.kind];
  const lastMessage = agoText(secondsSince(status.lastSeen, status.serverTime));
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span
        role="status"
        className={`inline-flex items-center gap-2 rounded-full border bg-card px-3 py-1 text-sm font-medium ${className}`}
      >
        <span aria-hidden="true">{icon}</span>
        {link.label}
      </span>
      <span className="text-xs text-muted">Last message from board: {lastMessage}</span>
    </div>
  );
}

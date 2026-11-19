/**
 * types.ts - TypeScript shapes of the data the API routes return.
 *
 * What it does:
 *   One place that describes the JSON passed from the API routes (src/app/api)
 *   to the pages and components, so both sides agree on field names.
 *   Field meanings and units follow backend/db/schema.sql:
 *   pressure in Pa, temperature in °C, times as ISO strings (UTC).
 *
 * Talks to:
 *   - Filled in by src/lib/queries.ts, used by pages and components.
 *   - Safe to import from browser components (no server code here).
 */

/** Sensor error codes from the board's H line (docs/protocol.md 3.1). */
export type SensorErrorCode = 0 | 1 | 2; // 0 ok, 1 missing, 2 broken

export const SENSOR_ERROR_LABEL: Record<SensorErrorCode, string> = {
  0: "OK",
  1: "not found (check wiring)",
  2: "giving bad readings",
};

/** Board state reported in its H line. */
export type BoardState = "idle" | "running" | "uploading";

export type CycleState = "running" | "complete" | "incomplete";

/** GET /api/status */
export interface DeviceStatus {
  deviceId: string;
  name: string;
  /** The receiver currently has a Bluetooth link to the board. */
  connected: boolean;
  /** Last message of any kind from the board (ISO time), null if never. */
  lastSeen: string | null;
  boardState: BoardState | null;
  backlogCount: number | null;
  sensorInError: SensorErrorCode | null;
  sensorOutError: SensorErrorCode | null;
  sensorErrorSince: string | null;
  latestCycle: {
    id: number;
    cycleNo: number;
    state: CycleState;
    startedAt: string;
    endedAt: string | null;
    nSamples: number;
  } | null;
  /** Database clock time of the last status write by the receiver. */
  updatedAt: string | null;
  /** Server clock when this was produced; compare with updatedAt to spot a dead receiver. */
  serverTime: string;
}

/** One dryer cycle's summary (GET /api/live, and the Cycles pages later). */
export interface CycleSummary {
  id: number;
  cycleNo: number;
  state: CycleState;
  startedAt: string;
  endedAt: string | null;
  nSamples: number;
  /** Sample count the board reported in its E line (null while running). */
  nExpected: number | null;
  /** Times are estimates (board restarted before uploading this cycle). */
  timeEstimated: boolean;
  /** Sensor offset (Pa) subtracted from ΔP; null if no baseline was available. */
  offsetPa: number | null;
  dpSteady: number | null;
  tInMax: number | null;
  durationS: number | null;
  /** Average inside-minus-outside temperature during steady running (°C). */
  dtMean: number | null;
  /** The idle reading taken just before the cycle (null if the board had none). */
  baselineAt: string | null;
  baselineTIn: number | null;
  baselineTOut: number | null;
  /** Lint verdict for this cycle (backend/db/views.sql lint_history); null if it has no features. */
  lintStatus: LintStatusValue | null;
  lintScore: number | null;
}

/** Lint verdicts from backend/db/views.sql. */
export type LintStatusValue = "calibrating" | "no_signal" | "clean" | "check_soon" | "clean_now";

/** One row of GET /api/cycles (the Cycles table). */
export interface CycleListItem {
  id: number;
  cycleNo: number;
  state: CycleState;
  startedAt: string;
  endedAt: string | null;
  nSamples: number;
  nExpected: number | null;
  timeEstimated: boolean;
  dpSteady: number | null;
  tInMax: number | null;
  /** Length in seconds (so far, for a running cycle). */
  durationS: number | null;
  lintStatus: LintStatusValue | null;
  lintScore: number | null;
}

/** Current lint verdict for the device (backend/db/views.sql lint_status). */
export interface LintStatus {
  status: LintStatusValue;
  /** ΔP has moved toward zero while the dryer ran hotter: exhaust duct may be blocked. */
  possibleVentBlockage: boolean;
  lastCleanedAt: string | null;
  cyclesSinceCleaning: number;
  /** Average steady ΔP of the first cycles after cleaning ("clean filter" level), Pa. */
  refDp: number | null;
  latestCycleId: number | null;
  latestCycleAt: string | null;
  latestDp: number | null;
  /** (refDp - latestDp) / |refDp|: 0.2 = 20% more suction than when clean. */
  score: number | null;
}

/** Thresholds from the lint_settings table. */
export interface LintSettings {
  referenceCycles: number;
  checkSoonScore: number;
  cleanNowScore: number;
  ventScore: number;
}

/** One cycle in the lint trend (lint_history view). */
export interface LintHistoryPoint {
  cycleId: number;
  cycleNo: number;
  startedAt: string;
  /** The cleaning this cycle counts from (null = before any recorded cleaning). */
  cleanedAt: string | null;
  dpSteady: number;
  refDp: number | null;
  score: number | null;
  status: LintStatusValue;
  possibleVentBlockage: boolean;
}

/** GET /api/lint (history omitted with ?history=0) */
export interface LintData {
  lint: LintStatus;
  settings: LintSettings;
  /** Recent cycles with features, oldest first. */
  history: LintHistoryPoint[];
}

/** What the standby receiver on the PC is doing ("offline" = no heartbeat for 15 s). */
export type ReceiverState = "standby" | "searching" | "connected" | "offline";

/** A standby receiver started by THIS dashboard server (local only). */
export interface LauncherStatus {
  running: boolean;
  pid: number | null;
  startedAt: string | null;
  exitedAt: string | null;
  exitCode: number | null;
  /** Its most recent log lines (oldest first). */
  log: string[];
}

/** A "Start / End test cycle" request: sent to the board as an M line by the receiver. */
export interface TestCycleRequest {
  command: "start" | "stop" | null;
  /** For "start": auto-end after this many seconds; 0 = until "End test cycle". */
  seconds: number;
  /** Requested but not yet handled by the receiver. */
  pending: boolean;
  /** "sent" = delivered to the board; "expired" = board not connected within 60 s. */
  result: "sent" | "expired" | null;
  requestedAt: string | null;
  /** Requested in the last 2 minutes (database clock): worth showing its result. */
  recent: boolean;
}

/** GET/POST /api/receiver: the remote Connect button (receiver_control table). */
export interface ReceiverStatus {
  /** What the Connect / Disconnect button last asked for. */
  desired: "connected" | "disconnected";
  /** A standby receiver has sent a heartbeat in the last 15 s. */
  online: boolean;
  state: ReceiverState;
  /** Computer name of the standby receiver. */
  host: string | null;
  lastHeartbeat: string | null;
  /** The last Start / End test-cycle request (receiver_control.test_*). */
  test: TestCycleRequest;
  /** This server can start a standby receiver itself (local dashboard, not Vercel). */
  canLaunch: boolean;
  /** Only when canLaunch: the receiver this server started, if any. */
  launcher: LauncherStatus | null;
}

/** POST /api/filter-cleaned */
export interface FilterCleanedResult {
  /** false if a cleaning was already recorded in the last minute (double-click guard). */
  created: boolean;
  eventId: number;
  time: string;
}

/** GET /api/cycles/[id] */
export interface CycleDetail {
  cycle: CycleSummary;
  points: ChartPoint[];
}

/** One chart point: several raw samples averaged into a time bucket. */
export interface ChartPoint {
  /** Bucket start, milliseconds since 1970 (UTC). */
  t: number;
  /** ΔP in Pa, offset-corrected when CycleSummary.offsetPa is known. */
  dp: number;
  tIn: number;
  tOut: number;
  /** At least one sample in this bucket was uploaded from the board's flash memory. */
  flash: boolean;
}

/** GET /api/live */
export interface LiveData {
  cycle: CycleSummary | null;
  points: ChartPoint[];
}

/** Error body returned by every API route when something fails. */
export interface ApiError {
  error: string;
  detail?: string;
}

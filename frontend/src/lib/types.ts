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

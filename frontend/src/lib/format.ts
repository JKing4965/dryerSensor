/**
 * format.ts - turns numbers and times into the short text the dashboard shows.
 *
 * What it does:
 *   duration(ms) -> "45 min" / "1 h 3 min", pa(x) -> "-108.0 Pa", degC(x) -> "55.3 °C",
 *   dateTime(iso) -> local date + time, dash for missing values.
 *   Times are shown in the viewer's own time zone (the database stores UTC).
 *
 * Talks to:
 *   - Used by components and pages. Pure functions, safe in the browser.
 */

export function duration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "—";
  const m = Math.max(0, Math.round(ms / 60000));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

export const pa = (x: number | null | undefined, digits = 1) => (x == null ? "—" : `${x.toFixed(digits)} Pa`);

export const degC = (x: number | null | undefined, digits = 1) => (x == null ? "—" : `${x.toFixed(digits)} °C`);

const dateTimeFmt = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

export const dateTime = (iso: string | null) => (iso ? dateTimeFmt.format(new Date(iso)) : "—");

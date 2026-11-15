/**
 * lint.ts - the plain-language words for each lint verdict.
 *
 * What it does:
 *   lintAdvice() turns a LintStatus into a headline and one or two sentences of advice.
 *   VENT_ADVICE is the separate exhaust-duct warning.
 *   scoreText() turns a score into "24% more suction than when clean".
 *   needsReminder() decides when the banner on every page appears.
 *   Keeping the wording here means the Lint page and the banner always agree.
 *
 * Talks to:
 *   - Used by LintStatusCard.tsx and LintReminder.tsx. Verdicts come from backend/db/views.sql.
 */
import type { LintSettings, LintStatus } from "./types";

export function lintAdvice(l: LintStatus, s: LintSettings): { headline: string; advice: string } {
  switch (l.status) {
    case "calibrating":
      return {
        headline: "Learning what a clean filter looks like",
        advice:
          l.cyclesSinceCleaning === 0 && !l.lastCleanedAt
            ? `Press "Filter cleaned" right after you clean the lint screen. The next ${s.referenceCycles} cycles become the "clean" reference.`
            : `${l.cyclesSinceCleaning} of ${s.referenceCycles} reference cycles recorded since the screen was cleaned.`,
      };
    case "no_signal":
      return {
        headline: "Can't judge lint yet",
        advice:
          "The pressure difference is too small to measure lint. Check that the inside sensor sits under the lint screen.",
      };
    case "clean":
      return { headline: "Lint screen looks clean", advice: "Nothing to do." };
    case "check_soon":
      return {
        headline: "Lint is building up",
        advice: "Clean the lint screen before your next load if you can.",
      };
    case "clean_now":
      return {
        headline: "Clean the lint screen now",
        advice: "The screen is clogged. That makes drying slower and is a fire risk. Clean it before the next load.",
      };
  }
}

export const VENT_ADVICE =
  "Airflow dropped while the dryer ran hotter. The exhaust duct or outside vent may be blocked. " +
  "Cleaning the lint screen won't fix this; check the duct.";

/** 0.24 -> "24% more suction than when clean", -0.3 -> "30% less suction than when clean" */
export function scoreText(score: number | null): string | null {
  if (score === null) return null;
  const pct = Math.round(Math.abs(score) * 100);
  return `${pct}% ${score >= 0 ? "more" : "less"} suction than when clean`;
}

export function needsReminder(l: LintStatus): boolean {
  return l.status === "check_soon" || l.status === "clean_now" || l.possibleVentBlockage;
}

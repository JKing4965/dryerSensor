"""
features.py - the numbers that describe one dryer cycle, used to judge lint buildup.

What it does:
    When a cycle ends, compute_features() looks at its samples and works out:
        dp_steady   median ΔP (p_in - p_out) during steady running, minus the cycle's
                    pre-cycle baseline ΔP (the offset between the two sensors at rest).
                    Negative; more negative = more lint on the screen.
        t_in_max    hottest temperature under the lint screen (°C)
        dt_mean     average inside-minus-outside temperature during steady running (°C)
        duration_s  cycle length in seconds
    "Steady running" skips the blower spin-up at the start and the cool-down / spin-down
    at the end: max(2 min, 10%) at the start and max(3 min, 10%) at the end, each capped
    at 25% so short cycles still keep their middle half.

    The results go into the cycles table. The lint verdict itself is computed in SQL
    (backend/db/views.sql), so changing thresholds never needs Python changes.

Talks to:
    - db.py to read samples and store results; called by ingest.py when an E line arrives.
    - Tested by backend/tests/test_features.py.

How to run by hand (from backend/), e.g. after changing this file:
    uv run python -m dryer_backend.features              fill in cycles that have no features yet
    uv run python -m dryer_backend.features --all        recompute every complete cycle
"""

from __future__ import annotations

import argparse
import logging
import statistics
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime

from dryer_backend.config import ConfigError, load_settings, run_async
from dryer_backend.db import Database

log = logging.getLogger(__name__)

MIN_STEADY_S = 60.0  # need at least a minute of steady running...
MIN_STEADY_POINTS = 30  # ...and this many samples in it, or dp_steady is left empty


@dataclass(frozen=True, slots=True)
class Point:
    time: datetime
    dp: float  # p_in - p_out, Pa (not offset-corrected)
    t_in: float
    t_out: float


@dataclass(frozen=True, slots=True)
class Features:
    dp_steady: float | None
    t_in_max: float | None
    dt_mean: float | None
    duration_s: float | None
    n_steady: int  # samples used for dp_steady / dt_mean


def steady_window(duration_s: float) -> tuple[float, float]:
    """(start, end) in seconds after the cycle start that count as steady running."""
    skip_start = min(max(120.0, 0.10 * duration_s), 0.25 * duration_s)
    skip_end = min(max(180.0, 0.10 * duration_s), 0.25 * duration_s)
    return skip_start, duration_s - skip_end


def compute_features(
    points: Sequence[Point],
    started_at: datetime,
    ended_at: datetime | None,
    baseline_dp: float | None,
) -> Features:
    if ended_at is None and points:
        ended_at = points[-1].time
    duration = (ended_at - started_at).total_seconds() if ended_at else None
    t_in_max = max((p.t_in for p in points), default=None)
    if not points or not duration or duration <= 0:
        return Features(None, t_in_max, None, duration, 0)

    lo, hi = steady_window(duration)
    steady = [p for p in points if lo <= (p.time - started_at).total_seconds() <= hi]
    long_enough = hi - lo >= MIN_STEADY_S and len(steady) >= MIN_STEADY_POINTS
    dt_mean = statistics.fmean(p.t_in - p.t_out for p in steady) if steady else None

    dp_steady = None
    if long_enough and baseline_dp is not None:
        dp_steady = statistics.median(p.dp for p in steady) - baseline_dp
    return Features(dp_steady, t_in_max, dt_mean, duration, len(steady))


async def update_cycle_features(db: Database, cycle_id: int) -> Features | None:
    """Compute and store features for one cycle. Returns them (None if the cycle is gone)."""
    info = await db.cycle_for_features(cycle_id)
    if info is None:
        return None
    rows = await db.cycle_points(info["device_id"], info["cycle_no"])
    points = [Point(r["time"], r["dp"], r["t_in"], r["t_out"]) for r in rows]
    feats = compute_features(points, info["started_at"], info["ended_at"], info["baseline_dp"])
    await db.store_features(cycle_id, feats.dp_steady, feats.t_in_max, feats.dt_mean, feats.duration_s)
    if feats.dp_steady is None:
        reason = "no baseline" if info["baseline_dp"] is None else "too little steady running"
        log.warning("cycle %s: no dp_steady (%s); it won't count toward lint", info["cycle_no"], reason)
    else:
        log.info(
            "cycle %s features: dp_steady %.1f Pa, t_in_max %.1f °C, %.0f min",
            info["cycle_no"], feats.dp_steady, feats.t_in_max or 0, (feats.duration_s or 0) / 60,
        )  # fmt: skip
    return feats


async def _recompute(database_url: str, device_id: str, all_cycles: bool) -> int:
    db = await Database.connect(database_url)
    try:
        ids = await db.complete_cycle_ids(device_id, only_missing=not all_cycles)
        for cycle_id in ids:
            await update_cycle_features(db, cycle_id)
        return len(ids)
    finally:
        await db.close()


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Compute per-cycle features for stored cycles.")
    parser.add_argument("--all", action="store_true", help="recompute every complete cycle")
    args = parser.parse_args(argv)
    logging.basicConfig(level="INFO", format="%(levelname)-7s %(message)s")
    try:
        settings = load_settings()
    except ConfigError as e:
        raise SystemExit(str(e)) from None
    n = run_async(_recompute(settings.database_url, settings.device_id, args.all))
    print(f"updated {n} cycle(s)")


if __name__ == "__main__":
    main()

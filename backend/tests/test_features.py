"""
test_features.py - tests for dryer_backend/features.py and the lint views (backend/db/views.sql).

What it checks:
    - the steady-running window skips spin-up and cool-down, also for short cycles
    - dp_steady is the median steady ΔP minus the baseline offset; empty without a
      baseline or with too little steady running
    - every complete cycle gets features when its E line arrives
    - simulated lint buildup moves the verdict calibrating -> clean -> check_soon -> clean_now
    - pressing "Filter cleaned" (an events row) resets it to calibrating
    - a clogging exhaust duct sets possible_vent_blockage
    - thresholds can be changed in lint_settings without any code change

The database tests are skipped when Docker isn't running.
How to run (from backend/):
    uv run pytest
"""

from datetime import UTC, datetime, timedelta

import pytest

from dryer_backend.features import Point, compute_features, steady_window
from dryer_backend.ingest import run_ingest
from dryer_backend.simulator import SimBoard, SimConfig

T0 = datetime(2026, 11, 15, 12, 0, tzinfo=UTC)
SEVERITY = ["calibrating", "clean", "check_soon", "clean_now"]


def make_cycle(minutes: float, dp_run: float, offset: float = 12.0) -> list[Point]:
    """1 Hz samples: 60 s spin-up ramp, then steady dp_run (+ sensor offset)."""
    pts = []
    for s in range(int(minutes * 60)):
        dp = dp_run * min(1.0, s / 60) + offset
        t_in = 22 + 33 * min(1.0, s / 600)
        pts.append(Point(T0 + timedelta(seconds=s), dp, t_in, 22.0))
    return pts


# --------------------------------------------------------------------------- #
# Pure calculations (no database)
# --------------------------------------------------------------------------- #
def test_steady_window_long_and_short_cycles():
    assert steady_window(45 * 60) == (270.0, 45 * 60 - 270.0)  # 10% each side
    assert steady_window(15 * 60) == (120.0, 15 * 60 - 180.0)  # 2 min / 3 min minimums
    assert steady_window(4 * 60) == (60.0, 180.0)  # capped at 25% for short cycles


def test_dp_steady_is_offset_corrected_median():
    pts = make_cycle(30, dp_run=-100)
    f = compute_features(pts, T0, pts[-1].time, baseline_dp=12.0)
    assert f.dp_steady == pytest.approx(-100, abs=0.01)
    assert f.t_in_max == pytest.approx(55)
    assert f.duration_s == pytest.approx(30 * 60 - 1)
    assert f.dt_mean is not None and f.dt_mean > 20
    assert f.n_steady > 1000


def test_spin_up_does_not_drag_the_median():
    """The 60 s ramp is outside the steady window, so it can't bias dp_steady."""
    pts = make_cycle(10, dp_run=-100)
    f = compute_features(pts, T0, pts[-1].time, baseline_dp=12.0)
    assert f.dp_steady == pytest.approx(-100, abs=0.01)


def test_no_baseline_means_no_dp_steady():
    pts = make_cycle(30, dp_run=-100)
    f = compute_features(pts, T0, pts[-1].time, baseline_dp=None)
    assert f.dp_steady is None
    assert f.t_in_max is not None  # other features still computed


def test_too_short_cycle_means_no_dp_steady():
    pts = make_cycle(1, dp_run=-100)  # 1 minute: steady window < 60 s
    f = compute_features(pts, T0, pts[-1].time, baseline_dp=12.0)
    assert f.dp_steady is None


def test_no_samples():
    f = compute_features([], T0, T0 + timedelta(minutes=5), baseline_dp=12.0)
    assert f.dp_steady is None and f.t_in_max is None and f.duration_s == 300


# --------------------------------------------------------------------------- #
# With the database: simulator -> receiver -> features -> lint views
# --------------------------------------------------------------------------- #
def simulate(run, db_url, scenario: str, cycles: int):
    board = SimBoard(
        SimConfig(scenario=scenario, cycles=cycles, cycle_minutes=10, idle_minutes=2,
                  first_idle_minutes=1, speed=0, first_cycle_no=1)
    )  # fmt: skip
    run(run_ingest(board, db_url, "dryer-1", flush_interval_s=0.05))
    return board


def test_features_stored_for_every_complete_cycle(run, db_url, sql):
    simulate(run, db_url, "normal", 2)
    rows = sql("SELECT dp_steady, t_in_max, dt_mean, duration_s, features_at FROM cycles")
    assert len(rows) == 2
    for dp, t_max, dt, dur, at in rows:
        assert dp is not None and -120 < dp < -90  # ~-100 Pa (clean), offset removed
        # a 10-minute cycle only heats for 8 minutes, so it peaks around 48 °C
        assert 40 < t_max < 60 and dt > 0 and dur == pytest.approx(600, abs=2) and at


def test_lint_progression_and_filter_cleaned_reset(run, db_url, sql):
    simulate(run, db_url, "normal", 7)  # ΔP: -100, -108, ... -148 Pa

    history = [s for (s,) in sql("SELECT status FROM lint_history ORDER BY started_at")]
    assert history[0] == "calibrating"
    assert history[1] == "clean"  # second reference cycle
    assert "check_soon" in history
    assert history[-1] == "clean_now"
    levels = [SEVERITY.index(s) for s in history]
    assert levels == sorted(levels)  # only ever gets worse while lint builds up

    (status, n, vent), = sql(
        "SELECT status, cycles_since_cleaning, possible_vent_blockage FROM lint_status"
    )  # fmt: skip
    assert (status, n, vent) == ("clean_now", 7, False)

    # The dashboard's "Filter cleaned" button inserts this row:
    sql("INSERT INTO events (device_id, type) VALUES ('dryer-1', 'filter_cleaned') RETURNING id")
    assert sql("SELECT status, cycles_since_cleaning, score FROM lint_status") == [
        ("calibrating", 0, None)
    ]


def test_vent_clog_sets_flag(run, db_url, sql):
    simulate(run, db_url, "vent", 5)  # ΔP moves toward zero, hotter, longer
    (score, vent), = sql("SELECT score, possible_vent_blockage FROM lint_status")
    assert score < -0.25 and vent is True


def test_thresholds_are_tunable_without_code(run, db_url, sql):
    simulate(run, db_url, "normal", 4)
    before = sql("SELECT status FROM lint_status")[0][0]
    sql("UPDATE lint_settings SET check_soon_score = 5, clean_now_score = 10 RETURNING id")
    try:
        assert sql("SELECT status FROM lint_status") == [("clean",)]
        assert before != "clean"
    finally:
        sql("UPDATE lint_settings SET check_soon_score = 0.15, clean_now_score = 0.35 RETURNING id")

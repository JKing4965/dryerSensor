"""
test_cycles.py - end-to-end tests of the receiver (ingest.py + cycles.py + db.py)
against a real, temporary database.

What it checks:
    - the example session from docs/protocol.md lands in the right tables
    - simulated cycles are stored completely, in order, with no duplicates
    - flash uploads get timestamps from before the reconnect
    - a board restart gives estimated times
    - resending data (reconnect / receiver restart) never creates duplicates
    - a cycle without an E line is closed as incomplete, and re-opened if data returns
    - sensor error codes reach device_status
    - every stored sample is acknowledged; finished cycles get A,<cycle>,<seq>,1

Needs the database running (docker compose up -d); otherwise these tests are skipped.
How to run (from backend/):
    uv run pytest
"""

from datetime import timedelta
from pathlib import Path

from dryer_backend.ingest import run_ingest
from dryer_backend.simulator import SimBoard, SimConfig
from dryer_backend.sources import ReplaySource

DEVICE = "dryer-1"
FIXTURE = Path(__file__).parent / "fixtures" / "example_session.txt"
FAST = dict(cycle_minutes=4, idle_minutes=2, first_idle_minutes=1, speed=0, first_cycle_no=1)


def ingest(run, source, db_url):
    return run(run_ingest(source, db_url, DEVICE, flush_interval_s=0.05))


def no_duplicate_samples(sql) -> bool:
    (total, distinct), = sql(
        "SELECT count(*), count(DISTINCT (cycle_no, seq)) FROM readings WHERE kind = 'cycle'"
    )  # fmt: skip
    return total == distinct


# --------------------------------------------------------------------------- #
# Example session (docs/protocol.md section 7)
# --------------------------------------------------------------------------- #
def test_example_session(run, db_url, sql):
    source = ReplaySource.from_file(FIXTURE)
    stats = ingest(run, source, db_url)

    assert sql("SELECT cycle_no, state, n_samples, n_expected FROM cycles ORDER BY cycle_no") == [
        (7, "complete", 4, 4),
        (8, "complete", 2, 2),
    ]
    assert sql("SELECT count(*) FROM readings WHERE kind = 'cycle'") == [(6,)]
    # C7's baseline + the B line (C8 repeats the B reading, stored once)
    assert sql("SELECT count(*) FROM readings WHERE kind = 'baseline'") == [(2,)]
    assert stats.bad_lines == 0

    # cycle 7 was recorded ~30 min before the hello (board ms 1 800 000 vs 3 600 000)
    (started, hello_seen), = sql(
        "SELECT c.started_at, s.last_seen FROM cycles c, device_status s WHERE c.cycle_no = 7"
    )  # fmt: skip
    assert timedelta(minutes=29) < hello_seen - started < timedelta(minutes=31)

    # baseline offset stored on the cycle: 101300.25 - 101325.50
    assert sql("SELECT round(baseline_dp::numeric, 2) FROM cycles WHERE cycle_no = 7") == [(-25.25,)]

    sent = [d.decode().strip() for d in source.sent]
    assert sent[0].startswith("T,")
    assert "A,7,3,1" in sent and "A,8,1,1" in sent
    assert sql("SELECT connected FROM device_status") == [(False,)]  # receiver closed


# --------------------------------------------------------------------------- #
# Simulator scenarios
# --------------------------------------------------------------------------- #
def test_normal_scenario_complete_and_ordered(run, db_url, sql):
    board = SimBoard(SimConfig(scenario="normal", cycles=3, **FAST))
    stats = ingest(run, board, db_url)

    rows = sql("SELECT cycle_no, state, n_samples, n_expected FROM cycles ORDER BY cycle_no")
    assert [r[0] for r in rows] == [1, 2, 3]
    assert all(state == "complete" and n == expected for _, state, n, expected in rows)
    assert no_duplicate_samples(sql)
    assert stats.samples_stored == sum(r[2] for r in rows)
    # time increases with seq inside every cycle
    assert sql(
        "SELECT count(*) FROM (SELECT time < lag(time) OVER (PARTITION BY cycle_no ORDER BY seq) AS back "
        "FROM readings WHERE kind = 'cycle') x WHERE back"
    ) == [(0,)]
    # sensor offset seen at rest is ~12 Pa
    for (offset,) in sql("SELECT baseline_dp FROM cycles"):
        assert 5 < offset < 20
    assert board.flash == []  # every cycle acknowledged with done=1


def test_disconnect_scenario_flash_times_and_no_duplicates(run, db_url, sql):
    board = SimBoard(SimConfig(scenario="disconnect", cycles=2, **FAST))
    ingest(run, board, db_url)

    assert sql("SELECT cycle_no, state FROM cycles ORDER BY cycle_no") == [
        (1, "complete"),
        (2, "complete"),
    ]
    assert no_duplicate_samples(sql)
    first_connect = board.start + timedelta(seconds=board.reconnect_t)
    (last_flash_time, estimated), = sql(
        "SELECT max(time), bool_or(time_estimated) FROM readings WHERE cycle_no = 1"
    )  # fmt: skip
    assert last_flash_time < first_connect  # recorded before the computer connected
    assert estimated is False
    assert sql("SELECT count(*) FROM readings WHERE source = 'flash'")[0][0] > 0
    assert board.flash == []


def test_reboot_scenario_marks_times_estimated(run, db_url, sql):
    board = SimBoard(SimConfig(scenario="reboot", cycles=2, **FAST))
    ingest(run, board, db_url)

    assert sql("SELECT cycle_no, state, time_estimated FROM cycles ORDER BY cycle_no") == [
        (1, "complete", True),  # recorded before the restart, no hello for that boot
        (2, "complete", False),
    ]
    assert no_duplicate_samples(sql)


def test_sensor_error_reaches_device_status(run, db_url, sql):
    lines = [
        "H,1,5,1000,running,0,1,0",  # inside sensor missing
    ]
    ingest(run, ReplaySource(lines), db_url)
    (err_in, err_out, since), = sql(
        "SELECT sensor_in_error, sensor_out_error, sensor_error_since FROM device_status"
    )  # fmt: skip
    assert (err_in, err_out) == (1, 0) and since is not None

    ingest(run, ReplaySource(["H,1,5,2000,running,0,0,0"]), db_url)
    assert sql("SELECT sensor_in_error, sensor_out_error, sensor_error_since FROM device_status") == [
        (0, 0, None)
    ]


# --------------------------------------------------------------------------- #
# Resends, restarts and unfinished cycles
# --------------------------------------------------------------------------- #
def test_receiver_restart_and_resend_has_no_duplicates(run, db_url, sql):
    lines = FIXTURE.read_text().splitlines()
    first_part = lines[: lines.index("S,305419896,7,1,1802000,101178.10,31.02,101325.60,22.81,F") + 1]
    ingest(run, ReplaySource(first_part), db_url)  # receiver stops after 2 samples
    assert sql("SELECT state, n_samples FROM cycles WHERE cycle_no = 7") == [("running", 2)]

    ingest(run, ReplaySource(lines), db_url)  # board resends everything
    assert sql("SELECT state, n_samples FROM cycles WHERE cycle_no = 7") == [("complete", 4)]
    assert sql("SELECT count(*) FROM readings WHERE cycle_no = 7") == [(4,)]
    assert sql("SELECT count(*) FROM readings WHERE kind = 'baseline'") == [(2,)]
    assert no_duplicate_samples(sql)


def test_cycle_without_end_closed_then_reopened(run, db_url, sql):
    start = [
        "H,1,9,10000,running,1,0,0",
        "C,9,20,10000,,,,,",
        "S,9,20,0,11000,101200.00,30.00,101325.00,22.00,L",
    ]
    idle = ["H,1,9,90000,idle,0,0,0"]  # board idle, nothing left -> no E line will come
    ingest(run, ReplaySource(start + idle), db_url)
    (state, ended_at, started_at), = sql("SELECT state, ended_at, started_at FROM cycles")
    assert state == "incomplete" and ended_at - started_at == timedelta(seconds=1)

    more = ["S,9,20,1,12000,101200.00,30.00,101325.00,22.00,F", "E,9,20,13000,2"]
    ingest(run, ReplaySource(["H,1,9,100000,uploading,1,0,0", *more]), db_url)
    assert sql("SELECT state, n_samples, n_expected FROM cycles") == [("complete", 2, 2)]


def test_running_cycle_kept_open_while_board_running(run, db_url, sql):
    lines = [
        "H,1,9,10000,running,0,0,0",
        "C,9,21,10000,,,,,",
        "S,9,21,0,11000,101200.00,30.00,101325.00,22.00,L",
        "H,1,9,40000,running,0,0,0",  # still running, backlog 0 -> keep it open
    ]
    ingest(run, ReplaySource(lines), db_url)
    assert sql("SELECT state FROM cycles") == [("running",)]


def test_bad_lines_are_skipped(run, db_url, sql):
    lines = ["garbage", "H,1,9,1000,idle,0,0,0", "S,9,1,0,2000,1013.25,30,101325,22,L", "# hi"]
    stats = ingest(run, ReplaySource(lines), db_url)
    assert stats.bad_lines == 2  # "garbage" and the hPa sample
    assert sql("SELECT count(*) FROM readings") == [(0,)]

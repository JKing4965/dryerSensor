"""
test_timesync.py - tests for dryer_backend/timesync.py.

What it checks:
    - an H line links board ms to real time, live and flash samples convert correctly
    - the 32-bit millis() wrap (~49.7 days) is handled
    - a newer hello replaces the older link
    - samples from an unknown boot get an estimated time and are flagged
    - an unknown boot becomes exact once its hello arrives

How to run (from backend/):
    uv run pytest
"""

from datetime import UTC, datetime, timedelta

from dryer_backend.timesync import TimeSync, ms_diff

T0 = datetime(2026, 11, 14, 12, 0, 0, tzinfo=UTC)


def fixed_clock(t: datetime):
    return lambda: t


def test_ms_diff_plain_and_wrapped():
    assert ms_diff(5000, 2000) == 3000
    assert ms_diff(2000, 5000) == -3000
    # 100 ms after the wrap vs 100 ms before it -> 200 ms apart
    assert ms_diff(100, 2**32 - 100) == 200
    assert ms_diff(2**32 - 100, 100) == -200


def test_hello_links_board_time_to_real_time():
    sync = TimeSync(now=fixed_clock(T0))
    sync.on_hello(boot_id=42, ms=3_600_000)  # board has been up 1 h at T0
    when, estimated = sync.to_time(42, 1_800_000)  # flash sample from 30 min earlier
    assert when == T0 - timedelta(minutes=30)
    assert estimated is False
    assert sync.current_boot_id == 42
    assert sync.is_exact(42)


def test_example_session_backlog_lands_before_connection():
    """docs/protocol.md example: cycle 7 was recorded ~30 min before the hello."""
    sync = TimeSync(now=fixed_clock(T0))
    sync.on_hello(305419896, 3_600_000)
    start, _ = sync.to_time(305419896, 1_800_000)
    end, _ = sync.to_time(305419896, 1_805_000)
    assert start < end < T0
    assert end - start == timedelta(seconds=5)


def test_wrap_between_sample_and_hello():
    sync = TimeSync(now=fixed_clock(T0))
    sync.on_hello(7, ms=500)  # hello just after millis() wrapped
    when, _ = sync.to_time(7, 2**32 - 1500)  # sample 2 s earlier, before the wrap
    assert when == T0 - timedelta(seconds=2)


def test_newer_hello_wins():
    sync = TimeSync(now=fixed_clock(T0))
    sync.on_hello(1, 10_000)
    sync.on_hello(1, 40_000, received_at=T0 + timedelta(seconds=30, milliseconds=50))
    when, _ = sync.to_time(1, 40_000)
    assert when == T0 + timedelta(seconds=30, milliseconds=50)


def test_unknown_boot_is_estimated_from_arrival_time():
    sync = TimeSync(now=fixed_clock(T0))
    sync.on_hello(2, 1000)  # current boot
    first, est1 = sync.to_time(1, 50_000)  # old boot, never said hello
    later, est2 = sync.to_time(1, 51_000)
    assert est1 and est2
    assert first == T0
    assert later - first == timedelta(seconds=1)  # spacing between samples is kept
    assert not sync.is_exact(1)


def test_unknown_boot_becomes_exact_after_hello():
    sync = TimeSync(now=fixed_clock(T0))
    _, estimated = sync.to_time(9, 5000)
    assert estimated
    sync.on_hello(9, 10_000, received_at=T0 + timedelta(seconds=1))
    when, estimated = sync.to_time(9, 5000)
    assert not estimated
    assert when == T0 + timedelta(seconds=1) - timedelta(seconds=5)

"""
timesync.py - converts the board's millis() values into real timestamps.

What it does:
    The board only knows milliseconds since it powered up (`ms`, which wraps every
    ~49.7 days). Each power-up has its own random `boot_id`. Every H (hello) line
    gives an exact link: "board ms X of boot B happened now". TimeSync remembers the
    latest link per boot and converts any (boot_id, ms) into a UTC datetime.

    If a message arrives for a boot that has never sent a hello, which happens when the
    board restarted between recording and uploading, its time is ESTIMATED from when
    the first message of that boot arrived, and flagged with estimated=True.

Talks to:
    - Rules described in docs/protocol.md, section 6.
    - Used by ingest.py (step B3). Tested by backend/tests/test_timesync.py.

How to use:
    sync = TimeSync()
    sync.on_hello(hello.boot_id, hello.ms)            # on every H line
    when, estimated = sync.to_time(sample.boot_id, sample.ms)
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

_WRAP = 2**32
_HALF = 2**31


def ms_diff(a: int, b: int) -> int:
    """a - b in milliseconds for 32-bit millis() values, correct across one wrap.

    Valid while the two values are less than ~24.8 days apart.
    """
    return ((a - b + _HALF) % _WRAP) - _HALF


def utc_now() -> datetime:
    return datetime.now(UTC)


@dataclass(slots=True)
class _Anchor:
    """'Board ms `ms` of this boot happened at `time`'."""

    time: datetime
    ms: int
    exact: bool  # True = from an H line, False = estimated from arrival time


class TimeSync:
    def __init__(self, now: Callable[[], datetime] = utc_now):
        self._now = now
        self._anchors: dict[int, _Anchor] = {}
        self.current_boot_id: int | None = None

    def on_hello(self, boot_id: int, ms: int, received_at: datetime | None = None) -> None:
        """Record an exact link from an H line. The newest hello for a boot wins."""
        self._anchors[boot_id] = _Anchor(received_at or self._now(), ms, exact=True)
        self.current_boot_id = boot_id

    def is_exact(self, boot_id: int) -> bool:
        anchor = self._anchors.get(boot_id)
        return bool(anchor and anchor.exact)

    def to_time(
        self, boot_id: int, ms: int, received_at: datetime | None = None
    ) -> tuple[datetime, bool]:
        """Return (UTC time, estimated) for a board timestamp."""
        anchor = self._anchors.get(boot_id)
        if anchor is None:
            # Unknown boot: assume this first message happened when it arrived.
            anchor = _Anchor(received_at or self._now(), ms, exact=False)
            self._anchors[boot_id] = anchor
        when = anchor.time + timedelta(milliseconds=ms_diff(ms, anchor.ms))
        return when, not anchor.exact

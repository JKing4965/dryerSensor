"""
sources.py - where the receiver's data comes from (BLE, simulator or a replay file).

What it does:
    Every source looks the same to ingest.py. It produces a stream of events:
        DataEvent(data, received_at)       raw bytes as they arrived (may be part of a line)
        LinkEvent(connected, received_at)  the connection went up or down
    and has send(data) so the receiver can reply to the board (T and A lines).

    Sources:
        ReplaySource   lines from a text file (e.g. tests/fixtures/example_session.txt)
        SimBoard       fake board, defined in simulator.py
        BleSource      real board over Bluetooth, defined in ble_link.py

Talks to:
    - ingest.py consumes the events.
    - simulator.py implements the same interface.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Callable, Iterable
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Protocol

from dryer_backend.timesync import utc_now


@dataclass(frozen=True, slots=True)
class DataEvent:
    """Bytes received from the board. One event may hold part of a line or several lines."""

    data: bytes
    received_at: datetime


@dataclass(frozen=True, slots=True)
class LinkEvent:
    """The connection to the board went up (connected=True) or down."""

    connected: bool
    received_at: datetime


SourceEvent = DataEvent | LinkEvent


class Source(Protocol):
    name: str

    def events(self) -> AsyncIterator[SourceEvent]:
        """Yield events until the source ends (file finished, simulation over, Ctrl+C)."""
        ...

    async def send(self, data: bytes) -> None:
        """Send bytes to the board (computer -> board lines)."""
        ...


class ReplaySource:
    """Plays back protocol lines from a list or text file, as if a board sent them now.

    Every line is stamped with the current time when it is played. Board timestamps are
    still converted correctly relative to the H lines in the file.
    """

    name = "replay"

    def __init__(self, lines: Iterable[str], clock: Callable[[], datetime] = utc_now):
        self._lines = [line.rstrip("\r\n") for line in lines]
        self._clock = clock
        self.sent: list[bytes] = []  # replies the receiver sent (for tests / debugging)

    @classmethod
    def from_file(cls, path: str | Path) -> ReplaySource:
        return cls(Path(path).read_text(encoding="utf-8").splitlines())

    async def events(self) -> AsyncIterator[SourceEvent]:
        yield LinkEvent(True, self._clock())
        for line in self._lines:
            yield DataEvent((line + "\n").encode("ascii", errors="replace"), self._clock())
            await asyncio.sleep(0)  # let other tasks (e.g. the flush timer) run
        yield LinkEvent(False, self._clock())

    async def send(self, data: bytes) -> None:
        self.sent.append(data)

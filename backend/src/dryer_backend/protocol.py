"""
protocol.py - turns raw Bluetooth bytes into typed messages (and builds replies).

What it does:
    - LineAssembler joins Bluetooth packets into complete text lines. One line can be
      split across packets, and one packet can hold several lines.
    - parse_line() checks one line against docs/protocol.md and returns a dataclass
      (Hello, Baseline, CycleStart, Sample, CycleEnd or Comment), or raises ParseError.
      Hello carries the two sensor error codes (SensorError: 0 ok, 1 missing, 2 broken).
    - encode_time() / encode_ack() / encode_test_cycle() build the lines the computer sends
      to the board (T, A, and M for dashboard-triggered test cycles).

Talks to:
    - docs/protocol.md is the specification this file implements. Change both together.
    - Used by sources.py / ingest.py (step B3) and ble_link.py (step B4).
    - Tested by backend/tests/test_protocol.py.

How to use:
    asm = LineAssembler()
    for line in asm.feed(packet_bytes):
        try:
            msg = parse_line(line)
        except ParseError as e:
            log and skip
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import IntEnum
from typing import Literal

PROTOCOL_VERSION = 1
MAX_LINE_LENGTH = 200

UINT32_MAX = 2**32 - 1
PRESSURE_RANGE_PA = (30_000.0, 125_000.0)  # BMP585 measuring range
TEMPERATURE_RANGE_C = (-40.0, 85.0)  # BMP585 operating range

BOARD_STATES = ("idle", "running", "uploading")


class SensorError(IntEnum):
    """Sensor error codes from the H line (docs/protocol.md section 3.1)."""

    OK = 0  # found and giving valid readings
    MISSING = 1  # cannot be found on the I2C bus
    BROKEN = 2  # answers, but readings fail or are out of range 3 times in a row


class ParseError(ValueError):
    """A line that doesn't follow docs/protocol.md. The receiver logs it and moves on."""

    def __init__(self, reason: str, line: str):
        super().__init__(f"{reason}: {line!r}")
        self.reason = reason
        self.line = line


# --------------------------------------------------------------------------- #
# Message types (one dataclass per line type in docs/protocol.md)
# --------------------------------------------------------------------------- #
@dataclass(frozen=True, slots=True)
class Hello:
    """H line: sent first on every connection, every 30 s, and when a sensor error changes."""

    version: int
    boot_id: int
    ms: int
    state: Literal["idle", "running", "uploading"]
    backlog_count: int
    err_in: SensorError  # sensor under the lint screen
    err_out: SensorError  # room-air sensor

    @property
    def sensors_ok(self) -> bool:
        return self.err_in == SensorError.OK and self.err_out == SensorError.OK


@dataclass(frozen=True, slots=True)
class Baseline:
    """B line: idle reading (dryer off), live only."""

    boot_id: int
    ms: int
    p_in: float
    t_in: float
    p_out: float
    t_out: float


@dataclass(frozen=True, slots=True)
class CycleStart:
    """C line: a cycle began. Baseline fields are None if the board had no idle reading."""

    boot_id: int
    cycle_no: int
    ms: int
    base_ms: int | None
    base_p_in: float | None
    base_t_in: float | None
    base_p_out: float | None
    base_t_out: float | None

    @property
    def has_baseline(self) -> bool:
        return self.base_ms is not None


@dataclass(frozen=True, slots=True)
class Sample:
    """S line: one reading of both sensors during a cycle."""

    boot_id: int
    cycle_no: int
    seq: int
    ms: int
    p_in: float
    t_in: float
    p_out: float
    t_out: float
    source: Literal["live", "flash"]


@dataclass(frozen=True, slots=True)
class CycleEnd:
    """E line: the cycle is over; n_samples is the total number of S lines sent for it."""

    boot_id: int
    cycle_no: int
    ms: int
    n_samples: int


@dataclass(frozen=True, slots=True)
class Comment:
    """# line: debug text from the firmware."""

    text: str


Message = Hello | Baseline | CycleStart | Sample | CycleEnd | Comment


# --------------------------------------------------------------------------- #
# Joining Bluetooth packets into lines
# --------------------------------------------------------------------------- #
class LineAssembler:
    """Collects bytes until a newline, then yields the finished line (without '\\r\\n').

    Lines longer than MAX_LINE_LENGTH are dropped (counted in `dropped`) so random
    noise can't grow the buffer forever. Blank lines are skipped.
    """

    def __init__(self, max_length: int = MAX_LINE_LENGTH):
        self.max_length = max_length
        self._buf = bytearray()
        self._discarding = False  # inside an overlong line, skip until next newline
        self.dropped = 0

    def feed(self, data: bytes) -> list[str]:
        lines: list[str] = []
        for byte in data:
            if byte == 0x0A:  # '\n'
                if self._discarding:
                    self._discarding = False
                else:
                    line = self._buf.decode("ascii", errors="replace").rstrip("\r")
                    if line.strip():
                        lines.append(line)
                self._buf.clear()
                continue
            if self._discarding:
                continue
            self._buf.append(byte)
            if len(self._buf) > self.max_length:
                self._buf.clear()
                self._discarding = True
                self.dropped += 1
        return lines

    @property
    def pending(self) -> bytes:
        """Bytes received so far for an unfinished line (useful for debugging)."""
        return bytes(self._buf)


# --------------------------------------------------------------------------- #
# Field helpers
# --------------------------------------------------------------------------- #
def _uint32(value: str, name: str, line: str) -> int:
    try:
        n = int(value)
    except ValueError:
        raise ParseError(f"{name} is not a whole number", line) from None
    if not 0 <= n <= UINT32_MAX:
        raise ParseError(f"{name} out of range 0..{UINT32_MAX}", line)
    return n


def _number(value: str, name: str, lo: float, hi: float, line: str) -> float:
    try:
        x = float(value)
    except ValueError:
        raise ParseError(f"{name} is not a number", line) from None
    if not lo <= x <= hi:  # also rejects nan
        raise ParseError(f"{name}={x} outside {lo}..{hi}", line)
    return x


def _pressure(value: str, name: str, line: str) -> float:
    return _number(value, name, *PRESSURE_RANGE_PA, line)


def _temperature(value: str, name: str, line: str) -> float:
    return _number(value, name, *TEMPERATURE_RANGE_C, line)


def _sensor_error(value: str, name: str, line: str) -> SensorError:
    try:
        return SensorError(int(value))
    except ValueError:
        codes = ", ".join(f"{e.value}={e.name.lower()}" for e in SensorError)
        raise ParseError(f"{name} must be one of {codes}", line) from None


def _expect_fields(fields: list[str], counts: tuple[int, ...], line: str) -> None:
    if len(fields) not in counts:
        want = " or ".join(str(c) for c in counts)
        raise ParseError(f"expected {want} fields, got {len(fields)}", line)


# --------------------------------------------------------------------------- #
# Parsing
# --------------------------------------------------------------------------- #
def parse_line(line: str) -> Message:
    """Parse one complete line (no trailing newline needed). Raises ParseError."""
    line = line.strip()
    if not line:
        raise ParseError("empty line", line)
    if line.startswith("#"):
        return Comment(line[1:].strip())

    fields = line.split(",")
    kind = fields[0]

    if kind == "H":
        _expect_fields(fields, (8,), line)
        version = _uint32(fields[1], "version", line)
        if version != PROTOCOL_VERSION:
            raise ParseError(f"unsupported protocol version {version}", line)
        state = fields[4]
        if state not in BOARD_STATES:
            raise ParseError(f"unknown state {state!r}", line)
        return Hello(
            version=version,
            boot_id=_uint32(fields[2], "boot_id", line),
            ms=_uint32(fields[3], "ms", line),
            state=state,  # type: ignore[arg-type]
            backlog_count=_uint32(fields[5], "backlog_count", line),
            err_in=_sensor_error(fields[6], "err_in", line),
            err_out=_sensor_error(fields[7], "err_out", line),
        )

    if kind == "B":
        _expect_fields(fields, (7,), line)
        return Baseline(
            boot_id=_uint32(fields[1], "boot_id", line),
            ms=_uint32(fields[2], "ms", line),
            p_in=_pressure(fields[3], "p_in", line),
            t_in=_temperature(fields[4], "t_in", line),
            p_out=_pressure(fields[5], "p_out", line),
            t_out=_temperature(fields[6], "t_out", line),
        )

    if kind == "C":
        _expect_fields(fields, (4, 9), line)
        boot_id = _uint32(fields[1], "boot_id", line)
        cycle_no = _uint32(fields[2], "cycle_no", line)
        ms = _uint32(fields[3], "ms", line)
        base = fields[4:9]
        if not base or all(f == "" for f in base):
            return CycleStart(boot_id, cycle_no, ms, None, None, None, None, None)
        if any(f == "" for f in base):
            raise ParseError("baseline fields must be all filled or all empty", line)
        return CycleStart(
            boot_id=boot_id,
            cycle_no=cycle_no,
            ms=ms,
            base_ms=_uint32(base[0], "base_ms", line),
            base_p_in=_pressure(base[1], "base_p_in", line),
            base_t_in=_temperature(base[2], "base_t_in", line),
            base_p_out=_pressure(base[3], "base_p_out", line),
            base_t_out=_temperature(base[4], "base_t_out", line),
        )

    if kind == "S":
        _expect_fields(fields, (10,), line)
        src = fields[9]
        if src not in ("L", "F"):
            raise ParseError(f"src must be L or F, got {src!r}", line)
        return Sample(
            boot_id=_uint32(fields[1], "boot_id", line),
            cycle_no=_uint32(fields[2], "cycle_no", line),
            seq=_uint32(fields[3], "seq", line),
            ms=_uint32(fields[4], "ms", line),
            p_in=_pressure(fields[5], "p_in", line),
            t_in=_temperature(fields[6], "t_in", line),
            p_out=_pressure(fields[7], "p_out", line),
            t_out=_temperature(fields[8], "t_out", line),
            source="live" if src == "L" else "flash",
        )

    if kind == "E":
        _expect_fields(fields, (5,), line)
        return CycleEnd(
            boot_id=_uint32(fields[1], "boot_id", line),
            cycle_no=_uint32(fields[2], "cycle_no", line),
            ms=_uint32(fields[3], "ms", line),
            n_samples=_uint32(fields[4], "n_samples", line),
        )

    raise ParseError(f"unknown message type {kind!r}", line)


# --------------------------------------------------------------------------- #
# Computer -> board
# --------------------------------------------------------------------------- #
def encode_time(unix_ms: int) -> bytes:
    """T line: tells the board the real time (ms since 1970, UTC)."""
    return f"T,{int(unix_ms)}\n".encode("ascii")


def encode_ack(cycle_no: int, seq: int, done: bool) -> bytes:
    """A line: everything up to seq of cycle_no is stored; done=True -> board may erase it."""
    return f"A,{cycle_no},{seq},{1 if done else 0}\n".encode("ascii")


def encode_test_cycle(start: bool, seconds: int = 0) -> bytes:
    """M line: start a test cycle now (auto-end after `seconds` if > 0), or end the current cycle."""
    if not start:
        return b"M,0\n"
    if seconds > 0:
        return f"M,1,{int(seconds)}\n".encode("ascii")
    return b"M,1\n"

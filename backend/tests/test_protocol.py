"""
test_protocol.py - tests for dryer_backend/protocol.py.

What it checks:
    - every message type in docs/protocol.md parses into the right dataclass
    - sensor error codes in the H line (0 ok, 1 missing, 2 broken)
    - bad lines (wrong field count, bad numbers, out-of-range values) raise ParseError
    - LineAssembler rebuilds lines split across Bluetooth packets
    - the example session in docs/protocol.md (tests/fixtures/example_session.txt) parses fully
    - replies to the board (T and A lines) are formatted correctly

How to run (from backend/):
    uv run pytest
"""

from pathlib import Path

import pytest

from dryer_backend.protocol import (
    MAX_LINE_LENGTH,
    Baseline,
    Comment,
    CycleEnd,
    CycleStart,
    Hello,
    LineAssembler,
    ParseError,
    Sample,
    SensorError,
    encode_ack,
    encode_test_cycle,
    encode_time,
    parse_line,
)

FIXTURES = Path(__file__).parent / "fixtures"
DOCS = Path(__file__).parents[2] / "docs" / "protocol.md"


# --------------------------------------------------------------------------- #
# Valid lines
# --------------------------------------------------------------------------- #
def test_hello():
    msg = parse_line("H,1,305419896,3600000,uploading,4,0,0")
    assert msg == Hello(
        version=1,
        boot_id=305419896,
        ms=3600000,
        state="uploading",
        backlog_count=4,
        err_in=SensorError.OK,
        err_out=SensorError.OK,
    )
    assert msg.sensors_ok


@pytest.mark.parametrize(
    "codes, err_in, err_out",
    [
        ("1,0", SensorError.MISSING, SensorError.OK),
        ("0,2", SensorError.OK, SensorError.BROKEN),
        ("2,1", SensorError.BROKEN, SensorError.MISSING),
    ],
)
def test_hello_sensor_errors(codes, err_in, err_out):
    msg = parse_line(f"H,1,1,1000,idle,0,{codes}")
    assert isinstance(msg, Hello)
    assert (msg.err_in, msg.err_out) == (err_in, err_out)
    assert not msg.sensors_ok


def test_baseline():
    assert parse_line("B,1,2000,101300.10,23.40,101325.20,22.90") == Baseline(
        boot_id=1, ms=2000, p_in=101300.10, t_in=23.40, p_out=101325.20, t_out=22.90
    )


def test_cycle_start_with_baseline():
    msg = parse_line("C,1,7,1800000,1770000,101300.25,23.10,101325.50,22.80")
    assert isinstance(msg, CycleStart)
    assert msg.cycle_no == 7 and msg.base_ms == 1770000 and msg.base_p_in == 101300.25
    assert msg.has_baseline


@pytest.mark.parametrize("line", ["C,1,7,1800000,,,,,", "C,1,7,1800000"])
def test_cycle_start_without_baseline(line):
    msg = parse_line(line)
    assert isinstance(msg, CycleStart)
    assert not msg.has_baseline
    assert msg.base_p_in is None and msg.base_t_out is None


def test_sample_live_and_flash():
    live = parse_line("S,1,7,0,1801000,101180.40,30.55,101325.40,22.81,L")
    flash = parse_line("S,1,7,1,1802000,101178.10,31.02,101325.60,22.81,F")
    assert live == Sample(1, 7, 0, 1801000, 101180.40, 30.55, 101325.40, 22.81, "live")
    assert isinstance(flash, Sample) and flash.source == "flash"


def test_cycle_end():
    assert parse_line("E,1,7,1805000,4") == CycleEnd(boot_id=1, cycle_no=7, ms=1805000, n_samples=4)


def test_comment():
    assert parse_line("# hello from firmware") == Comment("hello from firmware")


def test_surrounding_whitespace_and_cr_ignored():
    assert isinstance(parse_line("  E,1,7,1805000,4\r"), CycleEnd)


def test_uint32_limits_accepted():
    msg = parse_line("E,4294967295,4294967295,4294967295,0")
    assert isinstance(msg, CycleEnd) and msg.ms == 2**32 - 1


# --------------------------------------------------------------------------- #
# Bad lines
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    "line, reason",
    [
        ("", "empty"),
        ("X,1,2,3", "unknown message type"),
        ("H,2,1,1000,idle,0,0,0", "unsupported protocol version"),
        ("H,1,1,1000,sleeping,0,0,0", "unknown state"),
        ("H,1,1,1000,idle,0", "expected 8 fields"),  # old 6-field hello without error codes
        ("H,1,1,1000,idle,0,3,0", "err_in must be one of"),
        ("H,1,1,1000,idle,0,0,x", "err_out must be one of"),
        ("E,1,7,1805000", "expected 5 fields"),
        ("E,1,7,abc,4", "ms is not a whole number"),
        ("E,1,7,-5,4", "out of range"),
        ("E,1,7,4294967296,4", "out of range"),
        ("S,1,7,0,1000,1013.25,30.0,101325.0,22.0,L", "p_in"),  # hPa sent instead of Pa
        ("S,1,7,0,1000,101300.0,120.0,101325.0,22.0,L", "t_in"),  # too hot for the sensor
        ("S,1,7,0,1000,101300.0,nan,101325.0,22.0,L", "t_in"),
        ("S,1,7,0,1000,101300.0,30.0,101325.0,22.0,X", "src must be L or F"),
        ("S,1,7,0,1000,101300.0,30.0,101325.0,22.0", "expected 10 fields"),
        ("C,1,7,1000,1000,,,,", "all filled or all empty"),
        ("C,1,7,1000,1000,101300.0", "expected 4 or 9 fields"),
    ],
)
def test_bad_lines(line, reason):
    with pytest.raises(ParseError, match=reason):
        parse_line(line)


def test_spaces_around_numbers_tolerated():
    # The spec says "no spaces", but Python's int()/float() accept them and being
    # lenient here costs nothing.
    assert isinstance(parse_line("S, 1,7,0,1000,101300.0,30.0,101325.0,22.0,L"), Sample)


# --------------------------------------------------------------------------- #
# Joining packets into lines
# --------------------------------------------------------------------------- #
def test_assembler_rejoins_20_byte_packets():
    line = "S,305419896,7,0,1801000,101180.40,30.55,101325.40,22.81,F\n"
    data = line.encode() * 3
    asm = LineAssembler()
    out = []
    for i in range(0, len(data), 20):  # default BLE packet size
        out += asm.feed(data[i : i + 20])
    assert out == [line.strip()] * 3
    assert asm.pending == b""


def test_assembler_several_lines_in_one_packet_and_crlf():
    asm = LineAssembler()
    assert asm.feed(b"E,1,7,1,0\r\n# hi\r\nE,1,8") == ["E,1,7,1,0", "# hi"]
    assert asm.pending == b"E,1,8"
    assert asm.feed(b",1,0\n") == ["E,1,8,1,0"]


def test_assembler_skips_blank_lines():
    assert LineAssembler().feed(b"\n\r\n  \nE,1,7,1,0\n") == ["E,1,7,1,0"]


def test_assembler_drops_overlong_line_then_recovers():
    asm = LineAssembler()
    junk = b"x" * (MAX_LINE_LENGTH + 50)
    assert asm.feed(junk) == []
    assert asm.feed(b"still junk\nE,1,7,1,0\n") == ["E,1,7,1,0"]
    assert asm.dropped == 1


def test_assembler_non_ascii_becomes_parse_error_not_crash():
    lines = LineAssembler().feed(b"E,1,\xff7,1,0\n")
    assert len(lines) == 1
    with pytest.raises(ParseError):
        parse_line(lines[0])


# --------------------------------------------------------------------------- #
# Example session from docs/protocol.md
# --------------------------------------------------------------------------- #
def test_example_session_fixture_parses():
    lines = (FIXTURES / "example_session.txt").read_text().splitlines()
    msgs = [parse_line(line) for line in lines if line.strip()]
    kinds = [type(m).__name__ for m in msgs if not isinstance(m, Comment)]
    assert kinds == (
        ["Hello", "CycleStart"] + ["Sample"] * 4 + ["CycleEnd", "Baseline", "CycleStart"]
        + ["Sample"] * 2 + ["CycleEnd"]
    )


def test_fixture_matches_protocol_doc_example():
    """The fixture must stay identical to the example in docs/protocol.md."""
    doc = DOCS.read_text(encoding="utf-8")
    block = doc.split("## 7. Example session", 1)[1].split("```", 2)[1]
    doc_lines = [line for line in block.splitlines() if line.strip()]
    fixture_lines = (FIXTURES / "example_session.txt").read_text().splitlines()
    while fixture_lines and fixture_lines[0].startswith("#"):  # skip the file's header comment
        fixture_lines.pop(0)
    assert [line for line in fixture_lines if line.strip()] == doc_lines


# --------------------------------------------------------------------------- #
# Computer -> board
# --------------------------------------------------------------------------- #
def test_encode_time():
    assert encode_time(1794672000000) == b"T,1794672000000\n"


def test_encode_ack():
    assert encode_ack(7, 3, done=False) == b"A,7,3,0\n"
    assert encode_ack(7, 3, done=True) == b"A,7,3,1\n"


def test_encode_test_cycle():
    assert encode_test_cycle(True, 600) == b"M,1,600\n"
    assert encode_test_cycle(True) == b"M,1\n"  # until M,0
    assert encode_test_cycle(True, 0) == b"M,1\n"
    assert encode_test_cycle(False) == b"M,0\n"

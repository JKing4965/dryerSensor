"""
test_simulator.py - tests for dryer_backend/simulator.py (no database needed).

What it checks:
    - every line the fake board sends follows docs/protocol.md
    - packets are at most 20 bytes, like Bluetooth
    - each cycle's E line counts exactly the S lines sent for it
    - the board erases a cycle from flash only after A,<cycle>,<seq>,1
    - the disconnect scenario uploads from flash and drops the link once mid-upload
    - the sensor_error scenario reports codes and sends no samples during the error

How to run (from backend/):
    uv run pytest
"""

from collections import Counter

from dryer_backend.protocol import (
    CycleEnd,
    CycleStart,
    Hello,
    LineAssembler,
    Sample,
    SensorError,
    encode_ack,
    parse_line,
)
from dryer_backend.simulator import PACKET_SIZE, SimBoard, SimConfig
from dryer_backend.sources import DataEvent, LinkEvent

FAST = dict(cycle_minutes=4, idle_minutes=2, first_idle_minutes=1, speed=0, first_cycle_no=1)


def collect(board: SimBoard, run, ack: bool = False):
    """Run the board to the end. Returns (messages, link events). Optionally acks like a receiver."""

    async def go():
        asm, msgs, links = LineAssembler(), [], []
        async for ev in board.events():
            if isinstance(ev, LinkEvent):
                links.append(ev.connected)
                continue
            assert isinstance(ev, DataEvent) and len(ev.data) <= PACKET_SIZE
            for line in asm.feed(ev.data):
                msg = parse_line(line)  # raises if the simulator breaks the protocol
                msgs.append(msg)
                if ack and isinstance(msg, Sample):
                    await board.send(encode_ack(msg.cycle_no, msg.seq, done=False))
                if ack and isinstance(msg, CycleEnd):
                    await board.send(encode_ack(msg.cycle_no, msg.n_samples - 1, done=True))
        return msgs, links

    return run(go())


def test_normal_lines_follow_protocol(run):
    msgs, links = collect(SimBoard(SimConfig(cycles=2, **FAST)), run)
    kinds = Counter(type(m).__name__ for m in msgs)
    assert kinds["CycleStart"] == 2 and kinds["CycleEnd"] == 2
    assert kinds["Hello"] > 0 and kinds["Baseline"] > 0
    assert links == [True, False]
    assert isinstance(msgs[0], Hello)
    for end in (m for m in msgs if isinstance(m, CycleEnd)):
        sent = [m for m in msgs if isinstance(m, Sample) and m.cycle_no == end.cycle_no]
        assert len(sent) == end.n_samples
        assert [s.seq for s in sent] == list(range(end.n_samples))


def test_cycle_start_carries_baseline_with_sensor_offset(run):
    msgs, _ = collect(SimBoard(SimConfig(cycles=1, **FAST)), run)
    start = next(m for m in msgs if isinstance(m, CycleStart))
    assert start.has_baseline
    offset = start.base_p_in - start.base_p_out  # type: ignore[operator]
    assert 0 < offset < 25  # ~12 Pa built-in offset


def test_flash_erased_only_after_done_ack(run):
    board = SimBoard(SimConfig(cycles=1, **FAST))
    collect(board, run, ack=False)
    assert len(board.flash) == 1  # nobody acknowledged -> still in flash
    board = SimBoard(SimConfig(cycles=1, **FAST))
    collect(board, run, ack=True)
    assert board.flash == []


def test_disconnect_scenario_uploads_from_flash_and_drops_once(run):
    msgs, links = collect(SimBoard(SimConfig(scenario="disconnect", cycles=2, **FAST)), run)
    assert links[:3] == [True, False, True]  # connect, drop mid-upload, reconnect
    flash = [m for m in msgs if isinstance(m, Sample) and m.source == "flash"]
    live = [m for m in msgs if isinstance(m, Sample) and m.source == "live"]
    assert flash and live
    assert isinstance(msgs[0], Hello) and msgs[0].state == "uploading"


def test_sensor_error_scenario(run):
    msgs, _ = collect(SimBoard(SimConfig(scenario="sensor_error", cycles=2, **FAST)), run)
    hellos = [m for m in msgs if isinstance(m, Hello)]
    codes = {(h.err_in, h.err_out) for h in hellos}
    assert (SensorError.MISSING, SensorError.OK) in codes
    assert (SensorError.OK, SensorError.BROKEN) in codes
    first_end = next(m for m in msgs if isinstance(m, CycleEnd))
    assert first_end.n_samples < 4 * 60  # ~10% of the 4-minute cycle had no samples

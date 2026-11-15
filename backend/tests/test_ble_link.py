"""
test_ble_link.py - tests for dryer_backend/ble_link.py using a FAKE Bluetooth client.

What it checks (no board or Bluetooth adapter needed):
    - not found -> retries; found -> LinkEvent(up), data events, LinkEvent(down) on drop
    - reconnects by itself after the link drops
    - replies are split into chunks that fit the connection (20 bytes, or MTU-3)
    - sending while disconnected raises instead of hanging
    - end to end: lines from the fake board are stored in the test database and
      the receiver's T / A replies are written back to the board's RX characteristic

The real-hardware check is manual (CHECKPOINT 5 in docs/build_plan.md).
How to run (from backend/):
    uv run pytest
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from types import SimpleNamespace

import pytest
from bleak.exc import BleakError

from dryer_backend.ble_link import NUS_RX_CHAR_UUID, NUS_TX_CHAR_UUID, BleSource
from dryer_backend.ingest import run_ingest
from dryer_backend.sources import DataEvent, LinkEvent

FIXTURE = Path(__file__).parent / "fixtures" / "example_session.txt"
DEVICE = SimpleNamespace(name="XIAO-BLE", address="AA:BB:CC:DD:EE:FF")


class FakeClient:
    """Stands in for bleak.BleakClient. Plays `lines` as 20-byte notifications."""

    instances: list[FakeClient] = []

    def __init__(self, device, disconnected_callback, *, lines=(), drop_after=True, mtu=23):
        self.device = device
        self._on_disconnect = disconnected_callback
        self.lines = list(lines)
        self.drop_after = drop_after
        self.mtu_size = mtu
        self.is_connected = False
        self.writes: list[tuple[str, bytes]] = []
        self._task: asyncio.Task | None = None
        FakeClient.instances.append(self)

    async def __aenter__(self):
        self.is_connected = True
        return self

    async def __aexit__(self, *exc):
        self.is_connected = False
        if self._task:
            self._task.cancel()

    async def start_notify(self, char, callback):
        assert char == NUS_TX_CHAR_UUID
        self._task = asyncio.create_task(self._play(callback))

    async def _play(self, callback):
        data = "".join(line + "\n" for line in self.lines).encode()
        for i in range(0, len(data), 20):
            callback(None, bytearray(data[i : i + 20]))
            await asyncio.sleep(0)
        if self.drop_after:
            await asyncio.sleep(0.05)
            self.is_connected = False
            self._on_disconnect(self)

    async def write_gatt_char(self, char, data, response=None):
        self.writes.append((char, bytes(data)))


def make_source(finds, **client_kwargs) -> BleSource:
    """BleSource whose scanner returns the items of `finds` in turn (None = not found)."""
    finds = list(finds)

    async def find():
        return finds.pop(0) if finds else DEVICE

    FakeClient.instances.clear()
    return BleSource(
        device_name="XIAO-BLE",
        retry_min_s=0.01,
        retry_max_s=0.02,
        find_device=find,
        client_factory=lambda dev, disconnected_callback: FakeClient(
            dev, disconnected_callback, **client_kwargs
        ),
    )


async def take(source: BleSource, n: int, timeout: float = 3.0) -> list:
    """First n events from the source (then stop it)."""
    out = []
    agen = source.events()
    try:
        async with asyncio.timeout(timeout):
            async for ev in agen:
                out.append(ev)
                if len(out) == n:
                    break
    finally:
        await agen.aclose()
    return out


def test_retries_until_found_then_streams_and_reconnects(run):
    source = make_source([None, None, DEVICE], lines=["E,1,7,1805000,4"])
    events = run(take(source, 7))
    links = [e.connected for e in events if isinstance(e, LinkEvent)]
    data = b"".join(e.data for e in events if isinstance(e, DataEvent))
    assert links[:3] == [True, False, True]  # up, dropped, reconnected by itself
    assert data.startswith(b"E,1,7,1805000,4\n")
    assert len(FakeClient.instances) >= 2


def test_send_splits_into_chunks_that_fit(run):
    async def go(mtu):
        source = make_source([DEVICE], drop_after=False, mtu=mtu)
        agen = source.events()
        assert isinstance(await agen.__anext__(), LinkEvent)  # connected
        await source.send(b"x" * 50)
        client = FakeClient.instances[-1]
        await agen.aclose()
        return [len(d) for c, d in client.writes if c == NUS_RX_CHAR_UUID]

    assert run(go(23)) == [20, 20, 10]  # default BLE MTU
    assert run(go(247)) == [50]  # bigger MTU after negotiation


def test_send_while_disconnected_raises(run):
    source = make_source([])
    with pytest.raises(BleakError):
        run(source.send(b"T,1\n"))


def test_ble_end_to_end_stores_data_and_replies(run, db_url, sql):
    lines = FIXTURE.read_text().splitlines()
    source = make_source([DEVICE], lines=lines, drop_after=False)

    async def go():
        task = asyncio.create_task(run_ingest(source, db_url, "dryer-1", flush_interval_s=0.05))
        try:
            async with asyncio.timeout(5):
                while not FakeClient.instances or not any(
                    d.startswith(b"A,8,1,1") for _, d in FakeClient.instances[-1].writes
                ):
                    await asyncio.sleep(0.05)
        finally:
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task

    run(go())
    assert sql("SELECT cycle_no, state, n_samples FROM cycles ORDER BY cycle_no") == [
        (7, "complete", 4),
        (8, "complete", 2),
    ]
    replies = b"".join(d for _, d in FakeClient.instances[-1].writes).decode()
    assert replies.startswith("T,")
    assert "A,7,3,1\n" in replies
    assert sql("SELECT connected FROM device_status") == [(False,)]  # set back on shutdown

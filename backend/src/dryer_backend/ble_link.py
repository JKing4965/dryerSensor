"""
ble_link.py - the real board over Bluetooth, as a source for the receiver.

What it does:
    BleSource finds the board by its advertised name (or address), connects,
    subscribes to the Nordic UART TX characteristic and turns every notification
    into a DataEvent. Connection changes become LinkEvents. send() writes the
    receiver's replies (T and A lines) to the NUS RX characteristic.

    If the board is not found or the link drops, it keeps retrying: after 2 s, then
    4, 8, ... up to 30 s between attempts. It goes back to 2 s after a successful
    connection. It runs until stopped with Ctrl+C.

Talks to:
    - The board firmware (or arduino_code/BLEtest.ino for manual tests) through the
      Nordic UART Service. UUIDs and rules are in docs/protocol.md section 1.
    - Implements the Source interface from sources.py; used by ingest.py --source ble.
    - Uses the bleak library (Windows, macOS, Linux).

How to run (from backend/, database running):
    uv run python -m dryer_backend.ingest --source ble
    uv run python -m dryer_backend.ingest --source ble --name XIAO-BLE
    uv run python -m dryer_backend.ingest --source ble --address F1:22:33:44:55:66
Find names/addresses with:  uv run tools/ble_reader.py --scan
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Any

from bleak import BleakClient, BleakScanner
from bleak.backends.device import BLEDevice
from bleak.exc import BleakError

from dryer_backend.sources import DataEvent, LinkEvent, SourceEvent
from dryer_backend.timesync import utc_now

log = logging.getLogger(__name__)

NUS_SERVICE_UUID = "6e400001-b5a3-f393-e0a9-e50e24dcca9e"
NUS_RX_CHAR_UUID = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"  # computer -> board (write)
NUS_TX_CHAR_UUID = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"  # board -> computer (notify)

MIN_WRITE_CHUNK = 20  # safe payload size before the larger MTU is negotiated

FindDevice = Callable[[], Awaitable[BLEDevice | None]]


class BleSource:
    name = "ble"

    def __init__(
        self,
        device_name: str | None = None,
        address: str | None = None,
        scan_timeout_s: float = 10.0,
        retry_min_s: float = 2.0,
        retry_max_s: float = 30.0,
        find_device: FindDevice | None = None,
        client_factory: Callable[..., Any] = BleakClient,
    ):
        if not device_name and not address:
            raise ValueError("give the board's name or address")
        self.device_name = device_name
        self.address = address
        self.scan_timeout_s = scan_timeout_s
        self.retry_min_s = retry_min_s
        self.retry_max_s = retry_max_s
        self._find_device = find_device or self._scan_for_board
        self._client_factory = client_factory  # replaced by a fake in tests
        self._queue: asyncio.Queue[SourceEvent] = asyncio.Queue()
        self._client: Any = None

    @property
    def target(self) -> str:
        return self.address or repr(self.device_name)

    # -- Source interface ------------------------------------------------ #
    async def events(self) -> AsyncIterator[SourceEvent]:
        runner = asyncio.create_task(self._connect_forever())
        try:
            while True:
                get = asyncio.ensure_future(self._queue.get())
                done, _ = await asyncio.wait({get, runner}, return_when=asyncio.FIRST_COMPLETED)
                if get in done:
                    yield get.result()
                    continue
                get.cancel()
                runner.result()  # re-raise an unexpected error from the connection loop
                return
        finally:
            runner.cancel()
            with contextlib.suppress(asyncio.CancelledError, BleakError, OSError):
                await runner

    async def send(self, data: bytes) -> None:
        client = self._client
        if client is None or not client.is_connected:
            raise BleakError("not connected")
        chunk = max(MIN_WRITE_CHUNK, (getattr(client, "mtu_size", 23) or 23) - 3)
        for i in range(0, len(data), chunk):
            await client.write_gatt_char(NUS_RX_CHAR_UUID, data[i : i + chunk], response=False)

    # -- connection loop ------------------------------------------------- #
    async def _scan_for_board(self) -> BLEDevice | None:
        if self.address:
            return await BleakScanner.find_device_by_address(self.address, timeout=self.scan_timeout_s)
        return await BleakScanner.find_device_by_filter(
            lambda d, adv: (adv.local_name or d.name or "") == self.device_name,
            timeout=self.scan_timeout_s,
        )

    async def _connect_forever(self) -> None:
        delay = self.retry_min_s
        while True:
            log.info("looking for board %s ...", self.target)
            try:
                device = await self._find_device()
                if device is None:
                    log.warning("board %s not found. Is it powered and advertising?", self.target)
                else:
                    await self._session(device)
                    delay = self.retry_min_s  # it worked; retry quickly next time
            except (BleakError, OSError, asyncio.TimeoutError) as e:
                log.warning("Bluetooth problem: %s", e)
            log.info("retrying in %.0f s", delay)
            await asyncio.sleep(delay)
            delay = min(delay * 2, self.retry_max_s)

    async def _session(self, device: BLEDevice) -> None:
        """One connection: connect -> subscribe -> wait until it drops."""
        loop = asyncio.get_running_loop()
        dropped = asyncio.Event()

        def on_disconnect(_client: Any) -> None:
            loop.call_soon_threadsafe(dropped.set)  # bleak may call this from another thread

        def on_notify(_char: Any, data: bytearray) -> None:
            self._queue.put_nowait(DataEvent(bytes(data), utc_now()))

        client = self._client_factory(device, disconnected_callback=on_disconnect)
        connected = False
        try:
            async with client:
                self._client = client
                connected = True
                log.info(
                    "connected to %s (%s), MTU %s",
                    getattr(device, "name", None) or self.target,
                    getattr(device, "address", "?"),
                    getattr(client, "mtu_size", "?"),
                )
                self._queue.put_nowait(LinkEvent(True, utc_now()))
                # The firmware sends its H line when it sees this subscription.
                await client.start_notify(NUS_TX_CHAR_UUID, on_notify)
                await dropped.wait()
        finally:
            self._client = None
            if connected:
                log.warning("board disconnected")
                self._queue.put_nowait(LinkEvent(False, utc_now()))

#!/usr/bin/env python3
"""
ble_reader.py - Connect to an MCU over BLE and read the data it sends.

Requires:  pip install bleak
Works on:  Windows 10+, macOS, Linux (BlueZ >= 5.55)

Typical usage
-------------
1) Find your device and see what it exposes:
       python ble_reader.py --scan
       python ble_reader.py --name MyESP32 --explore

2) Stream data (notifications - the normal way MCUs push data):
       python ble_reader.py --name MyESP32 --char <characteristic-uuid>

   If you use the Nordic UART Service (NUS) - common on nRF52, ESP32
   examples, Adafruit Bluefruit - you can omit --char; NUS TX is the default.

3) If the firmware does NOT notify, poll it with reads instead:
       python ble_reader.py --name MyESP32 --char <uuid> --poll 0.5

4) Decode binary payloads (struct format, little-endian by default):
       python ble_reader.py --name MyESP32 --char <uuid> --struct "<hhhf"
   e.g. "<hhhf" = three int16 + one float32.

Press Ctrl+C to stop. Use --csv out.csv to log everything.
"""

import argparse
import asyncio
import csv
import signal
import struct
import sys
import time
from datetime import datetime

from bleak import BleakClient, BleakScanner
from bleak.exc import BleakError

# Nordic UART Service: MCU -> PC data comes from the TX characteristic.
NUS_SERVICE_UUID = "6e400001-b5a3-f393-e0a9-e50e24dcca9e"
NUS_TX_CHAR_UUID = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"  # notify (MCU -> PC)
NUS_RX_CHAR_UUID = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"  # write  (PC -> MCU)


# --------------------------------------------------------------------------- #
# Decoding
# --------------------------------------------------------------------------- #
def make_decoder(struct_fmt: str | None, as_text: bool):
    """Return a function bytes -> printable/loggable value."""
    if struct_fmt:
        size = struct.calcsize(struct_fmt)

        def decode(data: bytes):
            if len(data) < size:
                return f"<short packet {len(data)}B, need {size}B: {data.hex()}>"
            # Decode as many whole records as fit (MCUs often batch samples).
            out = []
            for off in range(0, len(data) - size + 1, size):
                out.append(struct.unpack_from(struct_fmt, data, off))
            return out[0] if len(out) == 1 else out

        return decode

    if as_text:
        return lambda data: data.decode("utf-8", errors="replace").rstrip("\r\n")

    def auto(data: bytes):
        # Printable ASCII -> show as text, otherwise hex.
        try:
            s = data.decode("ascii")
            if all(c.isprintable() or c in "\r\n\t" for c in s):
                return s.rstrip("\r\n")
        except UnicodeDecodeError:
            pass
        return data.hex(" ")

    return auto


# --------------------------------------------------------------------------- #
# Discovery
# --------------------------------------------------------------------------- #
async def scan(timeout: float):
    print(f"Scanning for {timeout:.0f}s ...")
    found = await BleakScanner.discover(timeout=timeout, return_adv=True)
    rows = sorted(found.values(), key=lambda t: t[1].rssi, reverse=True)
    for dev, adv in rows:
        name = adv.local_name or dev.name or "(no name)"
        uuids = ", ".join(adv.service_uuids) if adv.service_uuids else ""
        print(f"{dev.address:40s} RSSI {adv.rssi:4d}  {name}  {uuids}")
    if not rows:
        print("No devices found. Is the MCU advertising? Is Bluetooth on?")


async def find_device(name: str | None, address: str | None, timeout: float):
    if address:
        dev = await BleakScanner.find_device_by_address(address, timeout=timeout)
    elif name:
        dev = await BleakScanner.find_device_by_filter(
            lambda d, adv: (adv.local_name or d.name or "") == name,
            timeout=timeout,
        )
    else:
        # No name/address: grab the first device advertising NUS.
        dev = await BleakScanner.find_device_by_filter(
            lambda d, adv: NUS_SERVICE_UUID in [u.lower() for u in adv.service_uuids],
            timeout=timeout,
        )
    return dev


async def explore(client: BleakClient):
    """Print every service/characteristic and read anything readable."""
    print(f"\nConnected to {client.address}  (MTU {client.mtu_size})\n")
    for service in client.services:
        print(f"[Service] {service.uuid}  {service.description}")
        for char in service.characteristics:
            props = ",".join(char.properties)
            line = f"   [Char] {char.uuid}  ({props})  {char.description}"
            if "read" in char.properties:
                try:
                    val = await client.read_gatt_char(char)
                    line += f"  = {val!r}"
                except BleakError as e:
                    line += f"  <read failed: {e}>"
            print(line)
    print(
        "\nPick the characteristic marked 'notify' or 'indicate' that carries "
        "your data and pass it with --char."
    )


# --------------------------------------------------------------------------- #
# Streaming
# --------------------------------------------------------------------------- #
class Sink:
    """Prints and optionally logs to CSV."""

    def __init__(self, decode, csv_path: str | None):
        self.decode = decode
        self.count = 0
        self.t0 = time.monotonic()
        self._fh = open(csv_path, "a", newline="") if csv_path else None
        self._csv = csv.writer(self._fh) if self._fh else None
        if self._csv and self._fh.tell() == 0:
            self._csv.writerow(["timestamp", "raw_hex", "decoded"])

    def __call__(self, data: bytes):
        self.count += 1
        decoded = self.decode(bytes(data))
        ts = datetime.now().isoformat(timespec="milliseconds")
        print(f"{ts}  [{len(data):3d}B]  {decoded}")
        if self._csv:
            self._csv.writerow([ts, bytes(data).hex(), decoded])
            self._fh.flush()

    def close(self):
        rate = self.count / max(time.monotonic() - self.t0, 1e-9)
        print(f"\nReceived {self.count} packets ({rate:.1f}/s).")
        if self._fh:
            self._fh.close()


async def run_session(args, sink: Sink, stop: asyncio.Event) -> None:
    """One connect -> stream -> disconnect cycle."""
    dev = await find_device(args.name, args.address, args.scan_timeout)
    if dev is None:
        raise BleakError("Device not found (check name/address, is it advertising?)")

    disconnected = asyncio.Event()
    client = BleakClient(dev, disconnected_callback=lambda _c: disconnected.set())

    async with client:
        if args.explore:
            await explore(client)
            stop.set()
            return

        char_uuid = args.char or NUS_TX_CHAR_UUID
        char = client.services.get_characteristic(char_uuid)
        if char is None:
            raise BleakError(
                f"Characteristic {char_uuid} not found on device. "
                f"Run with --explore to list what it exposes."
            )

        print(f"Connected to {dev.name or dev.address}. Reading {char.uuid} "
              f"({','.join(char.properties)}). Ctrl+C to stop.")

        if args.poll is None:
            if not ({"notify", "indicate"} & set(char.properties)):
                raise BleakError(
                    "That characteristic doesn't support notify/indicate. "
                    "Use --poll <seconds> to read it periodically instead."
                )
            await client.start_notify(char, lambda _c, data: sink(data))
            # Wait until user stops or the link drops.
            await asyncio.wait(
                [asyncio.create_task(stop.wait()),
                 asyncio.create_task(disconnected.wait())],
                return_when=asyncio.FIRST_COMPLETED,
            )
            if client.is_connected:
                try:
                    await client.stop_notify(char)
                except BleakError:
                    pass
        else:
            while not stop.is_set() and not disconnected.is_set():
                sink(await client.read_gatt_char(char))
                try:
                    await asyncio.wait_for(stop.wait(), timeout=args.poll)
                except asyncio.TimeoutError:
                    pass

    if disconnected.is_set() and not stop.is_set():
        raise BleakError("Device disconnected")


async def main_async(args):
    if args.scan:
        await scan(args.scan_timeout)
        return

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    try:
        loop.add_signal_handler(signal.SIGINT, stop.set)
    except NotImplementedError:  # Windows: fall back to KeyboardInterrupt
        pass

    sink = Sink(make_decoder(args.struct, args.text), args.csv)
    try:
        while not stop.is_set():
            try:
                await run_session(args, sink, stop)
            except BleakError as e:
                print(f"[!] {e}", file=sys.stderr)
                if not args.reconnect or stop.is_set():
                    break
                print(f"    Reconnecting in {args.reconnect_delay}s ...", file=sys.stderr)
                try:
                    await asyncio.wait_for(stop.wait(), timeout=args.reconnect_delay)
                except asyncio.TimeoutError:
                    pass
    finally:
        if not args.explore:
            sink.close()


def parse_args():
    p = argparse.ArgumentParser(description="Read data from an MCU over BLE.")
    target = p.add_mutually_exclusive_group()
    target.add_argument("--name", help="Advertised device name (exact match)")
    target.add_argument("--address", help="MAC address (Win/Linux) or UUID (macOS)")
    p.add_argument("--scan", action="store_true", help="List nearby BLE devices and exit")
    p.add_argument("--explore", action="store_true", help="Connect and list services/characteristics")
    p.add_argument("--char", help=f"Characteristic UUID to read (default: NUS TX {NUS_TX_CHAR_UUID})")
    p.add_argument("--poll", type=float, metavar="SEC", help="Poll with reads every SEC instead of notifications")
    p.add_argument("--struct", metavar="FMT", help='Decode with Python struct format, e.g. "<hhhf"')
    p.add_argument("--text", action="store_true", help="Decode payload as UTF-8 text")
    p.add_argument("--csv", metavar="PATH", help="Append received data to a CSV file")
    p.add_argument("--scan-timeout", type=float, default=10.0)
    p.add_argument("--no-reconnect", dest="reconnect", action="store_false",
                   help="Exit instead of reconnecting when the link drops")
    p.add_argument("--reconnect-delay", type=float, default=2.0)
    return p.parse_args()


if __name__ == "__main__":
    try:
        asyncio.run(main_async(parse_args()))
    except KeyboardInterrupt:
        pass
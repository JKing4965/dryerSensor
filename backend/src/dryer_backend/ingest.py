"""
ingest.py - the receiver: reads board messages from a source and stores them in the database.

What it does:
    source (sim / replay / ble) -> join packets into lines -> parse -> board time to real time
    -> write to TimescaleDB -> acknowledge to the board.

    - H: updates device_status (connected, state, backlog, sensor errors), syncs time,
         replies with T, and closes cycles that can never finish
    - B: stores an idle baseline reading
    - C / S / E: handled by cycles.py (create cycle, buffer samples, mark complete);
         after an E line, features.py computes the cycle's numbers for the lint verdict
    - Buffered samples are written about once a second (FLUSH_INTERVAL_S in .env) or
      every 200 samples, then acknowledged with A,<cycle>,<seq>,0. After an E line is
      stored the board gets A,<cycle>,<seq>,1 and may erase that cycle from flash.
    - Bad lines are logged and skipped; they never stop the receiver.

Talks to:
    - sources.py / simulator.py / ble_link.py for input
    - protocol.py, timesync.py, cycles.py, features.py, db.py
    - settings from the repo-root .env via config.py

How to run (from backend/, with the database running: docker compose up -d):
    uv run python -m dryer_backend.ingest --source sim --scenario normal --cycles 3
    uv run python -m dryer_backend.ingest --source sim --scenario disconnect --speed 60
    uv run python -m dryer_backend.ingest --source replay tests/fixtures/example_session.txt
    uv run python -m dryer_backend.ingest --source ble          (real board, name from .env)
    uv run python -m dryer_backend.ingest --help
Stop with Ctrl+C; buffered data is written before it exits.
The dashboard's Connect button starts it with --control-stdin and stops it by writing
"quit" to its stdin (frontend/src/lib/receiver.ts).
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import logging
import sys
import threading
from collections.abc import Awaitable, Callable, Coroutine
from dataclasses import asdict, dataclass
from datetime import datetime
from typing import Any, TypeVar

import psycopg

from dryer_backend.config import ConfigError, Settings, load_settings, run_async
from dryer_backend.cycles import CycleTracker
from dryer_backend.db import Database
from dryer_backend.features import update_cycle_features
from dryer_backend.protocol import (
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
    encode_time,
    parse_line,
)
from dryer_backend.sources import LinkEvent, ReplaySource, Source
from dryer_backend.timesync import TimeSync

log = logging.getLogger("dryer_backend.ingest")
T = TypeVar("T")

MAX_BATCH = 200


@dataclass
class Stats:
    lines: int = 0
    bad_lines: int = 0
    hellos: int = 0
    baselines: int = 0
    samples_stored: int = 0
    duplicates_skipped: int = 0
    cycles_started: int = 0
    cycles_completed: int = 0
    cycles_closed_incomplete: int = 0


class Ingestor:
    """Handles every event from a source. One instance per run."""

    def __init__(
        self,
        db: Database,
        device_id: str,
        send: Callable[[bytes], Awaitable[None]],
        max_batch: int = MAX_BATCH,
    ):
        self.db = db
        self.device_id = device_id
        self._send_raw = send
        self.max_batch = max_batch
        self.sync = TimeSync()
        self.assembler = LineAssembler()
        self.tracker = CycleTracker(db, device_id)
        self.stats = Stats()
        self._lock = asyncio.Lock()  # one database operation at a time
        self._last_seen: datetime | None = None
        self._sensor_codes: tuple[SensorError, SensorError] | None = None

    # -- events from the source ----------------------------------------- #
    async def on_link(self, connected: bool, at: datetime) -> None:
        async with self._lock:
            await self._flush()
            self.assembler = LineAssembler()  # drop any half line from the old connection
            await self.db.set_connected(self.device_id, connected)
        log.info("link %s", "up" if connected else "down")

    async def on_data(self, data: bytes, at: datetime) -> None:
        for line in self.assembler.feed(data):
            async with self._lock:
                await self._handle_line(line, at)

    async def flush(self) -> None:
        async with self._lock:
            await self._flush()

    async def flush_every(self, interval_s: float) -> None:
        """Background task: write buffered samples regularly even when data is slow."""
        while True:
            await asyncio.sleep(interval_s)
            try:
                await self.flush()
            except Exception:
                log.exception("periodic flush failed; will retry")

    async def close(self) -> None:
        async with self._lock:
            await self._flush()
            await self.db.set_connected(self.device_id, False)

    # -- internals ------------------------------------------------------- #
    async def _send(self, data: bytes) -> None:
        try:
            await self._send_raw(data)
        except Exception as e:  # board may have just disconnected; it resends unacked data
            log.debug("could not send %r to board: %s", data, e)

    async def _flush(self) -> None:
        acks = await self.tracker.flush(self._last_seen)
        self._last_seen = None
        self.stats.samples_stored = self.tracker.stored
        self.stats.duplicates_skipped = self.tracker.duplicates
        for cycle_no, seq in acks:
            await self._send(encode_ack(cycle_no, seq, done=False))

    async def _handle_line(self, line: str, at: datetime) -> None:
        self.stats.lines += 1
        self._last_seen = at
        try:
            msg = parse_line(line)
        except ParseError as e:
            self.stats.bad_lines += 1
            log.warning("skipped bad line: %s", e)
            return

        match msg:
            case Comment():
                log.info("board says: %s", msg.text)

            case Hello():
                self.stats.hellos += 1
                await self._flush()
                self.sync.on_hello(msg.boot_id, msg.ms, at)
                await self.db.update_status_from_hello(self.device_id, msg, at)
                self._log_sensor_codes(msg)
                if msg.backlog_count == 0:
                    closed = await self.tracker.close_stale(keep_latest_running=msg.state == "running")
                    self.stats.cycles_closed_incomplete += len(closed)
                await self._send(encode_time(int(at.timestamp() * 1000)))

            case Baseline():
                self.stats.baselines += 1
                when, est = self.sync.to_time(msg.boot_id, msg.ms, at)
                await self.db.insert_baseline(
                    self.device_id, msg.boot_id, msg.ms, when, est,
                    msg.p_in, msg.t_in, msg.p_out, msg.t_out,
                )  # fmt: skip

            case CycleStart():
                self.stats.cycles_started += 1
                await self._flush()
                when, est = self.sync.to_time(msg.boot_id, msg.ms, at)
                base_when, base_est = None, False
                if msg.base_ms is not None:
                    base_when, base_est = self.sync.to_time(msg.boot_id, msg.base_ms, at)
                await self.tracker.start(msg, when, est, base_when, base_est)

            case Sample():
                when, est = self.sync.to_time(msg.boot_id, msg.ms, at)
                await self.tracker.add_sample(msg, when, est)
                if self.tracker.batch_size >= self.max_batch:
                    await self._flush()

            case CycleEnd():
                await self._flush()
                when, est = self.sync.to_time(msg.boot_id, msg.ms, at)
                row = await self.tracker.end(msg, when, est)
                self.stats.cycles_completed += 1
                await self._send(encode_ack(msg.cycle_no, max(row.last_seq, 0), done=True))
                await update_cycle_features(self.db, row.id)  # numbers for the lint verdict

    def _log_sensor_codes(self, msg: Hello) -> None:
        codes = (msg.err_in, msg.err_out)
        if codes == self._sensor_codes:
            return
        self._sensor_codes = codes
        if msg.sensors_ok:
            log.info("both sensors OK")
        else:
            log.warning(
                "SENSOR ERROR - inside: %s, outside: %s",
                msg.err_in.name.lower(), msg.err_out.name.lower(),
            )  # fmt: skip


async def run_ingest(
    source: Source, database_url: str, device_id: str, flush_interval_s: float = 1.0
) -> Stats:
    """Run until the source ends (or the task is cancelled). Returns counters."""
    db = await Database.connect(database_url)
    try:
        await db.ensure_device(device_id)
        ing = Ingestor(db, device_id, source.send)
        flusher = asyncio.create_task(ing.flush_every(flush_interval_s))
        try:
            async for ev in source.events():
                if isinstance(ev, LinkEvent):
                    await ing.on_link(ev.connected, ev.received_at)
                else:
                    await ing.on_data(ev.data, ev.received_at)
        finally:
            flusher.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await flusher
            await ing.close()
            log.info("summary: %s", asdict(ing.stats))
        return ing.stats
    finally:
        await db.close()


# ---------------------------------------------------------------------- #
# Command line
# ---------------------------------------------------------------------- #
def _make_source(args: argparse.Namespace, settings: Settings) -> Source:
    if args.source == "replay":
        if not args.file:
            raise SystemExit("--source replay needs a file, e.g. tests/fixtures/example_session.txt")
        return ReplaySource.from_file(args.file)
    if args.source == "sim":
        from dryer_backend.simulator import SimBoard, config_from_args

        return SimBoard(config_from_args(args))
    from dryer_backend.ble_link import BleSource

    return BleSource(device_name=args.name or settings.ble_device_name, address=args.address)


async def stoppable_by_stdin(coro: Coroutine[Any, Any, T]) -> T:
    """Run the receiver until it ends, or until stdin says 'quit' / closes.

    Used when the dashboard starts the receiver as a child process: the dashboard writes
    'quit' to stop it, and if the dashboard itself goes away stdin closes, so the receiver
    never outlives it. Stopping cancels the task, so run_ingest's cleanup still runs
    (buffered samples written, device_status set to disconnected).
    """
    loop = asyncio.get_running_loop()
    task = asyncio.ensure_future(coro)

    def watch_stdin() -> None:  # a thread: Windows can't await stdin in this event loop
        for line in sys.stdin:
            if line.strip().lower() == "quit":
                break
        log.info("stop requested on stdin")
        loop.call_soon_threadsafe(task.cancel)

    threading.Thread(target=watch_stdin, name="stdin-control", daemon=True).start()
    return await task


def main(argv: list[str] | None = None) -> None:
    from dryer_backend.simulator import add_sim_arguments

    parser = argparse.ArgumentParser(
        description="Receive dryer sensor data and store it in the database.",
        epilog="Run from backend/ with the database running (docker compose up -d).",
    )
    parser.add_argument("--source", choices=["sim", "replay", "ble"], default="sim",
                        help="where data comes from (default: sim)")  # fmt: skip
    parser.add_argument("file", nargs="?", help="protocol line file for --source replay")
    parser.add_argument("--log-level", default="INFO", choices=["DEBUG", "INFO", "WARNING"])
    ble = parser.add_argument_group("Bluetooth options (--source ble)")
    ble.add_argument("--name", help="board's advertised name (default: BLE_DEVICE_NAME in .env)")
    ble.add_argument("--address", help="board's address instead of its name")
    parser.add_argument("--control-stdin", action="store_true",
                        help="stop cleanly when a line 'quit' arrives on stdin, or stdin closes "
                             "(used when the dashboard starts the receiver)")  # fmt: skip
    add_sim_arguments(parser)
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=args.log_level,
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )
    try:
        settings = load_settings()
    except ConfigError as e:
        raise SystemExit(str(e)) from None

    source = _make_source(args, settings)
    log.info("source=%s device=%s - %s", source.name, settings.device_id,
             "send 'quit' on stdin to stop" if args.control_stdin else "Ctrl+C to stop")  # fmt: skip
    coro = run_ingest(source, settings.database_url, settings.device_id, settings.flush_interval_s)
    try:
        stats = run_async(stoppable_by_stdin(coro) if args.control_stdin else coro)
    except (KeyboardInterrupt, asyncio.CancelledError):
        log.info("stopped")
        return
    except psycopg.OperationalError as e:
        raise SystemExit(f"database error: {e}\nIs it running? (docker compose up -d)") from None
    except LookupError as e:  # device_id missing from the devices table
        raise SystemExit(str(e)) from None
    print("\n".join(f"{k:>26}: {v}" for k, v in asdict(stats).items()), file=sys.stderr)


if __name__ == "__main__":
    main()

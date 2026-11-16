"""
remote.py - the standby receiver: lets the dashboard's Connect button work from anywhere.

What it does:
    Runs on the computer next to the dryer, until stopped. Every few seconds it:
      1. reads receiver_control.desired for this device ("connected" / "disconnected"),
         which the dashboard's Connect / Disconnect buttons write
      2. starts the normal Bluetooth receiver (ingest.run_ingest) when it should be
         connected, or stops it cleanly when it shouldn't
      3. writes a heartbeat (receiver_online_at, receiver_state, receiver_host), so the
         dashboard can show "PC receiver offline / Ready / Searching / Connected"
    If the receiver stops with an error it is restarted on the next check. The requested
    state lives in the database, so after a reboot it reconnects if it was connected before.
    On exit it marks itself "offline".

Talks to:
    - The database (receiver_control, device_status) - same DATABASE_URL as the receiver.
    - ingest.py (run_ingest) and ble_link.py (BleSource) for the actual Bluetooth work.
    - The dashboard: frontend/src/app/api/receiver/route.ts reads/writes the same row.

How to run (from backend/):
    uv run python -m dryer_backend.remote              (Ctrl+C to stop)
    uv run python -m dryer_backend.remote --help
The local dashboard starts it with --control-stdin (stop by writing "quit").
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import logging
import socket
from collections.abc import Callable
from typing import Any

import psycopg
from psycopg.rows import dict_row

from dryer_backend.config import ConfigError, load_settings, run_async
from dryer_backend.ingest import run_ingest, stoppable_by_stdin
from dryer_backend.sources import Source

log = logging.getLogger("dryer_backend.remote")

POLL_S = 3.0
BOARD_FRESH_S = 65  # device_status older than this = the receiver lost the board

_ENSURE_ROW = "INSERT INTO receiver_control (device_id) VALUES (%s) ON CONFLICT (device_id) DO NOTHING"

_READ = f"""
SELECT rc.desired,
       COALESCE(ds.connected AND ds.updated_at > now() - interval '{BOARD_FRESH_S} seconds', false)
           AS board_linked
FROM receiver_control rc
LEFT JOIN device_status ds ON ds.device_id = rc.device_id
WHERE rc.device_id = %s
"""

_HEARTBEAT = """
UPDATE receiver_control
SET receiver_online_at = now(), receiver_state = %s, receiver_host = %s
WHERE device_id = %s
"""


async def _stop_session(task: asyncio.Task | None) -> None:
    """Cancel the receiver task; its cleanup (flush, mark disconnected) still runs."""
    if task and not task.done():
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await task


async def run_remote(
    database_url: str,
    device_id: str,
    make_source: Callable[[], Source],
    poll_s: float = POLL_S,
    flush_interval_s: float = 1.0,
    host: str | None = None,
) -> None:
    """Run until cancelled. make_source() builds a fresh source for each connection."""
    host = host or socket.gethostname()
    session: asyncio.Task | None = None
    last_state = None
    conn: psycopg.AsyncConnection[dict[str, Any]] | None = None
    try:
        while True:
            try:
                if conn is None or conn.closed:
                    conn = await psycopg.AsyncConnection.connect(database_url, autocommit=True, row_factory=dict_row)
                    await conn.execute(_ENSURE_ROW, (device_id,))
                cur = await conn.execute(_READ, (device_id,))
                row = await cur.fetchone()
                desired = row["desired"] if row else "disconnected"
                board_linked = bool(row and row["board_linked"])

                if session and session.done():  # receiver ended (error, or source finished)
                    if not session.cancelled() and session.exception():
                        log.error("receiver stopped with an error: %s", session.exception())
                    session = None
                if desired == "connected" and session is None:
                    log.info("connect requested: starting the Bluetooth receiver")
                    session = asyncio.create_task(
                        run_ingest(make_source(), database_url, device_id, flush_interval_s)
                    )
                elif desired != "connected" and session is not None:
                    log.info("disconnect requested: stopping the Bluetooth receiver")
                    await _stop_session(session)
                    session = None
                    board_linked = False

                state = "standby" if session is None else ("connected" if board_linked else "searching")
                if state != last_state:
                    log.info("state: %s", state)
                    last_state = state
                await conn.execute(_HEARTBEAT, (state, host, device_id))
            except psycopg.Error as e:
                log.warning("database problem, retrying: %s", e)
                if conn is not None:
                    with contextlib.suppress(Exception):
                        await conn.close()
                conn = None
            await asyncio.sleep(poll_s)
    finally:
        await _stop_session(session)
        with contextlib.suppress(Exception):
            if conn is None or conn.closed:
                conn = await psycopg.AsyncConnection.connect(database_url, autocommit=True)
            await conn.execute(_HEARTBEAT, ("offline", host, device_id))
            await conn.close()
        log.info("standby receiver stopped (marked offline)")


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(
        description="Standby receiver: connects to the board when the dashboard asks.",
        epilog="Run from backend/. Uses DATABASE_URL / DEVICE_ID / BLE_DEVICE_NAME from the repo-root .env.",
    )
    parser.add_argument("--name", help="board's advertised name (default: BLE_DEVICE_NAME in .env)")
    parser.add_argument("--address", help="board's address instead of its name")
    parser.add_argument("--poll", type=float, default=POLL_S, help="seconds between checks (default 3)")
    parser.add_argument("--control-stdin", action="store_true",
                        help="stop when 'quit' arrives on stdin or stdin closes (used by the dashboard)")  # fmt: skip
    parser.add_argument("--log-level", default="INFO", choices=["DEBUG", "INFO", "WARNING"])
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

    from dryer_backend.ble_link import BleSource

    def make_source() -> Source:
        return BleSource(device_name=args.name or settings.ble_device_name, address=args.address)

    log.info("standby receiver for %s on %s - %s", settings.device_id, socket.gethostname(),
             "send 'quit' on stdin to stop" if args.control_stdin else "Ctrl+C to stop")  # fmt: skip
    coro = run_remote(settings.database_url, settings.device_id, make_source, args.poll, settings.flush_interval_s)
    try:
        run_async(stoppable_by_stdin(coro) if args.control_stdin else coro)
    except (KeyboardInterrupt, asyncio.CancelledError):
        pass


if __name__ == "__main__":
    main()

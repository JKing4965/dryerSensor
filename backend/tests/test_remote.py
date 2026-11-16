"""
test_remote.py - tests for the standby receiver (dryer_backend/remote.py).

What it checks (simulated board instead of Bluetooth, temporary test database):
    - on start it writes a heartbeat: state "standby", with its host name
    - desired = connected    -> starts the receiver; state "connected", device connected
    - desired = disconnected -> stops it cleanly; state "standby", device disconnected
    - when the standby receiver itself stops -> state "offline"

Needs the database running (docker compose up -d); otherwise skipped.
How to run (from backend/):
    uv run pytest
"""

import asyncio
import contextlib
import time

from dryer_backend.remote import run_remote
from dryer_backend.simulator import SimBoard, SimConfig

DEVICE = "dryer-1"


def make_sim():
    # real-time board that stays idle for an hour: connected, sending hellos/baselines
    return SimBoard(SimConfig(scenario="normal", cycles=1, first_idle_minutes=60, speed=1, first_cycle_no=1))


async def wait_until(check, timeout=15.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if check():
            return
        await asyncio.sleep(0.1)
    raise AssertionError("condition not reached in time")


def test_standby_connect_disconnect_offline(run, db_url, sql):
    def control():
        return sql("SELECT desired, receiver_state, receiver_host, receiver_online_at FROM receiver_control")[0]

    def device_connected():
        return sql("SELECT connected FROM device_status")[0][0]

    async def scenario():
        task = asyncio.create_task(run_remote(db_url, DEVICE, make_sim, poll_s=0.2, host="test-host"))
        try:
            await wait_until(lambda: control()[1] == "standby")
            assert control()[2] == "test-host" and control()[3] is not None

            sql("UPDATE receiver_control SET desired = 'connected' RETURNING device_id")
            await wait_until(lambda: control()[1] == "connected")
            assert device_connected() is True

            sql("UPDATE receiver_control SET desired = 'disconnected' RETURNING device_id")
            await wait_until(lambda: control()[1] == "standby")
            assert device_connected() is False  # receiver cleanup ran
        finally:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task

    run(scenario())
    assert control()[1] == "offline"

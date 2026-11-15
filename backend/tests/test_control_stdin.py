"""
test_control_stdin.py - the receiver stops cleanly when told to on stdin.

What it checks:
    The dashboard's Connect button starts the receiver as a child process with
    --control-stdin and stops it by writing "quit" (or by going away, which closes
    stdin). Here the receiver runs the simulator at real-time speed against the
    temporary test database, then:
      - "quit" on stdin -> exits with code 0 within a few seconds
      - stdin closed    -> same
    and in both cases its cleanup ran: device_status.connected is false again.

Needs the database running (docker compose up -d); otherwise skipped.
How to run (from backend/):
    uv run pytest
"""

import os
import queue
import subprocess
import sys
import threading
import time

import pytest

READY_TEXT = "link up"  # logged when the (simulated) board connects


def start_receiver(db_url: str) -> tuple[subprocess.Popen, "queue.Queue[str]"]:
    env = {**os.environ, "DATABASE_URL": db_url, "DEVICE_ID": "dryer-1", "PYTHONUNBUFFERED": "1"}
    proc = subprocess.Popen(
        [sys.executable, "-m", "dryer_backend.ingest", "--source", "sim", "--speed", "1",
         "--cycles", "1", "--control-stdin"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        env=env,
    )  # fmt: skip
    lines: queue.Queue[str] = queue.Queue()
    threading.Thread(target=lambda: [lines.put(line) for line in proc.stdout], daemon=True).start()
    return proc, lines


def wait_for(lines: "queue.Queue[str]", text: str, timeout: float) -> list[str]:
    seen, deadline = [], time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            line = lines.get(timeout=0.2)
        except queue.Empty:
            continue
        seen.append(line)
        if text in line:
            return seen
    pytest.fail(f"{text!r} not seen within {timeout}s. Output:\n" + "".join(seen))


@pytest.mark.parametrize("how", ["quit", "close"])
def test_receiver_stops_cleanly_from_stdin(how, db_url, sql):
    proc, lines = start_receiver(db_url)
    try:
        wait_for(lines, READY_TEXT, timeout=30)
        time.sleep(1.5)  # let it write something
        assert sql("SELECT connected FROM device_status") == [(True,)]

        if how == "quit":
            proc.stdin.write("quit\n")
            proc.stdin.flush()
        else:
            proc.stdin.close()  # what happens if the dashboard process dies

        assert proc.wait(timeout=15) == 0
        out = "".join(wait_for(lines, "stopped", timeout=5))
        assert "stop requested on stdin" in out
        assert sql("SELECT connected FROM device_status") == [(False,)]  # cleanup ran
    finally:
        if proc.poll() is None:
            proc.kill()

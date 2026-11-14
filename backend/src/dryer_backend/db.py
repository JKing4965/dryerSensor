"""
db.py - every SQL statement the receiver runs, in one place.

What it does:
    Wraps one async PostgreSQL connection (psycopg) with small methods:
    create/reopen/complete cycles, store samples in batches, store baselines without
    duplicates, close cycles that will never get an end line, and keep device_status
    up to date (connected, last seen, board state, sensor error codes).

Talks to:
    - TimescaleDB, tables defined in backend/db/schema.sql.
    - Used by cycles.py and ingest.py.

Notes:
    - The connection runs in autocommit mode. Anything that must happen together
      (samples + the cycle's last_seq) runs inside an explicit transaction, so a crash
      can never store samples without also recording them as stored.
    - Not safe to share between tasks at the same time. ingest.py serializes access with a lock.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any

import psycopg
from psycopg.rows import dict_row

from dryer_backend.protocol import Hello


@dataclass(slots=True)
class CycleRow:
    """The parts of a cycles row the receiver needs while data is flowing."""

    id: int
    cycle_no: int
    state: str  # running / complete / incomplete
    last_seq: int  # highest seq stored, -1 if none
    n_samples: int


@dataclass(frozen=True, slots=True)
class SampleRow:
    time: datetime
    boot_id: int
    board_ms: int
    cycle_no: int
    seq: int
    p_in: float
    t_in: float
    p_out: float
    t_out: float
    source: str  # live / flash
    time_estimated: bool


_CYCLE_COLUMNS = "id, cycle_no, state, last_seq, n_samples"

_UPSERT_CYCLE = f"""
INSERT INTO cycles AS c (device_id, cycle_no, boot_id, started_at, time_estimated,
                         baseline_at, baseline_dp, baseline_t_in, baseline_t_out)
VALUES (%(device_id)s, %(cycle_no)s, %(boot_id)s, %(started_at)s, %(estimated)s,
        %(baseline_at)s, %(baseline_dp)s, %(baseline_t_in)s, %(baseline_t_out)s)
ON CONFLICT (device_id, cycle_no) DO UPDATE SET
    -- a resent C line for a cycle we gave up on re-opens it
    state          = CASE WHEN c.state = 'incomplete' THEN 'running' ELSE c.state END,
    started_at     = LEAST(c.started_at, EXCLUDED.started_at),
    boot_id        = COALESCE(c.boot_id, EXCLUDED.boot_id),
    baseline_at    = COALESCE(c.baseline_at, EXCLUDED.baseline_at),
    baseline_dp    = COALESCE(c.baseline_dp, EXCLUDED.baseline_dp),
    baseline_t_in  = COALESCE(c.baseline_t_in, EXCLUDED.baseline_t_in),
    baseline_t_out = COALESCE(c.baseline_t_out, EXCLUDED.baseline_t_out)
RETURNING {_CYCLE_COLUMNS}
"""

_INSERT_BASELINE = """
INSERT INTO readings (time, device_id, kind, boot_id, board_ms,
                      p_in, t_in, p_out, t_out, source, time_estimated)
SELECT %(time)s, %(device_id)s, 'baseline', %(boot_id)s, %(board_ms)s,
       %(p_in)s, %(t_in)s, %(p_out)s, %(t_out)s, 'live', %(estimated)s
WHERE NOT EXISTS (                      -- the same idle reading can arrive as B and inside C
    SELECT 1 FROM readings
    WHERE device_id = %(device_id)s AND kind = 'baseline'
      AND boot_id = %(boot_id)s AND board_ms = %(board_ms)s
      AND time BETWEEN %(time)s - interval '1 day' AND %(time)s + interval '1 day'
)
"""

_INSERT_SAMPLE = """
INSERT INTO readings (time, device_id, kind, boot_id, board_ms, cycle_no, seq,
                      p_in, t_in, p_out, t_out, source, time_estimated)
VALUES (%s, %s, 'cycle', %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
"""

_CLOSE_STALE = """
UPDATE cycles c
SET state = 'incomplete',
    ended_at = COALESCE(
        c.ended_at,
        (SELECT max(r.time) FROM readings r
          WHERE r.device_id = c.device_id AND r.kind = 'cycle' AND r.cycle_no = c.cycle_no),
        c.started_at)
WHERE c.device_id = %(device_id)s
  AND c.state = 'running'
  AND NOT (%(keep_latest)s AND c.cycle_no = (
        SELECT max(cycle_no) FROM cycles WHERE device_id = %(device_id)s AND state = 'running'))
RETURNING c.cycle_no
"""

_STATUS_FROM_HELLO = """
UPDATE device_status SET
    connected        = true,
    last_seen        = %(at)s,
    state            = %(state)s,
    boot_id          = %(boot_id)s,
    backlog_count    = %(backlog)s,
    protocol_version = %(version)s,
    sensor_error_since = CASE
        WHEN %(err_in)s = 0 AND %(err_out)s = 0 THEN NULL
        WHEN sensor_error_since IS NULL
          OR sensor_in_error  IS DISTINCT FROM %(err_in)s
          OR sensor_out_error IS DISTINCT FROM %(err_out)s THEN %(at)s
        ELSE sensor_error_since
    END,
    sensor_in_error  = %(err_in)s,
    sensor_out_error = %(err_out)s,
    updated_at       = now()
WHERE device_id = %(device_id)s
"""


def _cycle(row: dict[str, Any]) -> CycleRow:
    return CycleRow(row["id"], row["cycle_no"], row["state"], row["last_seq"], row["n_samples"])


class Database:
    def __init__(self, conn: psycopg.AsyncConnection[dict[str, Any]]):
        self.conn = conn

    @classmethod
    async def connect(cls, url: str) -> Database:
        conn = await psycopg.AsyncConnection.connect(url, autocommit=True, row_factory=dict_row)
        return cls(conn)

    async def close(self) -> None:
        await self.conn.close()

    async def _one(self, sql: str, params: Any = None) -> dict[str, Any] | None:
        cur = await self.conn.execute(sql, params)
        return await cur.fetchone()

    # -- devices -------------------------------------------------------- #
    async def ensure_device(self, device_id: str) -> None:
        if await self._one("SELECT 1 FROM devices WHERE device_id = %s", (device_id,)) is None:
            raise LookupError(
                f"device {device_id!r} is not in the devices table. "
                "Check DEVICE_ID in .env, or add the device to backend/db/seed.sql."
            )

    async def update_status_from_hello(self, device_id: str, msg: Hello, at: datetime) -> None:
        await self.conn.execute(
            _STATUS_FROM_HELLO,
            {
                "device_id": device_id,
                "at": at,
                "state": msg.state,
                "boot_id": msg.boot_id,
                "backlog": msg.backlog_count,
                "version": msg.version,
                "err_in": int(msg.err_in),
                "err_out": int(msg.err_out),
            },
        )

    async def set_connected(self, device_id: str, connected: bool) -> None:
        await self.conn.execute(
            "UPDATE device_status SET connected = %s, updated_at = now() WHERE device_id = %s",
            (connected, device_id),
        )

    async def touch_last_seen(self, device_id: str, at: datetime) -> None:
        await self.conn.execute(
            "UPDATE device_status SET last_seen = %s, updated_at = now() WHERE device_id = %s",
            (at, device_id),
        )

    # -- cycles --------------------------------------------------------- #
    async def get_cycle(self, device_id: str, cycle_no: int) -> CycleRow | None:
        row = await self._one(
            f"SELECT {_CYCLE_COLUMNS} FROM cycles WHERE device_id = %s AND cycle_no = %s",
            (device_id, cycle_no),
        )
        return _cycle(row) if row else None

    async def upsert_cycle(
        self,
        device_id: str,
        cycle_no: int,
        boot_id: int,
        started_at: datetime,
        estimated: bool,
        baseline: tuple[datetime, float, float, float] | None = None,
    ) -> CycleRow:
        """Create the cycle, or merge into it if it already exists. baseline = (at, dp, t_in, t_out)."""
        b_at, b_dp, b_tin, b_tout = baseline if baseline else (None, None, None, None)
        row = await self._one(
            _UPSERT_CYCLE,
            {
                "device_id": device_id,
                "cycle_no": cycle_no,
                "boot_id": boot_id,
                "started_at": started_at,
                "estimated": estimated,
                "baseline_at": b_at,
                "baseline_dp": b_dp,
                "baseline_t_in": b_tin,
                "baseline_t_out": b_tout,
            },
        )
        assert row is not None
        return _cycle(row)

    async def reopen_cycle(self, cycle_id: int) -> None:
        await self.conn.execute(
            "UPDATE cycles SET state = 'running' WHERE id = %s AND state = 'incomplete'", (cycle_id,)
        )

    async def complete_cycle(self, cycle_id: int, ended_at: datetime, n_expected: int) -> None:
        await self.conn.execute(
            "UPDATE cycles SET state = 'complete', ended_at = %s, n_expected = %s WHERE id = %s",
            (ended_at, n_expected, cycle_id),
        )

    async def close_stale_cycles(self, device_id: str, keep_latest_running: bool) -> list[int]:
        """Mark running cycles that can never get an E line as incomplete. Returns their numbers."""
        cur = await self.conn.execute(
            _CLOSE_STALE, {"device_id": device_id, "keep_latest": keep_latest_running}
        )
        return [r["cycle_no"] for r in await cur.fetchall()]

    # -- readings ------------------------------------------------------- #
    async def insert_baseline(
        self,
        device_id: str,
        boot_id: int,
        board_ms: int,
        time: datetime,
        estimated: bool,
        p_in: float,
        t_in: float,
        p_out: float,
        t_out: float,
    ) -> None:
        await self.conn.execute(
            _INSERT_BASELINE,
            {
                "device_id": device_id,
                "boot_id": boot_id,
                "board_ms": board_ms,
                "time": time,
                "estimated": estimated,
                "p_in": p_in,
                "t_in": t_in,
                "p_out": p_out,
                "t_out": t_out,
            },
        )

    async def commit_samples(
        self,
        device_id: str,
        rows: list[SampleRow],
        cycle_updates: list[tuple[int, int, int]],
        last_seen: datetime | None,
    ) -> None:
        """Store samples and bump each cycle's last_seq / n_samples in ONE transaction.

        cycle_updates = [(cycle_id, last_seq, samples_added), ...]
        """
        async with self.conn.transaction(), self.conn.cursor() as cur:
            if rows:
                await cur.executemany(
                    _INSERT_SAMPLE,
                    [
                        (r.time, device_id, r.boot_id, r.board_ms, r.cycle_no, r.seq,
                         r.p_in, r.t_in, r.p_out, r.t_out, r.source, r.time_estimated)
                        for r in rows
                    ],
                )  # fmt: skip
            for cycle_id, last_seq, added in cycle_updates:
                await cur.execute(
                    "UPDATE cycles SET last_seq = GREATEST(last_seq, %s), "
                    "n_samples = n_samples + %s WHERE id = %s",
                    (last_seq, added, cycle_id),
                )
            if last_seen is not None:
                await cur.execute(
                    "UPDATE device_status SET last_seen = %s, updated_at = now() WHERE device_id = %s",
                    (last_seen, device_id),
                )

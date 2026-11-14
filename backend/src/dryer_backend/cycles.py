"""
cycles.py - keeps the cycles table in step with C / S / E messages and batches samples.

What it does:
    - C (cycle start): creates the cycle row with its pre-cycle baseline, or merges into
      it if the board resent it after a reconnect.
    - S (sample): skips duplicates (seq at or below the highest seq already stored for
      that cycle) and buffers the rest. A sample for a cycle we never saw a C line for
      still creates the cycle.
    - E (cycle end): marks the cycle complete and records how many samples the board sent.
    - flush(): writes buffered samples and the cycles' new last_seq in one transaction,
      then returns what to acknowledge to the board.
    - close_stale(): when the board reports it is idle with an empty backlog, any cycle
      still "running" will never get its E line, so it is marked incomplete.

Talks to:
    - db.py for all SQL. Called by ingest.py, which converts board times first.
    - Duplicate rule from docs/protocol.md section 5.

Known limit:
    Samples are deduplicated by "seq <= highest stored seq". If the board ever skipped
    a seq and sent it later, that late sample would be dropped. That can't happen
    with the firmware rules in protocol.md (samples are sent in order).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime

from dryer_backend.db import CycleRow, Database, SampleRow
from dryer_backend.protocol import CycleEnd, CycleStart, Sample

log = logging.getLogger(__name__)


@dataclass(slots=True)
class _Pending:
    cycle: CycleRow
    added: int = 0


class CycleTracker:
    def __init__(self, db: Database, device_id: str):
        self.db = db
        self.device_id = device_id
        self._cache: dict[int, CycleRow] = {}  # cycle_no -> row (last_seq kept up to date)
        self._batch: list[SampleRow] = []
        self._touched: dict[int, _Pending] = {}  # cycle_no -> pending update since last flush
        self.stored = 0
        self.duplicates = 0

    @property
    def batch_size(self) -> int:
        return len(self._batch)

    async def _get_or_create(
        self, cycle_no: int, boot_id: int, time: datetime, estimated: bool
    ) -> CycleRow:
        row = self._cache.get(cycle_no) or await self.db.get_cycle(self.device_id, cycle_no)
        if row is None:
            log.warning("cycle %s: data arrived before its start line; creating it", cycle_no)
            row = await self.db.upsert_cycle(self.device_id, cycle_no, boot_id, time, estimated)
        self._cache[cycle_no] = row
        return row

    async def start(
        self,
        msg: CycleStart,
        time: datetime,
        estimated: bool,
        baseline_time: datetime | None,
        baseline_estimated: bool = False,
    ) -> CycleRow:
        baseline = None
        if msg.has_baseline:
            assert baseline_time is not None
            assert msg.base_p_in is not None and msg.base_p_out is not None
            baseline = (
                baseline_time,
                msg.base_p_in - msg.base_p_out,
                msg.base_t_in,
                msg.base_t_out,
            )
        row = await self.db.upsert_cycle(
            self.device_id, msg.cycle_no, msg.boot_id, time, estimated, baseline  # type: ignore[arg-type]
        )
        self._cache[msg.cycle_no] = row
        if msg.has_baseline:
            await self.db.insert_baseline(
                self.device_id, msg.boot_id, msg.base_ms, baseline_time,  # type: ignore[arg-type]
                baseline_estimated, msg.base_p_in, msg.base_t_in,  # type: ignore[arg-type]
                msg.base_p_out, msg.base_t_out,  # type: ignore[arg-type]
            )  # fmt: skip
        log.info("cycle %s started%s", msg.cycle_no, "" if msg.has_baseline else " (no baseline)")
        return row

    async def add_sample(self, msg: Sample, time: datetime, estimated: bool) -> bool:
        """Buffer one sample. Returns False if it was a duplicate."""
        row = await self._get_or_create(msg.cycle_no, msg.boot_id, time, estimated)
        pending = self._touched.setdefault(msg.cycle_no, _Pending(row))
        if msg.seq <= row.last_seq:
            self.duplicates += 1
            return False
        if row.state == "incomplete":
            await self.db.reopen_cycle(row.id)
            row.state = "running"
            log.info("cycle %s re-opened: more data arrived", msg.cycle_no)
        if msg.seq > row.last_seq + 1:
            log.warning(
                "cycle %s: samples %s..%s never arrived", msg.cycle_no, row.last_seq + 1, msg.seq - 1
            )
        self._batch.append(
            SampleRow(
                time=time,
                boot_id=msg.boot_id,
                board_ms=msg.ms,
                cycle_no=msg.cycle_no,
                seq=msg.seq,
                p_in=msg.p_in,
                t_in=msg.t_in,
                p_out=msg.p_out,
                t_out=msg.t_out,
                source=msg.source,
                time_estimated=estimated,
            )
        )
        row.last_seq = msg.seq
        row.n_samples += 1
        pending.added += 1
        self.stored += 1
        return True

    async def flush(self, last_seen: datetime | None = None) -> list[tuple[int, int]]:
        """Write buffered samples. Returns [(cycle_no, last_seq), ...] to acknowledge."""
        if not self._batch and not self._touched and last_seen is None:
            return []
        updates = [(p.cycle.id, p.cycle.last_seq, p.added) for p in self._touched.values() if p.added]
        await self.db.commit_samples(self.device_id, self._batch, updates, last_seen)
        acks = [(no, p.cycle.last_seq) for no, p in self._touched.items() if p.cycle.last_seq >= 0]
        self._batch = []
        self._touched = {}
        return acks

    async def end(self, msg: CycleEnd, time: datetime, estimated: bool) -> CycleRow:
        """Call flush() first so every sample of the cycle is stored before it is marked complete."""
        row = await self._get_or_create(msg.cycle_no, msg.boot_id, time, estimated)
        await self.db.complete_cycle(row.id, time, msg.n_samples)
        row.state = "complete"
        if row.n_samples < msg.n_samples:
            log.warning(
                "cycle %s complete but %s of %s samples are missing",
                msg.cycle_no, msg.n_samples - row.n_samples, msg.n_samples,
            )  # fmt: skip
        else:
            log.info("cycle %s complete: %s samples", msg.cycle_no, row.n_samples)
        return row

    async def close_stale(self, keep_latest_running: bool) -> list[int]:
        closed = await self.db.close_stale_cycles(self.device_id, keep_latest_running)
        for cycle_no in closed:
            if cycle_no in self._cache:
                self._cache[cycle_no].state = "incomplete"
            log.warning("cycle %s marked incomplete: the board has no more data for it", cycle_no)
        return closed

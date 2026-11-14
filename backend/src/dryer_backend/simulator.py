"""
simulator.py - a fake dryer sensor board, so the backend and dashboard can be built
and tested without hardware.

What it does:
    SimBoard behaves like the real firmware is supposed to (docs/protocol.md):
      - sends H on connect / every 30 s / when a sensor error changes, B while idle,
        C + S... + E for each dryer cycle
      - saves every cycle to "flash", uploads it oldest-first after connecting,
        erases it only after the receiver's A,<cycle>,<seq>,1
      - splits every line into 20-byte packets like Bluetooth does
    with made-up but realistic physics: ΔP under the lint screen around -100 Pa when
    clean, a +12 Pa offset between the two sensors, the inside temperature rising to
    ~55 °C, and noise.

    Time runs on a simulated clock. With --speed 0 (default) it runs as fast as
    possible and the data is back-dated so it ends "now". With --speed N it runs
    N times faster than real time, starting now (so with N > 1 timestamps run ahead
    of the wall clock).

Scenarios (--scenario):
    normal        connected the whole time; lint builds up every cycle (clean -> dirty)
    vent          connected; exhaust duct clogs more every cycle (ΔP toward 0, hotter, longer)
    disconnect    first cycle recorded with no computer connected and uploaded later
                  from flash; the link drops once halfway through the upload
    reboot        first cycle recorded offline, then the board restarts before
                  uploading, so that cycle's times are estimated
    sensor_error  inside sensor goes missing in cycle 1; outside sensor gives bad
                  readings in cycle 2

Talks to:
    - Implements the Source interface from sources.py; used by ingest.py (--source sim).
    - Uses protocol.py for SensorError and to read the receiver's replies.

How to run (from backend/):
    Print the lines a board would send (no database needed):
        uv run python -m dryer_backend.simulator --scenario normal --cycles 2 > sim.txt
    Feed the database instead:
        uv run python -m dryer_backend.ingest --source sim --scenario normal --cycles 3
"""

from __future__ import annotations

import argparse
import asyncio
import math
import random
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

from dryer_backend.protocol import PROTOCOL_VERSION, LineAssembler, SensorError
from dryer_backend.sources import DataEvent, LinkEvent, SourceEvent

SCENARIOS = {
    "normal": "connected the whole time; lint builds up every cycle (clean -> dirty)",
    "vent": "connected; exhaust duct clogs more every cycle (dp toward 0, hotter, longer)",
    "disconnect": "first cycle recorded offline and uploaded from flash; link drops once mid-upload",
    "reboot": "first cycle recorded offline, board restarts before upload (estimated times)",
    "sensor_error": "inside sensor missing during cycle 1, outside sensor broken during cycle 2",
}

PACKET_SIZE = 20  # default Bluetooth notification payload
HELLO_EVERY_S = 30.0
BASELINE_EVERY_S = 45.0
SENSOR_OFFSET_PA = 12.0  # inside sensor reads this much higher than outside at rest
CLEAN_DP_PA = -100.0  # ΔP under a clean lint screen while the blower runs
LINT_PER_CYCLE = 0.08  # each cycle makes ΔP 8% more negative (normal scenario)
VENT_PER_CYCLE = 0.12  # each cycle moves ΔP 12% toward zero (vent scenario)


@dataclass
class SimConfig:
    scenario: str = "normal"
    cycles: int = 5
    cycle_minutes: float = 45.0
    idle_minutes: float = 20.0
    first_idle_minutes: float = 3.0
    sample_period_s: float = 1.0
    speed: float = 0.0  # 0 = as fast as possible, 1 = real time, 60 = 60x
    seed: int = 1
    start: datetime | None = None  # simulated clock start; None = automatic
    first_cycle_no: int | None = None  # None = derived from the start time (unique per run)


@dataclass(frozen=True, slots=True)
class PlannedCycle:
    k: int  # 0-based index within this simulation
    start: float  # seconds on the simulated clock
    end: float

    @property
    def duration(self) -> float:
        return self.end - self.start


@dataclass
class _FlashRecord:
    """One cycle as the board keeps it in flash until the receiver acknowledges it."""

    boot_id: int
    cycle_no: int
    c_line: str
    samples: list[str] = field(default_factory=list)  # S lines WITHOUT the final src field
    e_line: str | None = None
    acked_seq: int = -1


def _f(x: float) -> str:
    return f"{x:.2f}"


class SimBoard:
    """A fake board. Use it as a Source: `async for ev in board.events()` and `await board.send(...)`."""

    name = "sim"

    def __init__(self, cfg: SimConfig | None = None):
        self.cfg = cfg or SimConfig()
        if self.cfg.scenario not in SCENARIOS:
            raise ValueError(f"unknown scenario {self.cfg.scenario!r}; pick one of {list(SCENARIOS)}")
        if self.cfg.cycles < 1:
            raise ValueError("cycles must be at least 1")
        self.rng = random.Random(self.cfg.seed)

        self.plans = self._plan_cycles()
        self.end_t = self.plans[-1].end + 300.0
        self.reboot_t = self.plans[0].end + 60.0  # reboot scenario
        self.reconnect_t = self.plans[0].end + 120.0  # disconnect / reboot scenarios

        if self.cfg.start is not None:
            self.start = self.cfg.start
        elif self.cfg.speed == 0:
            self.start = datetime.now(UTC) - timedelta(seconds=self.end_t)
        else:
            self.start = datetime.now(UTC)

        self.t = 0.0  # simulated seconds since start
        self.boot_t = -3600.0  # board has been powered for an hour when we start
        self.boot_id = self._new_boot_id()
        first = self.cfg.first_cycle_no
        if first is None:
            first = int(self.start.timestamp()) // 10  # unique per run, fits in uint32
        self.cycle_no = first - 1  # last used cycle number ("stored in flash")
        self.flash: list[_FlashRecord] = []
        self.connected = False
        self.received: list[str] = []  # lines the receiver sent us (T / A)

        self._out: list[SourceEvent] = []
        self._rx = LineAssembler()
        self._last_baseline: tuple[int, float, float, float, float] | None = None
        self._err_in = SensorError.OK
        self._err_out = SensorError.OK
        self._next_hello = 0.0
        self._next_baseline = 0.0
        self._current: _FlashRecord | None = None
        self._current_plan: PlannedCycle | None = None
        self._offline_until = -1.0
        self._dropped_once = False
        self._rebooted = False

    # ------------------------------------------------------------------ #
    # Source interface
    # ------------------------------------------------------------------ #
    async def events(self) -> AsyncIterator[SourceEvent]:
        step = self.cfg.sample_period_s
        while self.t <= self.end_t:
            self._tick()
            out, self._out = self._out, []
            for ev in out:
                yield ev
                await asyncio.sleep(0)  # let the receiver run and send acks
            self.t += step
            if self.cfg.speed > 0:
                await asyncio.sleep(step / self.cfg.speed)
        if self.connected:
            self.connected = False
            yield LinkEvent(False, self.now)

    async def send(self, data: bytes) -> None:
        self.receive(data)

    def receive(self, data: bytes) -> None:
        """Handle T / A lines from the receiver. A,<cycle>,<seq>,1 erases that cycle."""
        for line in self._rx.feed(data):
            self.received.append(line)
            parts = line.split(",")
            if parts[0] != "A" or len(parts) != 4:
                continue
            try:
                cycle_no, seq, done = (int(p) for p in parts[1:])
            except ValueError:
                continue
            for rec in list(self.flash):
                if rec.cycle_no == cycle_no:
                    rec.acked_seq = max(rec.acked_seq, seq)
                    if done == 1:
                        self.flash.remove(rec)

    # ------------------------------------------------------------------ #
    # Clock and helpers
    # ------------------------------------------------------------------ #
    @property
    def now(self) -> datetime:
        return self.start + timedelta(seconds=self.t)

    @property
    def ms(self) -> int:
        return int(round((self.t - self.boot_t) * 1000)) % 2**32

    @property
    def backlog_count(self) -> int:
        return sum(len(r.samples) - (r.acked_seq + 1) for r in self.flash)

    def _new_boot_id(self) -> int:
        return self.rng.randint(1, 2**32 - 1)

    def _plan_cycles(self) -> list[PlannedCycle]:
        plans = []
        t = self.cfg.first_idle_minutes * 60
        for k in range(self.cfg.cycles):
            dur = self.cfg.cycle_minutes * 60
            if self.cfg.scenario == "vent":
                dur *= 1 + 0.1 * k  # clogged vent -> slower drying
            plans.append(PlannedCycle(k, t, t + dur))
            t += dur + self.cfg.idle_minutes * 60
        return plans

    def _plan_at(self, t: float) -> PlannedCycle | None:
        for p in self.plans:
            if p.start <= t < p.end:
                return p
        return None

    def _send_line(self, line: str) -> None:
        data = (line + "\n").encode("ascii")
        for i in range(0, len(data), PACKET_SIZE):
            self._out.append(DataEvent(data[i : i + PACKET_SIZE], self.now))

    # ------------------------------------------------------------------ #
    # One simulated time step
    # ------------------------------------------------------------------ #
    def _tick(self) -> None:
        t = self.t
        if self.cfg.scenario == "reboot" and not self._rebooted and t >= self.reboot_t:
            self._reboot()

        want = self._want_connected(t)
        if want and not self.connected:
            self._connect()
        elif not want and self.connected:
            self._disconnect()

        plan = self._plan_at(t)
        if self._current_plan is not None and plan is not self._current_plan:
            self._end_cycle()
        if plan is not None:
            if self._current_plan is None:
                self._start_cycle(plan)
            self._cycle_sample(plan, t - plan.start)
        else:
            self._idle(t)

        if self.connected and t >= self._next_hello:
            self._hello()

    def _want_connected(self, t: float) -> bool:
        if t < self._offline_until:
            return False
        if self.cfg.scenario in ("disconnect", "reboot") and t < self.reconnect_t:
            return False
        return True

    def _connect(self) -> None:
        self.connected = True
        self._out.append(LinkEvent(True, self.now))
        self._hello(state="uploading" if self.backlog_count else None)
        # Upload everything still in flash, oldest first (protocol.md section 5).
        total, sent = self.backlog_count, 0
        for rec in list(self.flash):
            self._send_line(rec.c_line)
            for seq in range(rec.acked_seq + 1, len(rec.samples)):
                if (
                    self.cfg.scenario == "disconnect"
                    and not self._dropped_once
                    and total >= 4
                    and sent >= total // 2
                ):
                    # Drop the link once, halfway through the upload.
                    self._dropped_once = True
                    self._offline_until = self.t + 30
                    self._disconnect()
                    return
                self._send_line(rec.samples[seq] + ",F")
                sent += 1
            if rec.e_line:
                self._send_line(rec.e_line)

    def _disconnect(self) -> None:
        self.connected = False
        self._out.append(LinkEvent(False, self.now))

    def _reboot(self) -> None:
        self._rebooted = True
        if self.connected:
            self._disconnect()
        self.boot_id = self._new_boot_id()  # flash keeps the old cycle with the old boot_id
        self.boot_t = self.t
        self._last_baseline = None  # RAM is lost
        self._next_baseline = self.t

    def _hello(self, state: str | None = None) -> None:
        if state is None:
            state = "running" if self._current_plan is not None else "idle"
        self._send_line(
            f"H,{PROTOCOL_VERSION},{self.boot_id},{self.ms},{state},{self.backlog_count},"
            f"{int(self._err_in)},{int(self._err_out)}"
        )
        self._next_hello = self.t + HELLO_EVERY_S

    def _set_errors(self, err_in: SensorError, err_out: SensorError) -> None:
        if (err_in, err_out) != (self._err_in, self._err_out):
            self._err_in, self._err_out = err_in, err_out
            if self.connected:
                self._hello()  # tell the receiver right away

    def _start_cycle(self, plan: PlannedCycle) -> None:
        self.cycle_no += 1
        base = self._last_baseline
        tail = [str(base[0]), *(_f(v) for v in base[1:])] if base else [""] * 5
        c_line = ",".join(["C", str(self.boot_id), str(self.cycle_no), str(self.ms), *tail])
        rec = _FlashRecord(self.boot_id, self.cycle_no, c_line)
        self.flash.append(rec)
        self._current, self._current_plan = rec, plan
        if self.connected:
            self._send_line(c_line)

    def _cycle_sample(self, plan: PlannedCycle, tau: float) -> None:
        self._set_errors(*self._sensor_errors(plan, tau))
        if self._err_in != SensorError.OK or self._err_out != SensorError.OK:
            return  # protocol: no S lines while a sensor is in error
        rec = self._current
        assert rec is not None
        p_in, t_in, p_out, t_out = self._cycle_reading(plan, tau)
        seq = len(rec.samples)
        line = ",".join(
            ["S", str(rec.boot_id), str(rec.cycle_no), str(seq), str(self.ms),
             _f(p_in), _f(t_in), _f(p_out), _f(t_out)]
        )  # fmt: skip
        rec.samples.append(line)
        if self.connected:
            self._send_line(line + ",L")

    def _end_cycle(self) -> None:
        rec = self._current
        assert rec is not None
        rec.e_line = f"E,{rec.boot_id},{rec.cycle_no},{self.ms},{len(rec.samples)}"
        if self.connected:
            self._send_line(rec.e_line)
        self._current, self._current_plan = None, None

    def _idle(self, t: float) -> None:
        self._set_errors(SensorError.OK, SensorError.OK)
        if t >= self._next_baseline:
            p_in, t_in, p_out, t_out = self._idle_reading(t)
            self._last_baseline = (self.ms, p_in, t_in, p_out, t_out)
            if self.connected:
                self._send_line(
                    f"B,{self.boot_id},{self.ms},{_f(p_in)},{_f(t_in)},{_f(p_out)},{_f(t_out)}"
                )
            self._next_baseline = t + BASELINE_EVERY_S

    # ------------------------------------------------------------------ #
    # Made-up physics
    # ------------------------------------------------------------------ #
    def _sensor_errors(self, plan: PlannedCycle, tau: float) -> tuple[SensorError, SensorError]:
        if self.cfg.scenario != "sensor_error":
            return SensorError.OK, SensorError.OK
        frac = tau / plan.duration
        if plan.k == 0 and 0.3 <= frac < 0.4:
            return SensorError.MISSING, SensorError.OK
        if plan.k == 1 and 0.5 <= frac < 0.6:
            return SensorError.OK, SensorError.BROKEN
        return SensorError.OK, SensorError.OK

    def _room(self, t: float) -> tuple[float, float]:
        """Room pressure (slow weather drift) and room temperature."""
        p = 101_325.0 + 40.0 * math.sin(2 * math.pi * t / 21_600)
        temp = 22.0 + 0.5 * math.sin(2 * math.pi * t / 86_400)
        return p, temp

    def _idle_reading(self, t: float) -> tuple[float, float, float, float]:
        g = self.rng.gauss
        p_room, t_room = self._room(t)
        p_out = p_room + g(0, 1.5)
        p_in = p_room + SENSOR_OFFSET_PA + g(0, 1.5)
        t_out = t_room + g(0, 0.05)
        t_in = t_room + 0.3 + g(0, 0.05)
        return p_in, t_in, p_out, t_out

    def _cycle_reading(self, plan: PlannedCycle, tau: float) -> tuple[float, float, float, float]:
        g = self.rng.gauss
        k = plan.k
        scenario = self.cfg.scenario
        lint = 1.0 if scenario == "vent" else 1.0 + LINT_PER_CYCLE * k
        vent = max(0.3, 1.0 - VENT_PER_CYCLE * k) if scenario == "vent" else 1.0
        heat_extra = 2.5 * k if scenario == "vent" else 0.0

        dp_run = CLEAN_DP_PA * lint * vent
        ramp = min(1.0, tau / 60.0)  # blower spin-up
        dp = dp_run * ramp + 3.0 * math.sin(2 * math.pi * tau / 7.0) + g(0, 2.0)  # tumbling wobble

        p_room, t_room = self._room(self.t)
        p_out = p_room + g(0, 1.5)
        p_in = p_out + dp + SENSOR_OFFSET_PA

        target = 55.0 + heat_extra
        cool_start = max(0.0, plan.duration - 120.0)  # heater off for the last 2 minutes
        if tau < cool_start:
            t_in = t_room + (target - t_room) * (1 - math.exp(-tau / 300.0))
        else:
            hot = t_room + (target - t_room) * (1 - math.exp(-cool_start / 300.0))
            t_in = t_room + (hot - t_room) * math.exp(-(tau - cool_start) / 90.0)
        t_in = min(84.0, t_in + g(0, 0.1))
        t_out = t_room + g(0, 0.05)
        return p_in, t_in, p_out, t_out


# ---------------------------------------------------------------------- #
# Command line
# ---------------------------------------------------------------------- #
def add_sim_arguments(parser: argparse.ArgumentParser) -> None:
    """Simulator options, shared with `ingest --source sim`."""
    g = parser.add_argument_group("simulator options")
    g.add_argument("--scenario", choices=list(SCENARIOS), default="normal",
                   help="; ".join(f"{k}: {v}" for k, v in SCENARIOS.items()))
    g.add_argument("--cycles", type=int, default=5, help="number of dryer cycles (default 5)")
    g.add_argument("--speed", type=float, default=0.0,
                   help="0 = as fast as possible (default), 1 = real time, 10 = 10x real time")
    g.add_argument("--cycle-minutes", type=float, default=45.0, help="cycle length (default 45)")
    g.add_argument("--idle-minutes", type=float, default=20.0, help="gap between cycles (default 20)")
    g.add_argument("--seed", type=int, default=1, help="random seed, for repeatable runs")  # fmt: skip


def config_from_args(args: argparse.Namespace) -> SimConfig:
    return SimConfig(
        scenario=args.scenario,
        cycles=args.cycles,
        speed=args.speed,
        cycle_minutes=args.cycle_minutes,
        idle_minutes=args.idle_minutes,
        seed=args.seed,
    )


async def _print_lines(board: SimBoard) -> None:
    asm = LineAssembler()
    async for ev in board.events():
        if isinstance(ev, LinkEvent):
            print(f"# link {'up' if ev.connected else 'down'}", flush=True)
        else:
            for line in asm.feed(ev.data):
                print(line, flush=True)


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(
        description="Print the protocol lines a simulated board would send (no database needed)."
    )
    add_sim_arguments(parser)
    args = parser.parse_args(argv)
    try:
        asyncio.run(_print_lines(SimBoard(config_from_args(args))))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()

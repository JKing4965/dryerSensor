# Test Mode Plan: USB test bench and clean/full lint calibration

**Goal:** test the system on a bench or lint-simulation rig, without a dryer and without
shaking the board, and **without changing the firmware**. Then teach the system what a
**clean** and a **full** lint screen look like, so it can report how full the screen is.

Like the earlier plans: each **🛑 CHECKPOINT** is a pause, and each verified checkpoint is
committed to `main`.

---

## 0. How it works

```
                                  USB cable (debug line, 1 reading per second)
[XIAO board] ────────────────────────────────────────────────▶ [test bench, inside the standby receiver on the PC]
     │ Bluetooth (unchanged)                                            │ builds test cycles from those readings
     ▼                                                                  ▼
[standby receiver] ───────────────▶ [database] ◀── [dashboard "Test" tab: Start / End test cycle, label: clean / full / normal]
```

- **The firmware doesn't change.** It already prints a full reading every second on USB
  (`DEBUG 1`, the default): inside and outside pressure and temperature, and ΔP. The test bench reads that line.
- **The dashboard's new Test tab** sends Start / End requests through the database, the same way the Connect button works.
  - Start has an optional auto-stop: until stopped, 5, 10, 20 or 45 min.
  - Each test cycle gets a **label**: *normal*, *clean screen* or *full screen*.
- **The test bench** runs inside the standby receiver (`dryer_backend.remote`), so the login
  auto-start covers it. It turns the 1-second readings into a normal cycle through the
  existing pipeline (the same C/S/E messages internally), so charts, the cycle history and lint numbers all work.
- **Calibration:** cycles labelled *clean screen* and *full screen* set two reference ΔP values.
  Every other cycle is placed between them as a **lint fullness %**: 0 % = clean, 100 % = full.
  That replaces the guess "15 % / 35 % more suction than the first cycles after cleaning" with
  your rig's measured clean and full readings.

### What stays the same
- **No change to Bluetooth, the board's own cycles, or the protocol.**
- **Without calibration,** the lint verdict works as before.
- **Test cycles are marked** in the database and dashboard, so they're never confused with real dryer cycles.

---

## 1. Design decisions

### 1.1 Reading the board over USB
- **The library:** Python's `pyserial`, a new backend dependency.
- **Finding the port:** the board is found by its USB vendor ID (Seeed, `0x2886`), or set by `TEST_SERIAL_PORT=COM5` in `.env`.
- **The Serial Monitor must be closed,** because only one program can open the port.
- **The line format,** from `main.ino`'s `debugStatus()`:
  `t=123s IDLE     vib=4mg  in 101337.12 Pa 22.40 C  out 101325.00 Pa 22.10 C  dP 12.12 Pa  err 0/0  link=1 backlog=0`.
  Lines with `(no valid reading)` or non-zero error codes are skipped, just as the board itself skips them.
- **Unplugging:** if the board is unplugged, the test bench reports "USB board not found" and keeps retrying.

### 1.2 Test cycles
- **Start:** uses the latest idle reading (from at most 2 minutes earlier) as the baseline, so ΔP is offset-corrected like a real cycle.
- **Numbering:** test cycles get numbers from **3 000 000 000 upwards**, so they never clash with the board's own cycle numbers.
- **The `cycles` table** gains two columns:
  - `is_test` (true for these)
  - `label` (`normal` / `clean` / `full`)
- **Timestamps:** the computer's clock, at the moment each reading arrives.
- **Ending:** End, or the auto-stop. If the USB readings stop for 30 s, the cycle ends **incomplete**.

### 1.3 Control channel
- **A new table, `test_control`,** one row per device:
  - the request: `command` (start/stop), `seconds`, `label`, `command_id`
  - what the test bench did: `done_id`, `result` (`started` / `stopped` / `expired` / `no_board`)
  - the test bench's heartbeat: online, USB port, latest reading, current test cycle
- **Requests expire:** a request older than 60 s is dropped, so a test never starts long after the button was pressed.
- **Upgrading:** a migration, `backend/db/migrations/002_test_mode.sql`, adds everything to existing databases (local and cloud) without touching data.

### 1.4 Clean / full calibration (lint fullness)
- **Clean reference:** the median `dp_steady` of the **3 most recent** complete cycles labelled `clean`.
- **Full reference:** the same, for cycles labelled `full`.
- **Fullness for every other cycle:** `fullness = (dp_steady − clean_dp) / (full_dp − clean_dp)`, shown as 0–100 %. Values outside that range are shown as they are, for example 120 %.
- **Status, once both references exist:**
  - fullness < 50 % → **clean**
  - 50–80 % → **check soon**
  - ≥ 80 % → **clean now**

  The two thresholds live in `lint_settings` and can be changed without code.
- **A sanity check:** if the clean and full references are less than 10 Pa apart, the calibration is flagged as **too close to tell apart**, and the old verdict is used.
- **Fallback:** without both references, the existing "change since last cleaning" verdict is used, unchanged.
- **Whether test cycles count:** a setting decides whether test cycles count toward the lint verdict, on by default for the rig. Calibration cycles themselves never count as normal cycles.

### 1.5 Safety
- **The test suite only uses the local Docker database,** never `DATABASE_URL` from `.env`, which may point at the cloud. `TEST_DATABASE_URL` can override that, for local databases only.
- **The test bench only reads from the USB port.** It never writes to the board.

---

## PART T: STEPS

### T0. Test-suite safety (first, before running any test)
- `backend/tests/conftest.py`: use the local Docker database (or `TEST_DATABASE_URL`), never `.env`'s `DATABASE_URL`.

> **🛑 CHECKPOINT T0:** `uv run python -m pytest` passes with `.env` pointing at Timescale Cloud, and nothing named `dryer_test` appears in the cloud database.

### T1. Database
- The `cycles.is_test` and `cycles.label` columns, the `test_control` table, and the calibration settings in `lint_settings` (`check_soon_fullness` 0.5, `clean_now_fullness` 0.8, `calibration_min_gap_pa` 10, `count_test_cycles` true).
- Add them to `schema.sql` / `seed.sql`, and in migration 002.

> **🛑 CHECKPOINT T1:** migration 002 runs twice on local Docker without errors. You run it once on Timescale Cloud (the same `psql` command as before).

### T2. USB test bench (backend)
- `dryer_backend/testbench.py`:
  - port detection and the debug-line parser
  - turning readings into test cycles through the existing receiver pipeline
  - checking `test_control`, plus the heartbeat
- Started by `dryer_backend.remote`, so the login auto-start covers it. It can also be run alone: `uv run python -m dryer_backend.testbench`.
- **Tests:** the line parser on real line shapes from `main.ino`; a full start → readings → stop run with a fake serial port; expiry; unplugged board; auto-stop.

> **🛑 CHECKPOINT T2** (your rig, USB plugged in, Serial Monitor closed):
> - `-Status` (or the receiver log) shows "test bench: board on COM…".
> - `test_control` gets requests from SQL; the dashboard comes in T3.

### T3. Dashboard "Test" tab
- **A new tab, Test,** showing:
  - test bench status: USB board found, latest reading
  - **Start test cycle** with an auto-stop choice and a label (*normal* / *clean screen* / *full screen*), and **End test cycle**
  - the request's progress (waiting / started / expired / no USB board)
  - a list of recent test cycles with their labels and ΔP
- **API:** `/api/test`, GET for the status, POST for start and stop. Same login and same-origin checks as the other routes.
- **Elsewhere,** test cycles show a **TEST** label (and *clean* / *full*) on the Cycles pages.

> **🛑 CHECKPOINT T3:** from the Vercel dashboard, start a 5-minute test cycle with your rig. It appears live, ends by itself, and shows in the Cycles list marked TEST.

### T4. Lint calibration
- `views.sql`: clean and full references, fullness per cycle in `lint_history`, the fullness-based status in `lint_status` with the fallback and the sanity check. It can be re-applied without data loss.
- **Lint page:**
  - a **lint fullness gauge** (0–100 %)
  - "Calibrated from N clean and M full test cycles", or what's still missing
  - trend chart lines at the clean and full references
- **Tests:** the fullness math, the thresholds, the fallback without calibration, the too-close warning, and that calibration cycles are left out of the verdict.

> **🛑 CHECKPOINT T4** (your rig):
> - Record **2–3 test cycles labelled "clean screen"** and **2–3 labelled "full screen"**.
> - The Lint page shows both references and says it's calibrated.
> - Run *normal* test cycles with a partly filled screen: fullness lands between the two and the verdict follows (clean → check soon → clean now as you add lint).

### T5. Docs
- **README:** a test-mode section (USB set-up, Test tab, calibration procedure, troubleshooting: port busy, no readings, references too close).
- **`docs/protocol.md` is unchanged:** test mode doesn't use Bluetooth messages.

> **🛑 CHECKPOINT T5:** a teammate can follow the README to calibrate on the rig.

---

## Risks and notes
| Topic | Risk | Plan |
|---|---|---|
| Serial Monitor open | The test bench can't open the port | The Test tab shows "USB port busy, close the Serial Monitor" |
| Rig airflow differs from a real dryer | Rig calibration doesn't carry over to the dryer | The calibration is tied to the rig; recalibrate on the real dryer with *clean* / *full* labelled real cycles later (same mechanism) |
| Fan speed changes between runs | ΔP shifts, and fullness is wrong | Keep the rig fan at the same setting; the too-close check catches failed calibrations |
| Board cycle (vibration) during a test | Two overlapping cycles | Both are stored; the test one is marked TEST. On a bench, vibration rarely triggers |
| `DEBUG 0` firmware | No USB readings | The current firmware defaults to `DEBUG 1`; the Test tab says "no readings from USB board" |

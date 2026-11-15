# Dryer Sensor — Build Plan (backend + frontend)

This plan covers everything **except the Arduino firmware**. The firmware is written
later and must follow [`protocol.md`](protocol.md), which Backend step B2 creates.

Steps marked **🛑 CHECKPOINT** are pauses. Stop there, check that everything works,
and only then continue.

---

## 0. The system at a glance

```
[XIAO nRF52840 Sense]                       (firmware: later)
  inside BMP585 (under the lint screen) + outside BMP585 (room air)
  saves baseline + samples to flash when no computer is connected
        │  Bluetooth, Nordic UART Service, text lines (docs/protocol.md)
        ▼
[backend/  Python receiver]                 runs directly on the computer (not Docker)
  reassembles lines → parses → syncs time → writes batches → tracks cycles → cycle features
        │  SQL
        ▼
[TimescaleDB]                               Docker (docker-compose.yml)
  readings · cycles · events · device_status · lint_status (view)
        ▲  SQL (server side only)
        │
[frontend/  Next.js dashboard]              http://localhost:3000
  Live · Cycles · Lint + "Filter cleaned" button
```

### Physical facts the software relies on
- The **inside sensor sits under the lint screen**, between the screen and the blower
  housing. That is the blower's suction side, so while the fan runs the pressure there
  is **below room pressure**.
  `ΔP = p_in − p_out` is negative during a cycle.
- **Lint on the screen** makes it harder for air to get through, so ΔP should become
  **more negative** over cycles.
- **A clogged exhaust duct** reduces airflow, so ΔP should move **toward zero**, and the
  inside temperature should rise and cycles should get longer.
- These are hypotheses until real cycles are recorded. The lint thresholds are placeholders
  to tune.
- When the dryer is idle, both sensors see the same room air, so any idle `p_in − p_out`
  is **sensor offset**. Every cycle's ΔP is corrected by its own pre-cycle baseline.

### Tools (already installed on this machine)
| Tool | Version here | Used for |
|---|---|---|
| Docker + Compose | 29.5 / v5.1 | TimescaleDB |
| uv | 0.13 | Python environment |
| Node / npm | 26 / 11 | Next.js |

Each teammate needs the same tools. Version pins go in `.python-version`, `frontend/.nvmrc`,
`uv.lock` and `package-lock.json`.

---

## 1. Repository layout (organized by language)

```
dryerSensor/
├── arduino_code/                  Arduino C++ (.ino)       untouched in this plan
├── docs/                          Markdown
│   ├── build_plan.md              this file
│   └── protocol.md                Bluetooth message format (contract with the firmware)
├── docker-compose.yml             YAML  — TimescaleDB container
├── .env.example                   database settings template (copy to .env, never commit .env)
│
├── backend/                       ── PYTHON (uv project) ──
│   ├── pyproject.toml / uv.lock / .python-version
│   ├── db/
│   │   ├── schema.sql             SQL   — tables, hypertable, lint_settings
│   │   ├── seed.sql               SQL   — the 'dryer-1' device row + default lint thresholds
│   │   └── views.sql              SQL   — lint_history + lint_status views (re-appliable without data loss)
│   ├── src/dryer_backend/
│   │   ├── __init__.py
│   │   ├── config.py              reads .env (DB URL, device name, timeouts)
│   │   ├── protocol.py            line reassembly + parsing into typed messages
│   │   ├── sources.py             where lines come from: BLE, simulator, replay file
│   │   ├── ble_link.py            bleak connect/reconnect, notifications, writes to board
│   │   ├── timesync.py            converts board milliseconds → real timestamps
│   │   ├── db.py                  connection pool, batched inserts, status updates
│   │   ├── cycles.py              opens/closes cycles, ignores duplicates, timeouts
│   │   ├── features.py            per-cycle numbers (ΔP, temperatures, duration)
│   │   ├── simulator.py           fake board: clean→dirty cycles, disconnect + flash backlog
│   │   └── ingest.py              entry point: wires source → parser → db
│   ├── tests/                     pytest
│   │   ├── conftest.py            temporary dryer_test database for DB tests
│   │   ├── fixtures/              recorded/simulated line files
│   │   ├── test_protocol.py
│   │   ├── test_timesync.py
│   │   ├── test_simulator.py
│   │   ├── test_cycles.py         end-to-end receiver tests against the test database
│   │   └── test_features.py
│   └── tools/
│       └── ble_reader.py          existing debug tool (moved from repo root)
│
└── frontend/                      ── NEXT.JS (TypeScript, App Router, Tailwind) ──
    ├── package.json / package-lock.json / .nvmrc / tsconfig.json / next.config.ts
    ├── .env.local.example
    └── src/
        ├── app/                   pages (.tsx) and API routes (.ts)
        │   ├── layout.tsx         shell + navigation
        │   ├── page.tsx           Live page
        │   ├── cycles/page.tsx            cycle history list
        │   ├── cycles/[id]/page.tsx       one cycle's charts
        │   ├── lint/page.tsx              lint status, trend, Filter cleaned button
        │   └── api/
        │       ├── status/route.ts        GET device + current cycle status
        │       ├── live/route.ts          GET recent readings (downsampled)
        │       ├── cycles/route.ts        GET cycle list
        │       ├── cycles/[id]/route.ts   GET one cycle's readings
        │       ├── lint/route.ts          GET lint status + trend
        │       └── filter-cleaned/route.ts POST records a cleaning event
        ├── lib/                   server-only helpers (.ts)
        │   ├── db.ts              PostgreSQL pool (credentials stay on the server)
        │   ├── queries.ts         all SQL used by the API routes
        │   └── types.ts           shared TypeScript types
        └── components/            React components (.tsx)
            ├── TimeSeriesChart.tsx
            ├── StatusBadge.tsx
            ├── LintStatusCard.tsx
            ├── FilterCleanedButton.tsx
            └── CycleTable.tsx
```

### File header rule
Every source file starts with a comment block that says:
1. **what the file does**
2. **what it talks to**: other files, the database, the board
3. **how to run or use it**, where that applies

Syntax by file type:
- Python: a module docstring `"""..."""`
- TypeScript/TSX: `/** ... */`
- SQL: `-- ...`
- YAML and `.env.example`: `# ...`
- Markdown: an opening paragraph

JSON files (`package.json`, `tsconfig.json`), lockfiles and generated files **can't hold
comments** and are the only exceptions.

### Repo housekeeping (done in B0)
- Add `node_modules/`, `.next/`, `.env` and `.env*.local` to `.gitignore`.
- Add `*.ts`, `*.tsx`, `*.sql`, `*.ino`, `*.yml` and `*.md` to `.gitattributes` with LF line endings.
- Move the uv project from the repo root into `backend/`, and update `README.md` with the
  new run commands.

---

## 2. Key design decisions

### 2.1 Flash backlog and timestamps
The dryer can start before the computer connects. So the board saves the **pre-cycle
baseline** and the **cycle samples** to flash, then uploads them when the computer connects.
Saved samples only carry board time (milliseconds since boot), so:

1. On connect, the board sends a hello line with `boot_id` (a random number chosen at
   each power-up) and its current `ms`.
2. The receiver computes `offset = computer_now − board_ms` for that `boot_id`.
3. Every sample from that boot gets `time = offset + sample_ms`.
4. Samples from an earlier boot whose offset is unknown are saved with `time_estimated = true`,
   placed right before the first known sample, and flagged in the dashboard.
5. After storing samples, the receiver sends `ACK`, so the board knows which flash data
   is safe to erase.

### 2.2 Duplicates
A reconnect can resend data that already arrived. Each cycle remembers the highest
sequence number it stored (`cycles.last_seq`), and the receiver skips any sample at or
below it. Cycle identity is `(device_id, cycle_no)`. The board keeps `cycle_no` in flash
so it survives restarts.

### 2.3 Where the lint logic lives
- Python computes **per-cycle numbers** once a cycle ends (`features.py`).
- The **status** (clean / check soon / clean now) comes from a **SQL view**,
  `lint_status`. It compares recent cycles with the reference cycles recorded right after
  the latest `filter_cleaned` event.
- So the dashboard's **Filter cleaned** button only inserts one row into `events`, and
  the status updates on the next query. The logic lives in one place, not in two languages.

### 2.4 Live updates
The dashboard polls `/api/status` and `/api/live` every 2 s. That's simple and plenty for
1–2 samples a second. A server push (SSE fed by PostgreSQL `LISTEN/NOTIFY`) can come later.

### 2.5 Charts
Recharts, with the database reducing the data to about 500 points per chart
(`time_bucket`), so a long cycle stays fast on any screen.

---

## 3. Bluetooth message format (summary; `docs/protocol.md` is the full spec and wins if they differ)

Text lines ending in `\n`, comma-separated fields, pressure in **Pa**, temperature in **°C**.
The Adafruit library returns hPa, so the firmware multiplies by 100.

**Board → computer**

| Line | Meaning |
|---|---|
| `H,1,<boot_id>,<ms>,<state>,<backlog_count>,<err_in>,<err_out>` | hello/status: protocol v1, sent on connect, every 30 s and when a sensor error changes; error codes 0 = ok, 1 = missing, 2 = broken |
| `B,<boot_id>,<ms>,<p_in>,<t_in>,<p_out>,<t_out>` | baseline reading taken while idle (live only) |
| `C,<boot_id>,<cycle_no>,<ms>,<base_ms>,<base_p_in>,<base_t_in>,<base_p_out>,<base_t_out>` | cycle started; carries the pre-cycle baseline, which is saved to flash with the cycle |
| `S,<boot_id>,<cycle_no>,<seq>,<ms>,<p_in>,<t_in>,<p_out>,<t_out>,<src>` | one sample |
| `E,<boot_id>,<cycle_no>,<ms>,<n_samples>` | cycle ended (vibration stopped) |

**Computer → board**

| Line | Meaning |
|---|---|
| `T,<unix_ms>` | current real time (optional; lets the board label its flash data) |
| `A,<cycle_no>,<seq>,<done>` | stored everything up to `seq`; `done=1` → whole cycle stored, the board may erase it from flash |

Because Bluetooth splits lines across packets, the receiver collects bytes until it sees
a newline. Bad lines are logged and skipped, never crash the receiver.

---

## 4. Database tables (summary; full SQL in B1 → `backend/db/schema.sql`)

| Table | Contents |
|---|---|
| `readings` (hypertable on `time`) | `time, device_id, kind ('baseline' / 'cycle'), cycle_no, seq, p_in, t_in, p_out, t_out, dp (generated: p_in−p_out), dt (generated: t_in−t_out), source ('live' / 'flash'), time_estimated` |
| `cycles` | `id, device_id, cycle_no (unique per device), started_at, ended_at, state ('running' / 'complete' / 'incomplete'), n_samples, last_seq, baseline_dp, baseline_t_in, baseline_t_out` + features: `dp_steady (offset-corrected median ΔP), t_in_max, dt_mean, duration_s` |
| `events` | `id, device_id, time, type ('filter_cleaned'), note` |
| `device_status` | `device_id, connected, last_seen, state, boot_id, backlog_count` |
| `lint_settings` | one row of tunable thresholds; change with `UPDATE`, no database reset needed |
| `lint_status` (view) | latest cycle vs reference → `score`, `status`, `cycles_since_cleaning`, and a `possible_vent_blockage` flag |

**Starting lint rule** (placeholders, to tune with real data):
- **Reference:** the average `dp_steady` of the first 2 complete cycles after the latest cleaning.
- **Score:** `(ref_dp − latest_dp) / |ref_dp|`, i.e. how much more negative ΔP became.
- **Status:**
  - `< 0.15` → clean
  - `0.15–0.35` → check soon
  - `> 0.35` → clean now
  - no reference yet → "calibrating"
- **Vent flag:** ΔP moved **toward zero** by more than 25% while `t_in_max` rose → "check exhaust duct".

---

## PART A — BACKEND (Python + database)

### B0. Restructure the repo
- Create the folders from section 1. Move `pyproject.toml`, `uv.lock` and `.python-version`
  into `backend/`, and move `ble_reader.py` into `backend/tools/`.
- Add dependencies: `bleak`, `psycopg[binary,pool]`, `python-dotenv`, plus `pytest` as a dev dependency.
- Write `docker-compose.yml` (TimescaleDB, data in a named volume, port 5432) and `.env.example`.
- Update `.gitignore`, `.gitattributes` and `README.md`.

> **🛑 CHECKPOINT 1 — environment**
> - `cd backend` → `uv sync` finishes without errors.
> - `uv run tools/ble_reader.py --scan` still works.
> - Copy `.env.example` to `.env` → `docker compose up -d` → `docker compose ps` shows the database as *healthy*.
> - `git status` shows the files as moved, not deleted and re-added.

### B1. Database schema
- Write `backend/db/schema.sql` from section 4. Docker runs it automatically on the first start.
  It must begin with `CREATE EXTENSION IF NOT EXISTS timescaledb;`. Mounting `backend/db/`
  replaces the image's own setup script, so the extension is loaded but not switched on.
  Run `docker compose down -v` first so the empty database is recreated and the script runs.
- Seed one device row.

> **🛑 CHECKPOINT 2 — database**
> - `docker compose exec db psql -U dryer -d dryer -c "\dt"` lists `readings`, `cycles`, `events` and `device_status`.
> - `... -c "SELECT * FROM lint_status"` runs (empty or "calibrating" is correct).
> - Read through `schema.sql`. Do the columns match what you want to store?

### B2. Message format + parser
- Write `docs/protocol.md`, the full spec from section 3 with examples. **This is the contract the firmware will follow.**
- `protocol.py`: assemble lines from packet fragments, parse each type into a dataclass, check field counts and value ranges.
- `timesync.py`: offset per `boot_id`, plus the estimate for unknown boots.
- Tests: `test_protocol.py` (split lines, bad lines, every message type) and `test_timesync.py`.

> **🛑 CHECKPOINT 3 — format approval**
> - **Read `docs/protocol.md` carefully.** Once firmware is written to it, changing it is costly. Is anything missing (battery voltage, an error code)?
> - `uv run pytest` → all tests pass.

### B3. Simulator + receiver (no hardware needed)
- `simulator.py` produces realistic lines:
  - idle baselines
  - a cycle with spin-up, steady ΔP and noise
  - a run of cycles from **clean to dirty** (ΔP gradually more negative)
  - optionally a **vent-clog** run
  - a "**disconnected**" scenario that hands over flash data on reconnect
- `sources.py`: a common interface with `sim` and `replay <file>` sources.
- `db.py`, `cycles.py` and `ingest.py`: batched writes about once a second, cycle open/close,
  duplicate skipping, `device_status` updates, and marking a running cycle `incomplete` after a timeout.
- Commands:
  - `uv run python -m dryer_backend.ingest --source sim --speed 60` (60× speed)
  - `--source replay tests/fixtures/<file>`

> **🛑 CHECKPOINT 4 — data lands in the database**
> - Run the simulator for a few cycles. `SELECT count(*) FROM readings;` keeps growing.
> - `SELECT cycle_no, state, n_samples, started_at, ended_at FROM cycles;` shows complete cycles with sensible times.
> - Run the "disconnected" scenario. The flash samples get timestamps **before** the reconnect, and none are duplicated.
> - Stop the receiver with Ctrl+C mid-cycle and restart it. Nothing crashes and nothing is duplicated.

### B4. Real Bluetooth connection
- `ble_link.py`:
  - find the board by name
  - subscribe to the NUS TX characteristic
  - reconnect with backoff
  - write `T` and `A` lines to NUS RX
  - set `device_status.connected`
- `--source ble --name XIAO-BLE`

> **🛑 CHECKPOINT 5 — real board, typed messages**
> The real firmware isn't written yet, so use the **existing `BLEtest.ino`**. It forwards
> whatever you type in the Arduino Serial Monitor over Bluetooth.
> - Upload `BLEtest.ino`, then run the receiver with `--source ble`.
> - Paste the protocol lines from `docs/protocol.md`'s example section into the Serial Monitor.
> - Check that they appear in `readings` and `cycles`, and that the `T`/`A` replies the
>   receiver sends show up in the Serial Monitor.
> - Turn the board off and on. The receiver reconnects by itself.

### B5. Cycle features + lint status
- `features.py`:
  - pick the "steady" part of the cycle (skip spin-up and spin-down)
  - compute `dp_steady` corrected by the cycle's baseline, plus `t_in_max`, `dt_mean` and `duration_s`
  - save them when the cycle ends
- Finish the `lint_status` view and test the rules in `test_features.py`.

> **🛑 CHECKPOINT 6 — lint logic**
> - Run the simulator's clean→dirty run. `SELECT * FROM lint_status;` goes calibrating → clean → check soon → clean now.
> - `INSERT INTO events (device_id, type) VALUES ('dryer-1','filter_cleaned');` resets it to calibrating/clean.
> - Run the vent-clog scenario. The vent flag turns on.
> - `uv run pytest` → all pass.
> - **The backend is done at this point.** A good moment to commit and open a PR.

---

## PART B — FRONTEND (Next.js)

### F1. Set up the app + database connection
- `create-next-app` in `frontend/` with TypeScript, App Router, Tailwind and ESLint. Add the `pg`, `recharts` and `server-only` packages.
- `lib/db.ts` with a connection pool and `lib/queries.ts`. Add `.env.local.example` with the database URL.
- `GET /api/status` and a bare layout with navigation (Live · Cycles · Lint).

> **🛑 CHECKPOINT 7 — app runs and reads the database**
> - `cd frontend` → `npm install` → `npm run dev` → open http://localhost:3000.
> - http://localhost:3000/api/status returns JSON with the device row.
> - `npm run lint` and `npm run build` pass.
> - The page works at phone width as well (browser dev tools → responsive mode).

### F2. Live page
- A status badge (connected / idle / running cycle N / uploading backlog).
- A red sensor-error banner when either sensor reports `1` (missing: "Inside sensor not found,
  check wiring") or `2` (broken: "Outside sensor giving bad readings").
- Live charts: ΔP (offset-corrected) and inside vs. outside temperature for the current or
  most recent cycle, refreshed every 2 s.
- Flash-uploaded and estimated-time points are drawn differently.

> **🛑 CHECKPOINT 8 — live view**
> - Start the simulator (`--speed 10`) and watch the charts grow and the badge change from idle to running to idle.
> - Stop the receiver. The badge shows "disconnected" within about 30 s.

### F3. Cycle history
- `/cycles`: a table of date, duration, `dp_steady`, `t_in_max` and state.
- `/cycles/[id]`: full charts for one cycle, its baseline values, and its features.

> **🛑 CHECKPOINT 9 — history**
> - Every simulated cycle is listed, and clicking one opens the right charts.
> - Incomplete cycles are clearly marked.

### F4. Lint page + Filter cleaned button
- A status card (calibrating / clean / check soon / clean now) with plain-language advice and the vent warning.
- A trend chart of `dp_steady` per cycle since the last cleaning, with cleanings marked.
- A **Filter cleaned** button that asks "Mark the lint screen as cleaned now?", then sends
  `POST /api/filter-cleaned` → inserts an `events` row → refreshes the status.
- A reminder banner on every page while the status is "check soon" or "clean now".

> **🛑 CHECKPOINT 10 — lint workflow**
> - Simulate clean→dirty cycles. The card moves through the statuses and the banner appears.
> - Press **Filter cleaned**. A new row appears in `events`, the status resets, and the banner disappears.
> - A double-click doesn't create two events.

### F5. End-to-end + documentation
- README: one "how to run everything" section (database → receiver → dashboard) and a troubleshooting list.
- Run everything together with the board running `BLEtest.ino` and typed lines, then with a recorded replay file.

> **🛑 CHECKPOINT 11 — full system**
> - A teammate follows only the README on their own machine and gets the simulator data showing in the dashboard.
> - Commit and open a PR. The project is ready for the firmware to be written against `docs/protocol.md`.

---

## 5. After this plan: firmware (not in scope yet)
`main.ino` will need to:
- implement `docs/protocol.md`
- read both BMP585s (0x46 and 0x47, or separate I2C buses)
- start and stop cycles from the IMU with debounce
- save baselines and samples to the 2 MB flash chip when not connected, then upload and erase them after `A`
- not wait for USB serial (`while(!Serial)`)

Once it works, record real clean-filter and dirty-filter cycles and **tune the lint thresholds**
in `schema.sql`.

## 6. Open questions (don't block the build)
- Sample rate: the plan assumes 1 Hz. Everything works at any rate up to about 10 Hz.
- Is one dryer/device enough? The tables already support several via `device_id`.
- Fine lint passes through the screen onto the inside sensor. Its port may need a protective
  membrane (hardware).

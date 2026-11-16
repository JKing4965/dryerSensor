# dryerSensor

Dryer lint monitor. A Seeed XIAO nRF52840 Sense with two BMP585 temperature/pressure
sensors (one **under the lint screen**, one in **room air**) sends data over Bluetooth
to a computer. A Python receiver stores it in a TimescaleDB database, and a Next.js
dashboard shows live data, cycle history, and whether the lint screen needs cleaning.

```
[XIAO board] ──Bluetooth──▶ [backend: Python receiver] ──▶ [TimescaleDB in Docker] ◀── [frontend: Next.js dashboard]
 arduino_code/               backend/                       docker-compose.yml            frontend/  (http://localhost:3000)
```

- How it was built, step by step with checkpoints: [docs/build_plan.md](docs/build_plan.md)
- The Bluetooth message format the firmware must follow: [docs/protocol.md](docs/protocol.md)

## Repository layout

| Folder / file | Language | What's there |
|---|---|---|
| `arduino_code/` | Arduino C++ | Test sketches and `main.ino`. Copy the one you want into the Arduino IDE. |
| `backend/` | Python (uv) | Bluetooth receiver, parser, simulator, lint features, tests. `backend/db/` holds the SQL. |
| `frontend/` | Next.js / TypeScript | Dashboard. See [frontend/README.md](frontend/README.md). |
| `docs/` | Markdown | Build plan and Bluetooth message format. |
| `docker-compose.yml` | YAML | Runs the TimescaleDB database. |
| `.env.example` | text | Backend/database settings template. Copy to `.env`. |

## Quick start (copy-paste commands)

The commands work in **PowerShell, macOS and Linux**, except where noted. Sections 1–7 below
explain each step in more detail.

### 1. Install the tools (once per computer)

uv on Windows (PowerShell):
```powershell
powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
```
uv on macOS / Linux:
```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
```
Also install [Docker Desktop](https://www.docker.com/products/docker-desktop/) and
[Node.js 20.9+](https://nodejs.org/) (the team uses 26). Start Docker Desktop, then **open a
new terminal** so `uv` is found.

### 2. Get the code and install everything (once)

```bash
git clone https://github.com/JKing4965/dryerSensor.git
cd dryerSensor
cp .env.example .env
cp frontend/.env.local.example frontend/.env.local
cd backend
uv sync
cd ../frontend
npm install
cd ..
```
`uv sync` installs Python and the Python libraries; `npm install` installs the dashboard's
Node packages. Neither installs the other's, so both are needed.

### 3. Run it (every time)

From the `dryerSensor` folder, start the database and wait until it says **healthy**:
```bash
docker compose up -d
docker compose ps
```
Start the dashboard:
```bash
cd frontend
npm run dev
```
Open **http://localhost:3000** and press **Connect to sensor** on the Live tab. The board must be
powered and nearby.

When done, press **Disconnect** and Ctrl+C the dashboard. Optionally stop the database too
(data is kept):
```bash
docker compose down
```

### 4. Without the board (optional)

In a second terminal, from the `dryerSensor` folder:
```bash
cd backend
uv run python -m dryer_backend.ingest --source sim --scenario normal --cycles 7
uv run pytest
```
The first command fills the dashboard with simulated cycles; the second runs the backend tests.

### 5. After pulling new changes

From the `dryerSensor` folder:
```bash
git pull
cd backend
uv sync
cd ../frontend
npm install
cd ..
```
If the pull changed `backend/db/schema.sql` or `seed.sql`, also reset the database. **This
deletes stored data.** Anyone whose database was created before the November 2026 schema
changes needs to do this once:
```bash
docker compose down -v
docker compose up -d
```

### 6. Uploading firmware (only whoever flashes the board)

In the Arduino IDE:
- **Board:** **Seeed XIAO nRF52840 Sense** from "Seeed nRF52 Boards" (not the "No Updates" version).
- **Libraries** (Library Manager): Adafruit BMP5xx, Adafruit Unified Sensor, Adafruit BusIO,
  Seeed Arduino LSM6DS3, Adafruit SPIFlash, SdFat - Adafruit Fork.
- Open `arduino_code/main.ino` and upload.

If something fails, see **7. Troubleshooting** below.

## 1. One-time setup (each teammate)

Install these three tools. You do **not** need to install Python or any library by hand.

| Tool | Get it | Check |
|---|---|---|
| uv | Windows PowerShell: `powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 \| iex"`<br>macOS / Linux: `curl -LsSf https://astral.sh/uv/install.sh \| sh` | `uv --version` |
| Docker Desktop | [docker.com](https://www.docker.com/products/docker-desktop/), then **start it** | `docker compose version` |
| Node.js 20.9+ (team uses 26, see `frontend/.nvmrc`) | [nodejs.org](https://nodejs.org/) | `node --version` |

Then, once:

```
git clone https://github.com/JKing4965/dryerSensor.git
cd dryerSensor
cp .env.example .env                                   # PowerShell: Copy-Item .env.example .env
cp frontend/.env.local.example frontend/.env.local     # PowerShell: Copy-Item frontend/.env.local.example frontend/.env.local
cd backend  && uv sync     && cd ..
cd frontend && npm install && cd ..
```

`uv sync` downloads Python 3.13 and the exact library versions from `backend/uv.lock` into
`backend/.venv/` (in VS Code, pick `backend/.venv` as the Python interpreter). `npm install`
installs the dashboard's packages from `frontend/package-lock.json`.

## 2. Run everything

Use three terminals, all starting in the repo root.

**Terminal 1: database** (keeps running in the background):
```
docker compose up -d
docker compose ps          # wait until it says "healthy"
```

**Terminal 2: dashboard**:
```
cd frontend
npm run dev                # open http://localhost:3000
```

**Connect to the board:** on the Live tab, press **Connect to sensor**. The button works
through the database, so it behaves the same here and on the deployed (Vercel) dashboard:
- A **standby receiver** runs on the computer next to the dryer, checks every 3 s what the
  button asked for, and connects to or disconnects from the board. It writes a heartbeat,
  so the card shows **PC receiver offline / Ready / Searching… / Connected**.
- On a local dashboard, Connect also **starts the standby receiver** if none is running
  (its log is under "Receiver log"). It stops when the dashboard (`npm run dev`) stops.
- **Disconnect** drops the Bluetooth link; the standby receiver keeps waiting.
- The choice is remembered: after a reboot, the receiver reconnects if it was connected.

Run the standby receiver yourself (handy for watching its log, or when the dashboard runs
on Vercel):
```
cd backend
uv run python -m dryer_backend.remote
```
The one-off receiver, `uv run python -m dryer_backend.ingest --source ble`, still works for
testing (and `--source sim` in section 3). Run only one at a time: the board accepts a
single connection, so the card shows "Connected by a receiver started in a terminal" and
disables the buttons while a one-off receiver holds it.

**Databases created before the remote button** (anything set up before step D3b in
`docs/deployment_plan.md`) need its table once. This keeps all data:
```
docker compose exec -T db psql -U dryer -d dryer -v ON_ERROR_STOP=1 -f /docker-entrypoint-initdb.d/migrations/001_receiver_control.sql
```

The dashboard has three tabs:
- **Live:** Connect / Disconnect, connection badge, sensor errors, current cycle charts. Refreshes every 2 s.
- **Cycles:** every cycle, each opening its own charts.
- **Lint:** verdict, trend, and the **Filter cleaned** button. Press it right after you clean the screen.

A banner appears on every page when the screen needs cleaning or the exhaust duct looks blocked.

Stop everything: Ctrl+C in the dashboard terminal (and in the receiver terminal, if you
started one), then `docker compose down` (data is kept).

The local dashboard (`npm run dev`) is meant for your own computer or home network: its
Connect button can start a program on this computer, so don't expose it to the internet.
The deployed Vercel dashboard can't start programs; it only sends the request.

## 3. Without hardware: simulator and replay

Run one of these in a terminal instead of pressing Connect (from `backend/`):

```
uv run python -m dryer_backend.ingest --source sim --scenario normal --cycles 7
uv run python -m dryer_backend.ingest --source sim --scenario disconnect --cycles 2 --cycle-minutes 10 --speed 10
uv run python -m dryer_backend.ingest --source replay tests/fixtures/example_session.txt
uv run python -m dryer_backend.ingest --help
```

**Scenarios:**
- `normal`: lint builds up every cycle
- `vent`: the exhaust duct clogs
- `disconnect`: a cycle is recorded offline and uploaded later
- `reboot`: the board restarts before uploading, so times are estimated
- `sensor_error`: a sensor goes missing, then breaks

**Speed:**
- `--speed 0` (the default) runs instantly and back-dates the data so it ends now. Use this to fill the Cycles and Lint pages.
- `--speed 10` runs at 10× real time starting now. Use this to watch the Live page.

To see what a fake board sends without touching the database:
`uv run python -m dryer_backend.simulator --scenario normal --cycles 2`

**Start fresh** (deletes all stored data): `docker compose down -v`, then `docker compose up -d`.
Separate simulator runs are each back-dated to end "now", so they overlap in time. Reset
between scenarios for clean results.

## 4. The real board

- Advertised name: `XIAO-BLE`, set by `BLE_DEVICE_NAME` in `.env`. Find boards with `uv run tools/ble_reader.py --scan` (from `backend/`).
- The receiver keeps searching and reconnects by itself, retrying after 2 s and backing off to 30 s.
- Only **one** app can be connected to the board at a time. Close nRF Connect or the Bluefruit app first.
- **Before `main.ino` exists**, test the Bluetooth path with `arduino_code/BLEtest.ino`:
  1. Upload it and start the receiver with `--source ble`.
  2. Paste lines from [docs/protocol.md](docs/protocol.md) section 7 into the Arduino Serial Monitor (115200 baud, line ending **Newline**).
  3. The receiver's replies (`T,…`, `A,…`) appear in the Serial Monitor, and the data appears on the dashboard.

  `BLEtest.ino` must send whole lines with one `bleuart.write(buf, len)` call. See troubleshooting.

## 5. Lint logic and tuning

- **Per-cycle numbers:** when a cycle ends, the receiver computes them in [backend/src/dryer_backend/features.py](backend/src/dryer_backend/features.py), for example the steady ΔP with the sensor offset removed.
- **The verdict:** the views in [backend/db/views.sql](backend/db/views.sql) compare each cycle with the first 2 cycles after the last "Filter cleaned":
  - 15% more suction → *check soon*
  - 35% → *clean now*
  - ΔP moving 25% toward zero while hotter → *check the exhaust duct*

Look at it directly:
```
docker compose exec db psql -U dryer -d dryer -c "SELECT * FROM lint_status"
docker compose exec db psql -U dryer -d dryer -c "SELECT cycle_no, dp_steady, score, status FROM lint_history"
```

| To change | Do this | Data kept? |
|---|---|---|
| Thresholds | `docker compose exec db psql -U dryer -d dryer -c "UPDATE lint_settings SET check_soon_score = 0.20"` | yes |
| `backend/db/views.sql` | `docker compose exec -T db psql -U dryer -d dryer -f /docker-entrypoint-initdb.d/views.sql` | yes |
| `backend/src/dryer_backend/features.py` | from `backend/`: `uv run python -m dryer_backend.features --all` | yes |
| `backend/db/schema.sql` or `seed.sql` | `docker compose down -v` then `docker compose up -d` | **no** |

## 6. Tests and checks

| Where | Command | Notes |
|---|---|---|
| `backend/` | `uv run pytest` | Database tests use a temporary `dryer_test` database and are **skipped** if Docker isn't running |
| `frontend/` | `npm run lint` | Code style |
| `frontend/` | `npm run build` | Type check + production build; run before pushing dashboard changes |

## 7. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `docker compose up` says it can't connect to the Docker API / `dockerDesktopLinuxEngine` | Docker Desktop isn't running. Start it and wait for it to settle. |
| Database won't start: port 5432 already in use | Another PostgreSQL is running. Stop it, or set `POSTGRES_PORT=5433` in `.env` and change the port in `DATABASE_URL` in both `.env` and `frontend/.env.local`. |
| Receiver: `DATABASE_URL is not set` | `.env` is missing in the repo root. Copy it from `.env.example`. |
| Receiver: `database error … Is it running?` | Run `docker compose up -d`. |
| Receiver: `device 'dryer-1' is not in the devices table` | `DEVICE_ID` in `.env` doesn't match `backend/db/seed.sql`. |
| Dashboard: "Can't load live data … DATABASE_URL is not set" | `frontend/.env.local` is missing. Copy it from `.env.local.example`, then restart `npm run dev`. |
| Dashboard: `relation "lint_status" does not exist` or a missing column | The database was created from an older schema. Run `docker compose down -v` then `up -d` (deletes data). |
| Connect button: `Python not found … Run "uv sync" in backend/` | The backend environment doesn't exist yet. Run `uv sync` in `backend/`, or set `RECEIVER_PYTHON` in `frontend/.env.local`. |
| Connect button disabled, "Connected by a receiver started in a terminal" | A one-off `ingest` receiver holds the board. Stop it with Ctrl+C there. |
| Card says "PC receiver offline" | No standby receiver is running on the computer by the dryer. Start `uv run python -m dryer_backend.remote` there, or press Connect on a local dashboard. |
| Dashboard error: "The receiver_control table is missing" | The database predates the remote button. Load `backend/db/migrations/001_receiver_control.sql` (command in section 2). |
| Receiver log: "Bluetooth radio is not powered on" | Turn on Bluetooth on that computer. |
| `board 'XIAO-BLE' not found` | Board is off, out of range, or another app is connected to it. Check with `uv run tools/ble_reader.py --scan`. |
| Receiver logs `skipped bad line` with missing characters, e.g. `H,,0499,600,…` | The sketch writes one byte per Bluetooth packet and the queue drops about half. Collect the line and send it with one `bleuart.write(buf, len)` call. |
| Dashboard badge says **Disconnected** while data looks recent | The receiver isn't running, or hasn't written status for 65 s. Restart it. |
| Times in `psql` look hours off | The database shows UTC. The dashboard shows your local time. |
| `npm run dev`: port 3000 in use | Another dashboard is already running. Use that one, or stop it. |
| `create-next-app`/`npm` fails with `EPERM … rename` on Windows | A file watcher or antivirus briefly locked a folder. Run the command again. |
| `uv run pytest`: `Failed to spawn: pytest … Application Control policy has blocked this file` | Windows blocked the `pytest.exe` launcher, which happens when the repo sits in a Temp folder. Run `uv run python -m pytest` instead, or move the repo. |
| `uv sync` complains about the uv version | The lockfile needs uv ≥ 0.9. Run `uv self update`. |

## Adding or updating libraries

**Python** (from `backend/`): `uv add <package>`, `uv add --dev <package>`, `uv remove <package>`,
`uv lock --upgrade`. Always commit **both** `backend/pyproject.toml` and `backend/uv.lock`.

**Dashboard** (from `frontend/`): `npm install <package>` or `npm install -D <package>`. Always commit
**both** `frontend/package.json` and `frontend/package-lock.json`.

Never commit `.venv/`, `node_modules/`, `.env` or `frontend/.env.local`.

## Git workflow

1. `git pull` on `main`, then `git switch -c <your-branch>`.
2. Commit your changes and `git push -u origin <your-branch>`.
3. Open a pull request into `main` on GitHub; a teammate reviews and merges.
4. After a merge, everyone runs `git pull`, then `uv sync` in `backend/` and `npm install` in
   `frontend/`. If `backend/db/schema.sql` changed, also `docker compose down -v` and `up -d`.

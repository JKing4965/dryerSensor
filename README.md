# dryerSensor

Dryer lint monitor. A Seeed XIAO nRF52840 Sense with two BMP585 temperature/pressure
sensors (one under the lint screen, one in room air) sends data over Bluetooth to a
computer. A Python receiver stores it in a TimescaleDB database, and a Next.js
dashboard shows live data, cycle history and lint status.

The build plan with checkpoints is in [docs/build_plan.md](docs/build_plan.md).

## Repository layout

| Folder / file | Language | What's there |
|---|---|---|
| `arduino_code/` | Arduino C++ | Test sketches and `main.ino`. Copy the one you want into the Arduino IDE. |
| `backend/` | Python (uv) | Bluetooth receiver, parser, simulator, tests. `backend/db/` holds the SQL schema. |
| `frontend/` | Next.js / TypeScript | Dashboard (added in step F1). |
| `docs/` | Markdown | Build plan and Bluetooth message format. |
| `docker-compose.yml` | YAML | Runs the TimescaleDB database. |
| `.env.example` | text | Settings template. Copy to `.env`. |

## One-time setup (each teammate)

You need **uv**, **Docker Desktop** and (from step F1) **Node.js**. You do **not** need to
install Python or any library by hand.

1. Install uv:
   - Windows (PowerShell): `powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"`
   - macOS / Linux: `curl -LsSf https://astral.sh/uv/install.sh | sh`
2. Install [Docker Desktop](https://www.docker.com/products/docker-desktop/) and start it.
3. Clone the repo and set up:
   ```
   git clone https://github.com/JKing4965/dryerSensor.git
   cd dryerSensor
   cp .env.example .env          # Windows PowerShell: Copy-Item .env.example .env
   cd backend
   uv sync
   ```
   uv downloads Python 3.13 (from `backend/.python-version`) and the exact library
   versions in `backend/uv.lock` into `backend/.venv/`. In VS Code, pick
   `backend/.venv` as the Python interpreter.

## Running

**Database** (from the repo root):
```
docker compose up -d      # start
docker compose ps         # should show "healthy"
docker compose down       # stop, keeps data
docker compose down -v    # stop and DELETE all data (needed after changing backend/db/*.sql)
```

**Bluetooth debug tool** (from `backend/`):
```
uv run tools/ble_reader.py --scan
uv run tools/ble_reader.py --name XIAO-BLE --text
```

**Receiver** (from `backend/`, database running). Stores data in the database; stop with Ctrl+C:
```
uv run python -m dryer_backend.ingest --source sim --scenario normal --cycles 3
uv run python -m dryer_backend.ingest --source sim --scenario disconnect --speed 60
uv run python -m dryer_backend.ingest --source replay tests/fixtures/example_session.txt
uv run python -m dryer_backend.ingest --source ble      # real board; name from BLE_DEVICE_NAME in .env
uv run python -m dryer_backend.ingest --help
```
With `--source ble` the receiver keeps looking for the board and reconnects by itself if
the link drops (retrying after 2 s, then backing off to 30 s).

**Testing Bluetooth before the real firmware exists:** upload `arduino_code/BLEtest.ino`,
run `--source ble`, then paste protocol lines from `docs/protocol.md` (section 7) into the
Arduino Serial Monitor (line ending "Newline"). The receiver's replies (`T,...`, `A,...`)
appear in the Serial Monitor.
Simulator scenarios: `normal` (lint builds up), `vent` (exhaust clogs), `disconnect`
(cycle uploaded later from flash), `reboot` (board restarts, estimated times),
`sensor_error`. `--speed 0` (default) runs instantly and back-dates the data so it ends
now; `--speed 10` runs 10× real time starting now.

To see the lines a fake board sends, without the database:
```
uv run python -m dryer_backend.simulator --scenario normal --cycles 2
```

To wipe all stored data and start fresh: `docker compose down -v` then `docker compose up -d`.

**Tests** (from `backend/`):
```
uv run pytest
```
Database tests use a separate temporary `dryer_test` database and are skipped if
Docker isn't running.

`uv run` always uses the project environment, so there is no need to activate `.venv`.
The receiver, simulator and dashboard commands are added here as they are built.

The Bluetooth message format the firmware must follow is in [docs/protocol.md](docs/protocol.md).

## Adding or updating a Python library

Run these from `backend/`:
```
uv add <package>        # e.g. uv add numpy
uv add --dev <package>  # tools only needed for development, e.g. pytest
uv remove <package>
uv lock --upgrade       # bump everything to the newest allowed versions
```

Always commit **both** `backend/pyproject.toml` and `backend/uv.lock`. Teammates then run
`uv sync` in `backend/` after pulling. Never commit `.venv/` or `.env`.

## Git workflow

1. `git pull` on `main`, then `git switch -c <your-branch>`.
2. Commit your changes and `git push -u origin <your-branch>`.
3. Open a pull request into `main` on GitHub; a teammate reviews and merges.
4. After a merge, everyone runs `git pull`, then `uv sync` in `backend/`
   (and `npm install` in `frontend/` once it exists).

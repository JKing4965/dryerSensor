# Deployment Plan: Vercel + Timescale Cloud (receiver on the PC)

This plan moves the dashboard onto **Vercel** and the database onto **Timescale Cloud**. The
Bluetooth receiver keeps running on **your PC**. A later phase can move the receiver to a
Raspberry Pi; that phase only starts when you say so.

Like the earlier plans: each **🛑 CHECKPOINT** is a pause to check that everything works, and
each verified checkpoint is committed to `main`.

---

## 0. Target setup

```
[XIAO board] ─BLE─▶ [receiver on your PC] ─internet (TLS)─▶ [Timescale Cloud] ◀─TLS─ [dashboard on Vercel] ◀── phones / laptops
                     backend/, .env → cloud                   tables + views           frontend/ (Root Directory)
```

| Part | Where | Changes |
|---|---|---|
| Database | **Timescale Cloud** | Same `backend/db/*.sql`, loaded once |
| Dashboard | **Vercel** (project root = `frontend/`) | Login, Connect button hidden, small connection pool |
| Receiver | **Your PC** | Only `DATABASE_URL` in `.env` changes, plus an optional auto-start |
| Local Docker database | Your PC | Kept for development and the test suite, which uses `dryer_test` |

**Decisions already made:**
- **Option A:** the dashboard is the only Vercel project. There's no `vercel.json` services setup, because `backend/` has no web endpoints and can't run on Vercel.
- **Timescale Cloud,** so the SQL runs unchanged.
- **PC first.** The Pi comes later, on your go-ahead.

**What you do, not me:**
- **Accounts:** create the Timescale Cloud and Vercel accounts and the projects in them.
- **Secrets:** paste the database password and other secrets into `.env` files and Vercel's settings yourself. I never see or handle them.
- **Deploys:** you press Deploy, or approve it.

---

## 1. Design decisions

### 1.1 Connection strings and encryption
- Timescale Cloud gives an address like `postgres://tsdbadmin:<password>@<host>:<port>/tsdb?sslmode=require`.
- **The same address** goes into three places:
  - the repo-root `.env` (receiver)
  - `frontend/.env.local` (local dashboard, for testing against the cloud)
  - Vercel's environment variables
- `sslmode=require` keeps every connection encrypted. Both the Python driver (psycopg) and the Node driver (`pg`) honour it.
- **Firewall:** Vercel's servers don't have fixed IP addresses, so Timescale's IP allow-list can't be locked down to them. Rely on a strong password plus encryption.

### 1.2 Connect button only where it can work
- On Vercel the dashboard can't start programs on your PC, so `/api/receiver` and the Connect card must be **off** there.
- **Rule:** receiver control is on unless `RECEIVER_CONTROL=off`, and it's **automatically off on Vercel** (Vercel sets `VERCEL=1`).
- When off, the card becomes a plain status line ("The receiver runs on the computer by the dryer") alongside the existing connection badge, and `POST /api/receiver` returns 403.
- Running `npm run dev` on the PC keeps the button, so you can still start or stop the receiver locally.

### 1.3 Login
- A public URL needs one. The plan uses **one shared password**: a small login page sets a signed, HTTP-only cookie that lasts 30 days.
- **Two layers** (Next.js 16 advises against relying on the proxy alone):
  - `src/proxy.ts` sends anyone without a valid cookie to `/login` (Next 16's replacement for middleware)
  - every API route checks the cookie again
- **Settings:**
  - `DASHBOARD_PASSWORD`: the password
  - `AUTH_SECRET`: a long random string used to sign the cookie
- **If `DASHBOARD_PASSWORD` isn't set, login is turned off,** so local development and teammates' setups keep working unchanged. On Vercel it must be set.
- A **Log out** link goes in the header.

### 1.4 Database connections on Vercel
- Vercel runs many short-lived copies of the dashboard, each with its own connection pool.
- **Pool size:** 2 connections on Vercel, 5 locally. It can be overridden with `PG_POOL_MAX`.
- **Idle connections** are closed after 10 s, so idle copies don't hold connections open.
- **Region:** pick the Vercel functions region **closest to the Timescale region**. Every API call does several queries, so this matters more than where the users are.

### 1.5 Data
- **Existing local data isn't moved:** it's simulator and test data. The cloud database starts empty.
- Moving it later is possible with `pg_dump`/`pg_restore` if wanted.
- **Teammates:**
  - Their local setup keeps using Docker by default.
  - Only people who need the cloud database get its address, privately, never through git.
  - The Vercel project's settings hold the copy the deployed dashboard uses.

### 1.6 Cost (check current pricing before relying on these)
- **Timescale Cloud:** a free trial, then a paid plan.
- **Vercel Hobby:** free for personal, non-commercial projects. A student project fits.
- **Usage:** each open dashboard tab polls about every 2 s, which counts toward Vercel's free usage. Fine for a few users.

---

## PART D: STEPS

### D1. Timescale Cloud database
- **You:** create a Timescale Cloud account and a service in a region near you (for example a US East region). Copy the connection string.
- **Load the schema with the `psql` inside the local Docker container,** so nothing new needs installing. `backend/db/` is already mounted there. Run from the repo root, putting your connection string where it says `<cloud-url>`:
  - `docker compose exec -T db psql "<cloud-url>" -f /docker-entrypoint-initdb.d/schema.sql`
  - same for `seed.sql`, then `views.sql`
- I'll add these commands to the README. `CREATE EXTENSION IF NOT EXISTS timescaledb` is harmless on Timescale Cloud, where it already exists.

> **🛑 CHECKPOINT D1: cloud database ready**
> - `docker compose exec -T db psql "<cloud-url>" -c "\dt"` lists the 6 tables.
> - `-c "SELECT * FROM lint_status"` shows `dryer-1 | calibrating`.
> - `-c "SELECT hypertable_name FROM timescaledb_information.hypertables"` shows `readings`.

### D2. Code changes for the cloud
- **Receiver control** (1.2): `RECEIVER_CONTROL` / `VERCEL` detection in `lib/receiver.ts` and `/api/receiver`. `ReceiverControl` shows a status line when it's off.
- **Login** (1.3):
  - `src/proxy.ts`
  - `src/app/login/page.tsx` (form), `src/app/api/login/route.ts` and `api/logout/route.ts`
  - `src/lib/auth.ts`: signs the cookie with HMAC-SHA256 and compares passwords in constant time
  - every API route calls `requireAuth()`
- **Pool** (1.4) in `lib/db.ts`.
- **Settings:** `.env.local.example` lists `DASHBOARD_PASSWORD`, `AUTH_SECRET` and `PG_POOL_MAX`, with comments.
- **Tests:**
  - lint + production build
  - a small TypeScript test of the cookie signing, with the test runner chosen in this step
  - backend tests stay as they are, against local Docker

> **🛑 CHECKPOINT D2: works locally, pointed at the cloud**
> - In `frontend/.env.local`, set `DATABASE_URL` to the cloud address and set a test `DASHBOARD_PASSWORD` and `AUTH_SECRET`. Then `npm run dev`.
> - http://localhost:3000 redirects to **/login**. A wrong password is refused; the right one gets in. **Log out** works.
> - `curl http://localhost:3000/api/status` with no cookie → **401**.
> - Set the repo-root `.env` `DATABASE_URL` to the cloud address and press **Connect to sensor** (still allowed locally). Run a shaken test cycle; it appears on the dashboard **from the cloud database**.
> - With `RECEIVER_CONTROL=off`, the card shows the status line and `POST /api/receiver` → 403.
> - `npm run lint` and `npm run build` pass.

### D3. Vercel project
- **You,** on vercel.com:
  1. **New Project → Import** `JKing4965/dryerSensor`.
  2. Set **Root Directory = `frontend`**. Next.js is detected automatically.
  3. **Environment variables** (Production + Preview):
     - `DATABASE_URL` (cloud address)
     - `DEVICE_ID=dryer-1`
     - `DASHBOARD_PASSWORD`
     - `AUTH_SECRET` (a new random value, not the test one)
     - Leave `RECEIVER_CONTROL` unset; it's off on Vercel automatically.
  4. **Settings → Functions → Region:** the one closest to the Timescale region.
  5. **Deploy.**
- From then on, every push to `main` redeploys. Pushes to other branches get preview URLs.
- `NEXT_TELEMETRY_DISABLED=1` can be added too, to match the local setup.

> **🛑 CHECKPOINT D3: live on Vercel**
> - The `*.vercel.app` URL asks for the password, then shows the dashboard **on a phone** over mobile data.
> - Live shows the board's real state. With the receiver running on the PC: "Connected · dryer idle".
> - The Connect card shows the status line, not the button. `POST /api/receiver` on the Vercel URL → 403.
> - Cycles and Lint pages load. **Filter cleaned** works, and the banner updates.
> - Vercel's function logs show no database connection errors.
>
> ✅ **Verified 2026-11-16** (login, pages and Filter cleaned on the Vercel URL).
>
> **Found during D3:**
> - The Node database driver treats `sslmode=require` as full certificate verification, and Timescale's chain isn't trusted on Vercel. Fix: append `&uselibpqcompat=true` to the **dashboard's** `DATABASE_URL` (Vercel settings and `frontend/.env.local`), which keeps the connection encrypted, the same as the Python receiver. **Don't add it to the repo-root `.env`:** that option is only for the Node driver, and the Python receiver's standard PostgreSQL library already treats `require` as "encrypt, don't verify".
> - With the button hidden on Vercel there was no way to connect from the website, so step D3b was added.

### D3b. Remote Connect button (works from Vercel)
The dashboard can't start programs on the PC. Instead, the receiver runs on the PC in a
**standby mode** and takes orders through the database:

```
[Connect button, any device] ──desired = connected──▶ [receiver_control table] ◀── heartbeat every 3 s ──┐
                                                                    │ polled every 3 s                   │
                                                                    ▼                                    │
                                                    [standby receiver on the PC] ──BLE──▶ board ─────────┘
```

- **Database:** a new table, `receiver_control`, one row per device:
  - `desired`: `connected` or `disconnected`, written by the button
  - the receiver's heartbeat: `receiver_online_at`, `receiver_state` (`standby` / `searching` / `connected` / `offline`), and `receiver_host`, the computer's name

  It's in `schema.sql` and `seed.sql` for new databases, and in an **idempotent migration**, `backend/db/migrations/001_receiver_control.sql`, for existing ones. That migration is loaded into Timescale Cloud with the same `psql` command as D1, **with no data reset**.
- **Receiver:** a new entry point, `uv run python -m dryer_backend.remote`, which runs until stopped:
  - every 3 s it reads `desired` and writes its heartbeat, using the database's clock
  - `connected` → runs the normal Bluetooth receiver; `disconnected` → stops it cleanly, then waits in standby
  - if the receiver crashes, it restarts on the next check
  - the requested state is remembered in the database, so after a PC reboot it reconnects by itself if it was connected before
- **Dashboard** (local and Vercel are now the same):
  - **Connect** / **Disconnect** write `desired` through `/api/receiver`
  - the card shows "PC receiver offline" (no heartbeat for 15 s), "Ready on <PC name>", "Searching for the sensor…" or "Connected to the sensor"
  - pressing Connect while the PC is offline is allowed: it connects as soon as the receiver comes online
- **Local convenience:** where the dashboard may run programs (not on Vercel), Connect also **starts the standby receiver** if none is running, keeping the one-click flow from before. The old version, which started `ingest` directly, is replaced.
- **Tests:** standby mode against the test database, driven by the simulator: connect → data arrives and the state becomes `connected`; disconnect → `standby`; stop → `offline`.

> **🛑 CHECKPOINT D3b: connect from anywhere**
> - Load the migration into Timescale Cloud. `SELECT * FROM receiver_control` shows `dryer-1 | disconnected`.
> - On the PC, start `uv run python -m dryer_backend.remote`. Within about 5 s the Vercel card shows **"Ready on <your PC name>"**.
> - On your **phone** (Vercel URL), press **Connect**: "Searching…", then "Connected to the sensor", and the badge shows "Connected · dryer idle".
> - Press **Disconnect**: the board disconnects (its blue LED goes off) and the card shows "Ready".
> - Stop the standby receiver with Ctrl+C: within about 15 s the card shows "PC receiver offline".
> - Local `npm run dev` without a standby receiver running: Connect starts one and connects.
>
> ✅ **Verified 2026-11-16** from a phone on the Vercel URL, with the standby receiver on the PC.
>
> **Found during D3b:**
> - "PC receiver offline" on the phone while the receiver was running meant the repo-root `.env` still pointed at **local Docker**: the heartbeat went to the wrong database. The receiver (`.env`) and the dashboard (`frontend/.env.local` / Vercel) must use the **same** database.

### D4. Receiver on the PC, for everyday use
- `.env` `DATABASE_URL` → cloud (done in D2).
- **Two ways to run the standby receiver** (D3b), documented in the README:
  1. **Manual:** `uv run python -m dryer_backend.remote` in a terminal, or the local dashboard's Connect button.
  2. **Automatic at login:** `scripts/start-receiver.ps1`:
     - runs `python -m dryer_backend.remote` from `backend\.venv`, restarts it 10 s after a crash, and logs to `logs\receiver.log` (rotated at 5 MB, git-ignored)
     - exits straight away if a standby receiver is already running, so it never starts a second one
     - `-Install` registers a Task Scheduler task, **"DryerSensor Receiver"** (at your login, hidden window, no time limit, keeps running on battery), and starts it
     - `-Status` shows the task, the receiver process and the last log lines; `-Uninstall` removes both

     You run `-Install` yourself (it changes Windows settings):
     `powershell -ExecutionPolicy Bypass -File scripts\start-receiver.ps1 -Install`
- **Power:** set Windows to not sleep while plugged in, or accept that cycles recorded during sleep wait in the board's flash (up to 4) and upload when the PC wakes. Either:
  - **Settings → System → Power & battery → Screen, sleep & hibernate timeouts →** "Make my device sleep after" (plugged in): **Never**, or
  - in PowerShell: `powercfg /change standby-timeout-ac 0`

  Optional: in **Device Manager → Bluetooth → your adapter → Power Management**, untick "Allow the computer to turn off this device to save power".

> **🛑 CHECKPOINT D4: everyday use**
> - Reboot the PC and log in: the receiver starts by itself, and the Vercel dashboard shows "Connected" without you doing anything.
> - Run a real dryer cycle, or a shaken test cycle. It appears live on the Vercel URL on your phone and completes with lint numbers.
> - **Offline test:** stop the receiver, run a short cycle, start it again. The cycle uploads (dashed line) with the right times.
>
> ✅ **Verified 2026-11-16:** the login task starts the standby receiver, which shows Ready on the Vercel dashboard.
>
> **Found during D4:** `-Status` couldn't read the log while the receiver ran, because a pipeline `Add-Content` locks the file. The script now writes and reads the log in shared mode.

### D5. Documentation and hand-off
- **README:**
  - a "Deployment" overview at the top
  - a new section, "8. Deployment (Vercel + Timescale Cloud)": the architecture, a table of where each setting goes (receiver `.env` vs `frontend/.env.local` vs Vercel), setting up a new cloud database, the Vercel project settings, redeploying and logging everyone out, the PC receiver, switching between local and cloud, and 9 troubleshooting rows
- `frontend/README.md`: Vercel, the settings, login and proxy, the remote Connect button, `npm test`, and a note on `AGENTS.md`.
- This plan: D3, D3b and D4 marked verified.

> **🛑 CHECKPOINT D5: a teammate can use it**
> - A teammate opens the Vercel URL, logs in with the shared password, and sees live data.
> - A teammate's local setup (Docker, no password) still works exactly as before.

---

## PART E: RASPBERRY PI (only after you say go)

Summary only; details get planned when this starts:
- **OS:** Raspberry Pi OS Lite **64-bit** on a Pi 4, Pi 5 or Zero 2 W.
- **Install:** uv, then clone the repo and `uv sync` in `backend/`. Copy `.env` (cloud address).
- **Bluetooth check:** `uv run tools/ble_reader.py --scan` finds `XIAO-BLE` through Linux's Bluetooth stack (BlueZ).
- **Auto-start:** `deploy/dryer-receiver.service` (systemd: start at boot, restart on failure, logs in `journalctl`).
- **Hand-over:** stop the PC receiver's auto-start so only one receiver connects.
- **Checkpoint:** a cycle is recorded with the PC off, and the Pi recovers by itself after a reboot.

## Risks and notes
| Topic | Risk | Plan |
|---|---|---|
| Two receivers at once (local Connect + auto-start) | The board accepts one connection; the second keeps retrying | The Connect card already says "Connected by another receiver"; documented in the README |
| Secrets in git | The database password leaks | `.env` and `.env.local` are git-ignored; Vercel holds its own copy; never paste it into chat or commits |
| Shared password | Weak protection if reused or shared widely | Long random password; change it in Vercel settings, which logs everyone out on the next deploy if `AUTH_SECRET` is rotated too |
| Distance between Vercel and the database | Slow pages | Choose the same region in D1 and D3 |
| Timescale trial ends | The database is suspended | Check pricing before the trial ends; data can be exported with `pg_dump` |
| PC asleep or off | Late data | The board keeps up to 4 cycles in flash; upload resumes when the receiver returns |

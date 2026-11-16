# Dryer dashboard (Next.js)

The web dashboard for the dryer lint monitor: Live data, Cycle history and Lint status.
Built with Next.js 16 (App Router), TypeScript, Tailwind CSS and Recharts. It reads the
TimescaleDB database that the Python receiver in `../backend` fills. It runs locally with
`npm run dev`, and in production on **Vercel** (project Root Directory = `frontend`). See
"8. Deployment" in the repo-root README.

## Run it

Database first (from the repo root): `docker compose up -d`. Then, from `frontend/`:

```
cp .env.local.example .env.local      # once; Windows PowerShell: Copy-Item .env.local.example .env.local
npm install                           # once, and after every pull that changes package-lock.json
npm run dev                           # http://localhost:3000
```

Something to show: run the simulator from `../backend`:
`uv run python -m dryer_backend.ingest --source sim --scenario normal --cycles 3`

Checks before committing: `npm run lint`, `npm test` (login tests; needs Node 22.18+) and
`npm run build`.

## Settings (`.env.local` locally, Vercel's Environment Variables when deployed)

All are explained in `.env.local.example`:
- `DATABASE_URL`, `DEVICE_ID`: which database and board. Add `&uselibpqcompat=true` for Timescale Cloud.
- `DASHBOARD_PASSWORD`, `AUTH_SECRET`: login. Unset = no login, which is the local default.
- `RECEIVER_CONTROL`: whether this server may start the standby receiver. Unset = on locally, off on Vercel.
- `PG_POOL_MAX`: connections per server copy (default 5 locally, 2 on Vercel).

## Layout

| Path | What's there |
|---|---|
| `src/app/` | Pages (`page.tsx` = Live, `cycles/`, `lint/`, `login/`) and the shared `layout.tsx` |
| `src/app/api/` | JSON API routes, e.g. `/api/status`. The only code that touches the database. `/api/receiver` is the remote **Connect to sensor** button (`receiver_control` table); `/api/login` and `/api/logout` handle the password |
| `src/proxy.ts` | Login gate in front of every request (Next 16's name for middleware). Every API route checks the login again. |
| `src/lib/` | `db.ts` (connection pool), `queries.ts` (all SQL), `types.ts` (shared shapes), `auth.ts` / `authCore.ts` (login), `receiver.ts` (starts the standby receiver locally) |
| `src/components/` | Reusable React components |

`db.ts`, `queries.ts`, `auth.ts` and `receiver.ts` are server-only, so the database
password never reaches the browser.

`AGENTS.md` is written by `next dev` (Next.js 16's notes for AI coding tools) and can be ignored.

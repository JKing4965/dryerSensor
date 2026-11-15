# Dryer dashboard (Next.js)

The web dashboard for the dryer lint monitor: Live data, Cycle history and Lint status.
Built with Next.js 16 (App Router), TypeScript, Tailwind CSS and Recharts. It reads the
TimescaleDB database that the Python receiver in `../backend` fills.

## Run it

Database first (from the repo root): `docker compose up -d`. Then, from `frontend/`:

```
cp .env.local.example .env.local      # once; Windows PowerShell: Copy-Item .env.local.example .env.local
npm install                           # once, and after every pull that changes package-lock.json
npm run dev                           # http://localhost:3000
```

Something to show: run the simulator from `../backend`:
`uv run python -m dryer_backend.ingest --source sim --scenario normal --cycles 3`

Checks before committing: `npm run lint` and `npm run build`.

## Layout

| Path | What's there |
|---|---|
| `src/app/` | Pages (`page.tsx` = Live, `cycles/`, `lint/`) and the shared `layout.tsx` |
| `src/app/api/` | JSON API routes, e.g. `/api/status`. The only code that touches the database |
| `src/lib/` | `db.ts` (connection), `queries.ts` (all SQL), `types.ts` (shared shapes) |
| `src/components/` | Reusable React components |

`db.ts` and `queries.ts` are server-only, so the database password never reaches the browser.

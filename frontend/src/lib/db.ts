/**
 * db.ts - the dashboard's connection to the TimescaleDB database (server only).
 *
 * What it does:
 *   Creates one shared PostgreSQL connection pool from DATABASE_URL in
 *   frontend/.env.local, and exposes DEVICE_ID (which board's data to show).
 *   The `server-only` import makes the build fail if a browser component ever
 *   imports this file, so the database password can never reach the browser.
 *
 * Talks to:
 *   - The database started by docker-compose.yml (tables in backend/db/*.sql).
 *   - Used only by src/lib/queries.ts.
 */
import "server-only";

import { Pool } from "pg";

// During `npm run dev`, Next.js reloads modules on every edit. Keeping the pool on
// globalThis stops each reload from opening a new set of connections.
const globalForPg = globalThis as unknown as { dryerPool?: Pool };

function createPool(): Pool {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL is not set. Copy frontend/.env.local.example to frontend/.env.local and restart `npm run dev`.",
    );
  }
  return new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
}

export function getPool(): Pool {
  globalForPg.dryerPool ??= createPool();
  return globalForPg.dryerPool;
}

export const DEVICE_ID = process.env.DEVICE_ID ?? "dryer-1";

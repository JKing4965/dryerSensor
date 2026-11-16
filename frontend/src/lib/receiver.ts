/**
 * receiver.ts - starts the standby receiver from the LOCAL dashboard (server only).
 *
 * What it does:
 *   The Connect button works through the database (receiver_control, see
 *   src/app/api/receiver/route.ts): a standby receiver on the PC connects when asked.
 *   As a convenience, when the dashboard runs on the PC itself (not on Vercel) and no
 *   standby receiver is online, Connect also starts one as a child process:
 *       backend/.venv/(Scripts|bin)/python -m dryer_backend.remote --control-stdin
 *   - launch():         starts it (only one at a time), keeping its last 200 log lines
 *   - launcherStatus(): running or not, pid, times, exit code, recent log
 *   - canLaunch():      whether this server may start programs at all
 *   It keeps running until the Next.js server stops; its stdin then closes and it
 *   stops by itself (marking itself "offline"). Disconnect doesn't stop it - it just
 *   tells it to drop the Bluetooth link and wait.
 *   The process handle lives on globalThis so `npm run dev` reloads don't lose it.
 *
 * Talks to:
 *   - backend/src/dryer_backend/remote.py; it reads the repo-root .env.
 *   - Used by src/app/api/receiver/route.ts.
 *
 * Settings (optional, frontend/.env.local):
 *   RECEIVER_CONTROL on / off. Unset = on locally, off on Vercel (see canLaunch()).
 *   BACKEND_DIR      path to backend/ (default: ../backend next to frontend/)
 *   RECEIVER_PYTHON  Python to use (default: the backend's .venv Python)
 */
import "server-only";

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import type { LauncherStatus } from "./types";

const MAX_LOG_LINES = 200;

interface LauncherState {
  proc: ChildProcessWithoutNullStreams | null;
  startedAt: string | null;
  exitedAt: string | null;
  exitCode: number | null;
  log: string[];
  partial: string;
}

const g = globalThis as unknown as { dryerLauncher?: LauncherState };
const state: LauncherState = (g.dryerLauncher ??= {
  proc: null,
  startedAt: null,
  exitedAt: null,
  exitCode: null,
  log: [],
  partial: "",
});

// The receiver lives outside this app and is only launched locally, never bundled.
// The `turbopackIgnore` comments stop the build from pulling the whole project into the
// deployed server code (Turbopack can't tell these paths apart from data files).
function backendDir(): string {
  return path.resolve(/*turbopackIgnore: true*/ process.env.BACKEND_DIR ?? path.join(process.cwd(), "..", "backend"));
}

function pythonPath(): string {
  if (process.env.RECEIVER_PYTHON) return process.env.RECEIVER_PYTHON;
  const venv = path.join(backendDir(), ".venv");
  return process.platform === "win32" ? path.join(venv, "Scripts", "python.exe") : path.join(venv, "bin", "python");
}

function addOutput(chunk: Buffer): void {
  const text = state.partial + chunk.toString("utf8").replace(/\x1b\[[0-9;]*m/g, "");
  const lines = text.split(/\r?\n/);
  state.partial = lines.pop() ?? "";
  for (const line of lines) if (line.trim()) state.log.push(line);
  if (state.log.length > MAX_LOG_LINES) state.log.splice(0, state.log.length - MAX_LOG_LINES);
}

function note(text: string): void {
  state.log.push(`[dashboard] ${text}`);
}

/**
 * Whether this server may start the standby receiver. RECEIVER_CONTROL=on/off decides;
 * if unset it's ON locally and OFF on Vercel (which sets VERCEL=1), because a cloud
 * server can't run a Bluetooth program on your PC.
 */
export function canLaunch(): boolean {
  const v = (process.env.RECEIVER_CONTROL ?? "").trim().toLowerCase();
  if (["off", "false", "0", "no"].includes(v)) return false;
  if (["on", "true", "1", "yes"].includes(v)) return true;
  return process.env.VERCEL !== "1";
}

export function isLaunched(): boolean {
  return state.proc !== null && state.proc.exitCode === null && state.proc.signalCode === null;
}

export function launcherStatus(): LauncherStatus {
  return {
    running: isLaunched(),
    pid: isLaunched() ? (state.proc?.pid ?? null) : null,
    startedAt: state.startedAt,
    exitedAt: state.exitedAt,
    exitCode: state.exitCode,
    log: state.log.slice(-60),
  };
}

/** Starts the standby receiver if it isn't already running here. Throws a readable Error. */
export function launch(): void {
  if (!canLaunch()) throw new Error("This server can't start programs (receiver control is off)");
  if (isLaunched()) return;
  const py = pythonPath();
  if (!existsSync(/*turbopackIgnore: true*/ py)) {
    throw new Error(`Python not found at ${py}. Run "uv sync" in backend/ first.`);
  }
  state.log = [];
  state.partial = "";
  state.exitCode = null;
  state.exitedAt = null;
  note(`starting the standby receiver: ${path.basename(py)} -m dryer_backend.remote`);
  const proc = spawn(/*turbopackIgnore: true*/ py, ["-m", "dryer_backend.remote", "--control-stdin"], {
    cwd: backendDir(),
    env: { ...process.env, PYTHONUNBUFFERED: "1" },
    windowsHide: true,
  });
  state.proc = proc;
  state.startedAt = new Date().toISOString();
  proc.stdout.on("data", addOutput);
  proc.stderr.on("data", addOutput);
  proc.on("error", (e) => note(`could not start: ${e.message}`));
  proc.on("exit", (code, signal) => {
    if (state.proc !== proc) return;
    state.exitCode = code;
    state.exitedAt = new Date().toISOString();
    note(signal ? `receiver stopped (${signal})` : `receiver exited with code ${code}`);
  });
}

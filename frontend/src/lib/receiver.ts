/**
 * receiver.ts - starts and stops the Python Bluetooth receiver for the dashboard (server only).
 *
 * What it does:
 *   The dashboard's Connect button runs the receiver as a child process of the Next.js
 *   server, from the backend's own Python environment:
 *       backend/.venv/(Scripts|bin)/python -m dryer_backend.ingest --source ble --control-stdin
 *   - start(): launches it (only one at a time) and keeps its last 200 log lines
 *   - stop():  writes "quit" to its stdin, so it saves buffered data and marks the board
 *              disconnected; if it hasn't exited after 10 s it is killed
 *   - status(): running or not, pid, start time, exit code, recent log
 *   If the Next.js server stops, the receiver's stdin closes and it stops by itself.
 *   The process handle lives on globalThis so `npm run dev` reloads don't lose it.
 *
 * Talks to:
 *   - backend/src/dryer_backend/ingest.py (the receiver); it reads the repo-root .env.
 *   - Used by src/app/api/receiver/route.ts.
 *
 * Settings (optional, frontend/.env.local):
 *   BACKEND_DIR      path to backend/ (default: ../backend next to frontend/)
 *   RECEIVER_PYTHON  Python to use (default: the backend's .venv Python)
 */
import "server-only";

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import type { ReceiverStatus } from "./types";

const MAX_LOG_LINES = 200;
const STOP_TIMEOUT_MS = 10_000;

interface ReceiverState {
  proc: ChildProcessWithoutNullStreams | null;
  startedAt: string | null;
  exitedAt: string | null;
  exitCode: number | null;
  log: string[];
  partial: string;
}

const g = globalThis as unknown as { dryerReceiver?: ReceiverState };
const state: ReceiverState = (g.dryerReceiver ??= {
  proc: null,
  startedAt: null,
  exitedAt: null,
  exitCode: null,
  log: [],
  partial: "",
});

function backendDir(): string {
  return path.resolve(process.env.BACKEND_DIR ?? path.join(process.cwd(), "..", "backend"));
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

export function isRunning(): boolean {
  return state.proc !== null && state.proc.exitCode === null && state.proc.signalCode === null;
}

export function status(): ReceiverStatus {
  return {
    running: isRunning(),
    pid: isRunning() ? (state.proc?.pid ?? null) : null,
    startedAt: state.startedAt,
    exitedAt: state.exitedAt,
    exitCode: state.exitCode,
    log: state.log.slice(-60),
  };
}

/** Starts the Bluetooth receiver. Throws a readable Error if it can't. */
export function start(): ReceiverStatus {
  if (isRunning()) return status();
  const py = pythonPath();
  if (!existsSync(py)) {
    throw new Error(`Python not found at ${py}. Run "uv sync" in backend/ first.`);
  }
  state.log = [];
  state.partial = "";
  state.exitCode = null;
  state.exitedAt = null;
  note(`starting receiver: ${path.basename(py)} -m dryer_backend.ingest --source ble`);
  const proc = spawn(py, ["-m", "dryer_backend.ingest", "--source", "ble", "--control-stdin"], {
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
  return status();
}

/** Asks the receiver to stop cleanly; kills it if it hasn't exited after 10 s. */
export async function stop(): Promise<ReceiverStatus> {
  const proc = state.proc;
  if (!proc || !isRunning()) return status();
  note("stop requested");
  proc.stdin.write("quit\n");
  const exited = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), STOP_TIMEOUT_MS);
    proc.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
  if (!exited) {
    note("receiver didn't stop in time; killing it");
    if (process.platform === "win32" && proc.pid) {
      spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { windowsHide: true });
    } else {
      proc.kill("SIGKILL");
    }
  }
  return status();
}

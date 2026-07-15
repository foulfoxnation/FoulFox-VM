// FoulFox App runtime: runs each installed app's `start` command as a
// supervised child process, per the runtime contract in docs/foulfox-app-spec.md.
//
// Guarantees provided here:
//   - Contract env injection: <portEnv>=allocated loopback port,
//     <dataEnv>=persistent data dir, FOULFOX_APP_ID, FOULFOX_APP_TOKEN (fresh
//     per boot, backend-only broker credential), FOULFOX_API_BASE, and
//     OLLAMA_BASE_URL so voice/AI apps can reach the local model.
//   - /healthz polling: an app is "running" once its healthPath returns 200.
//   - Crash restarts with exponential backoff (voice must not die silently).
//   - Lower OOM-kill priority (best effort) so heavy TTS/STT sidecars aren't
//     the kernel's first victims.
//   - Autostart: apps with `autostart: true` are launched at API-server boot.
//
// SECURITY: the start command is an argv array spawned WITHOUT a shell, cwd
// confined to the app's repo dir. The broker token never goes to the browser;
// it exists only in the app process env and in this module's memory.

import { spawn, type ChildProcess } from "child_process";
import crypto from "crypto";
import fs from "fs";
import http from "http";
import net from "net";
import path from "path";
import { logger } from "./logger";
import { listApps, getApp, appRepoDir, appDataDir, appDir } from "./app-registry";
import type { AppRecord } from "./app-registry";

export type RunPhase = "stopped" | "starting" | "running" | "crashed";

interface RunState {
  appId: string;
  phase: RunPhase;
  desired: "run" | "stop";
  proc: ChildProcess | null;
  pid: number | null;
  port: number | null;
  token: string | null;
  startedAt: number | null;
  healthyAt: number | null;
  restarts: number;
  lastExit: string | null;
  log: string[]; // ring buffer of recent stdout/stderr lines
  healthTimer: NodeJS.Timeout | null;
  restartTimer: NodeJS.Timeout | null;
}

const LOG_MAX_LINES = 500;
const HEALTH_INTERVAL_MS = 2000;
// Voice apps may compile/load models on first boot; be generous before we call
// a start attempt failed. The process staying alive keeps us in "starting".
const HEALTH_TIMEOUT_MS = 10 * 60 * 1000;
const STOP_GRACE_MS = 8000;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 30_000;
// If the app stays healthy this long, the backoff counter resets.
const BACKOFF_RESET_MS = 60_000;

const runs = new Map<string, RunState>();

function getOrCreate(appId: string): RunState {
  let s = runs.get(appId);
  if (!s) {
    s = {
      appId,
      phase: "stopped",
      desired: "stop",
      proc: null,
      pid: null,
      port: null,
      token: null,
      startedAt: null,
      healthyAt: null,
      restarts: 0,
      lastExit: null,
      log: [],
      healthTimer: null,
      restartTimer: null,
    };
    runs.set(appId, s);
  }
  return s;
}

function pushLog(s: RunState, line: string): void {
  s.log.push(line);
  if (s.log.length > LOG_MAX_LINES) s.log.splice(0, s.log.length - LOG_MAX_LINES);
}

// Allocate a free loopback port by letting the kernel pick one.
function allocPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error("no port"))));
    });
  });
}

// Best-effort: make the kernel prefer OTHER processes when memory runs out.
// Voice engines dying silently under memory pressure is the failure mode the
// VoiceForge team called out. Requires no privileges for values >= current.
function adjustOomScore(pid: number): void {
  try {
    fs.writeFileSync(`/proc/${pid}/oom_score_adj`, "-300");
  } catch {
    try {
      // Unprivileged fallback: at least don't make it MORE killable than default.
      fs.writeFileSync(`/proc/${pid}/oom_score_adj`, "0");
    } catch {
      /* ignore — not fatal */
    }
  }
}

function contractEnv(a: AppRecord, port: number, token: string): NodeJS.ProcessEnv {
  const apiPort = process.env["PORT"] || "8080";
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    [a.manifest.portEnv]: String(port),
    [a.manifest.dataEnv]: appDataDir(a.id),
    FOULFOX_APP_ID: a.id,
    FOULFOX_APP_TOKEN: token,
    FOULFOX_API_BASE: `http://127.0.0.1:${apiPort}`,
    OLLAMA_BASE_URL: process.env["OLLAMA_BASE_URL"] || "http://127.0.0.1:11434",
    HOME: appDataDir(a.id), // keep stray dotfile writes inside the data dir
  };
  // Never leak the OS-internal bridge credential into app processes.
  delete env["ODYSSEUS_INTERNAL_TOKEN"];
  return env;
}

function checkHealth(s: RunState, healthPath: string): void {
  if (!s.port) return;
  const req = http.get(
    { hostname: "127.0.0.1", port: s.port, path: healthPath, timeout: 1500 },
    (res) => {
      res.resume();
      if (res.statusCode === 200) {
        if (s.phase === "starting") {
          s.phase = "running";
          s.healthyAt = Date.now();
          pushLog(s, `[foulfox] healthy on 127.0.0.1:${s.port}`);
          logger.info({ appId: s.appId, port: s.port }, "app healthy");
        }
      } else if (s.phase === "starting") {
        enforceStartupBudget(s, `health check ${healthPath} → ${res.statusCode}`);
      }
    },
  );
  req.on("timeout", () => req.destroy());
  req.on("error", () => {
    if (s.phase === "starting") enforceStartupBudget(s, "health check unreachable");
  });
}

// Enforce the startup budget for real: a process that never turns healthy is
// killed (the exit handler then schedules a backoff restart) instead of
// sitting in "starting" forever.
function enforceStartupBudget(s: RunState, detail: string): void {
  if (!timedOut(s)) return;
  pushLog(s, `[foulfox] never became healthy within the startup budget (${detail}); killing`);
  logger.warn({ appId: s.appId, detail }, "app health timeout; killing process");
  s.startedAt = Date.now(); // reset so the next attempt gets a fresh budget
  try {
    s.proc?.kill("SIGKILL");
  } catch {
    /* already gone */
  }
}

function timedOut(s: RunState): boolean {
  return !!s.startedAt && Date.now() - s.startedAt > HEALTH_TIMEOUT_MS;
}

function clearTimers(s: RunState): void {
  if (s.healthTimer) clearInterval(s.healthTimer);
  if (s.restartTimer) clearTimeout(s.restartTimer);
  s.healthTimer = null;
  s.restartTimer = null;
}

async function launch(a: AppRecord, s: RunState): Promise<void> {
  const repo = appRepoDir(a.id);
  if (!fs.existsSync(repo)) throw new Error("App repo directory is missing; reinstall the app.");
  fs.mkdirSync(appDataDir(a.id), { recursive: true });

  const port = await allocPort();
  const token = crypto.randomBytes(32).toString("hex");
  const argv = a.manifest.start;

  s.phase = "starting";
  s.port = port;
  s.token = token;
  s.startedAt = Date.now();
  s.healthyAt = null;
  s.lastExit = null;
  pushLog(s, `[foulfox] starting: ${argv.join(" ")} (port ${port})`);

  const proc = spawn(argv[0], argv.slice(1), {
    cwd: repo,
    env: contractEnv(a, port, token),
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });
  s.proc = proc;
  s.pid = proc.pid ?? null;
  if (proc.pid) adjustOomScore(proc.pid);

  const onLine = (buf: Buffer) => {
    for (const line of buf.toString("utf8").split(/\r?\n/)) {
      if (line.trim()) pushLog(s, line);
    }
  };
  proc.stdout?.on("data", onLine);
  proc.stderr?.on("data", onLine);

  proc.on("error", (err) => {
    pushLog(s, `[foulfox] spawn error: ${err.message}`);
  });

  proc.on("exit", (code, signal) => {
    const wasHealthyFor = s.healthyAt ? Date.now() - s.healthyAt : 0;
    s.lastExit = signal ? `signal ${signal}` : `exit code ${code}`;
    s.proc = null;
    s.pid = null;
    s.token = null;
    clearTimers(s);
    if (s.desired === "stop") {
      s.phase = "stopped";
      pushLog(s, `[foulfox] stopped (${s.lastExit})`);
      return;
    }
    // Unexpected death → crashed; schedule a restart with backoff.
    s.phase = "crashed";
    if (wasHealthyFor > BACKOFF_RESET_MS) s.restarts = 0;
    const delay = Math.min(BACKOFF_BASE_MS * 2 ** s.restarts, BACKOFF_MAX_MS);
    s.restarts += 1;
    pushLog(s, `[foulfox] crashed (${s.lastExit}); restarting in ${Math.round(delay / 1000)}s`);
    logger.warn({ appId: s.appId, exit: s.lastExit, delay }, "app crashed; scheduling restart");
    s.restartTimer = setTimeout(() => {
      if (s.desired !== "run") return;
      const rec = getApp(s.appId);
      if (!rec || rec.status !== "installed") return;
      launch(rec, s).catch((err) => {
        s.phase = "crashed";
        pushLog(s, `[foulfox] restart failed: ${err instanceof Error ? err.message : err}`);
      });
    }, delay);
  });

  s.healthTimer = setInterval(() => checkHealth(s, a.manifest.healthPath), HEALTH_INTERVAL_MS);
}

// In-flight start dedupe: without this, two concurrent startApp() calls can
// both pass the phase check before launch() flips it and spawn two processes.
const startsInFlight = new Map<string, Promise<RunState>>();

export function startApp(appId: string): Promise<RunState> {
  const existing = startsInFlight.get(appId);
  if (existing) return existing;
  const p = (async () => {
    const a = getApp(appId);
    if (!a) throw new Error("No such app.");
    if (a.status !== "installed") throw new Error(`App is not installed (status: ${a.status}).`);
    const s = getOrCreate(appId);
    if (s.phase === "starting" || s.phase === "running") return s;
    clearTimers(s);
    s.desired = "run";
    s.restarts = 0;
    await launch(a, s);
    return s;
  })().finally(() => startsInFlight.delete(appId));
  startsInFlight.set(appId, p);
  return p;
}

export function stopApp(appId: string): RunState {
  const s = getOrCreate(appId);
  s.desired = "stop";
  clearTimers(s);
  const proc = s.proc;
  if (!proc || !s.pid) {
    s.phase = "stopped";
    return s;
  }
  pushLog(s, "[foulfox] stop requested");
  try {
    proc.kill("SIGTERM");
  } catch {
    /* already gone */
  }
  const pid = s.pid;
  setTimeout(() => {
    if (s.proc && s.pid === pid) {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }
  }, STOP_GRACE_MS);
  return s;
}

export interface RunSummary {
  appId: string;
  phase: RunPhase;
  pid: number | null;
  port: number | null; // loopback-only; the UI reaches it via the proxy
  startedAt: number | null;
  healthyAt: number | null;
  restarts: number;
  lastExit: string | null;
}

export function runSummary(appId: string): RunSummary {
  const s = runs.get(appId);
  if (!s) {
    return {
      appId,
      phase: "stopped",
      pid: null,
      port: null,
      startedAt: null,
      healthyAt: null,
      restarts: 0,
      lastExit: null,
    };
  }
  return {
    appId: s.appId,
    phase: s.phase,
    pid: s.pid,
    port: s.port,
    startedAt: s.startedAt,
    healthyAt: s.healthyAt,
    restarts: s.restarts,
    lastExit: s.lastExit,
  };
}

export function runLog(appId: string): string {
  return runs.get(appId)?.log.join("\n") ?? "";
}

// Loopback port of a running (or starting) app — used by the UI proxy.
export function runningPort(appId: string): number | null {
  const s = runs.get(appId);
  if (!s || (s.phase !== "running" && s.phase !== "starting")) return null;
  return s.port;
}

// Broker auth: resolve a bearer token to the app that holds it. Constant-time
// comparison; tokens are per-boot random 256-bit values.
export function appIdForToken(token: string): string | null {
  if (!token) return null;
  const buf = Buffer.from(token);
  for (const s of runs.values()) {
    if (!s.token || (s.phase !== "running" && s.phase !== "starting")) continue;
    const cur = Buffer.from(s.token);
    if (cur.length === buf.length && crypto.timingSafeEqual(cur, buf)) return s.appId;
  }
  return null;
}

// Launch every installed app with autostart:true. Called once at server boot.
export function autostartApps(): void {
  for (const a of listApps()) {
    if (a.status === "installed" && a.manifest.autostart) {
      logger.info({ appId: a.id }, "autostarting app");
      startApp(a.id).catch((err) =>
        logger.error({ err, appId: a.id }, "autostart failed"),
      );
    }
  }
}

// Stop a run and forget its state (used by uninstall).
export function forgetApp(appId: string): void {
  const s = runs.get(appId);
  if (s) {
    stopApp(appId);
    runs.delete(appId);
  }
  // Nothing else: uninstall removes appDir(id) itself.
  void appDir;
}

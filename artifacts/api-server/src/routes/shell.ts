import { Router, type IRouter, type Request, type Response } from "express";
import { type IncomingMessage } from "http";
import { WebSocketServer, type WebSocket } from "ws";
import * as pty from "node-pty";
import { spawn } from "child_process";
import { URL } from "url";
import { ExecShellCommandBody, ExecShellCommandResponse } from "@workspace/api-zod";
import { getVm, getRuntime, listVms, vmDiskDir } from "../lib/vm-registry";
import { buildSshArgs, runSshCommand } from "../lib/vm-ssh";
import { logger } from "../lib/logger";
import { SHELL_SESSION_TOKEN } from "../lib/shell-token";
import path from "path";
import { existsSync } from "fs";

const router: IRouter = Router();

// ── Shell environment ─────────────────────────────────────────────────────────
// Put the app bundle's bin/ directory (foulfox-diag etc.) on the PATH of every
// local shell so diagnostics commands work in the >_Shell tab. dist/ lives at
// <app-root>/artifacts/api-server/dist, so app root is three levels up.
const APP_BIN = path.resolve(__dirname, "..", "..", "..", "bin");
function shellEnv(): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;
  if (existsSync(APP_BIN)) {
    env.PATH = `${APP_BIN}:${env.PATH ?? ""}`;
  }
  return env;
}

// ── Shell command history (in-memory, last 200 entries) ───────────────────────
const shellHistory: Array<{
  id: number;
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timestamp: string;
}> = [];
let historyIdCounter = 0;

// ── Target resolution (host vs a specific VM) ─────────────────────────────────
// A terminal/exec request is scoped to a target:
//   • no `vm` param  → the host shell (the machine running QEMU)
//   • vm=<id>        → that VM, reached over SSH (or serial) when it is running
// VMs cannot reach a "running" state without hardware virtualization, so on this
// host every VM target resolves to "vm-down" and fails honestly; the same code
// connects for real on a KVM/Hyper-V/HVF host.
type SessionKind = "local" | "vm-ssh" | "vm-serial" | "vm-down";

interface ResolvedTarget {
  key: string; // stable session-map key for this target
  kind: SessionKind;
  label: string;
  sshPort?: number;
  sshUser?: string | null;
  sshKeyPath?: string | null;
}

// Resolve the live target for a request. Reads the registry + runtime on every
// call so a VM that starts/stops between messages is picked up automatically.
// The `key` is independent of state so the session map entry is stable.
function resolveTarget(vmId: string | undefined): ResolvedTarget {
  if (!vmId) {
    return { key: "host", kind: "local", label: "host" };
  }
  const vm = getVm(vmId);
  if (!vm) {
    return { key: `vm:${vmId}`, kind: "vm-down", label: vmId };
  }
  const runtime = getRuntime(vmId);
  if (runtime.state !== "running") {
    return { key: `vm:${vmId}`, kind: "vm-down", label: vm.name };
  }
  if (vm.config.connectionMode === "serial") {
    return { key: `vm:${vmId}`, kind: "vm-serial", label: vm.name };
  }
  return {
    key: `vm:${vmId}`,
    kind: "vm-ssh",
    label: vm.name,
    sshPort: vm.config.sshPort,
    sshUser: vm.config.sshUser,
    sshKeyPath: vm.config.sshKeyPath,
  };
}

function buildPtyCommand(t: ResolvedTarget): { cmd: string; args: string[] } | null {
  if (t.kind === "vm-ssh") {
    // Interactive terminal: authenticate with the per-VM key. BatchMode is left
    // off so a human can still type a password as a fallback if the key fails.
    return {
      cmd: "ssh",
      args: buildSshArgs({ sshPort: t.sshPort!, sshUser: t.sshUser ?? null, sshKeyPath: t.sshKeyPath ?? null }),
    };
  }
  if (t.kind === "vm-serial") {
    // Legacy serial console (single-VM) was exposed via telnet on 4444. Per-VM
    // serial ports are not separately allocated (all provisioned VMs use SSH),
    // so this only connects for the legacy default VM and fails honestly elsewhere.
    return { cmd: "telnet", args: ["localhost", "4444"] };
  }
  if (t.kind === "local") {
    const shell = process.platform === "win32" ? "powershell.exe" : (process.env.SHELL || "/bin/bash");
    return { cmd: shell, args: [] };
  }
  // vm-down: nothing to connect to.
  return null;
}

// ── PTY sessions, keyed by target ─────────────────────────────────────────────
// Each target (host, or a specific VM) gets its own PTY and its own client set,
// so the Host Shell tab and per-VM terminals are fully isolated.
interface Session {
  pty: ReturnType<typeof pty.spawn> | null;
  kind: SessionKind;
  clients: Set<WebSocket>;
}

const sessions = new Map<string, Session>();

function getSession(key: string): Session {
  let s = sessions.get(key);
  if (!s) {
    s = { pty: null, kind: "local", clients: new Set() };
    sessions.set(key, s);
  }
  return s;
}

// Ensure the session's PTY matches the resolved target. Re-spawns if the target
// kind changed (e.g. the VM transitioned stopped → running between messages).
function ensurePty(t: ResolvedTarget): Session {
  const s = getSession(t.key);

  if (s.pty && s.kind !== t.kind) {
    try { s.pty.kill(); } catch { /* ignore */ }
    s.pty = null;
    for (const client of s.clients) {
      if (client.readyState === client.OPEN) {
        const msg = t.kind === "vm-down"
          ? `\r\n\x1b[33m${t.label} stopped\x1b[0m\r\n`
          : t.kind === "local"
          ? "\r\n\x1b[33mSwitched to local host shell\x1b[0m\r\n"
          : `\r\n\x1b[32m${t.label} running — opening ${t.kind === "vm-ssh" ? "SSH" : "serial"} session\x1b[0m\r\n`;
        client.send(JSON.stringify({ type: "data", data: msg }));
      }
    }
  }

  if (s.pty) return s;

  s.kind = t.kind;
  const spec = buildPtyCommand(t);
  if (!spec) return s; // vm-down: no process spawned

  logger.info({ key: t.key, kind: t.kind, cmd: spec.cmd }, "Spawning PTY session");

  const p = pty.spawn(spec.cmd, spec.args, {
    name: "xterm-color",
    cols: 80,
    rows: 24,
    cwd: process.env.HOME || process.cwd(),
    env: shellEnv(),
  });
  s.pty = p;

  p.onData((data: string) => {
    for (const client of s.clients) {
      if (client.readyState === client.OPEN) {
        client.send(JSON.stringify({ type: "data", data }));
      }
    }
  });

  p.onExit(({ exitCode }: { exitCode: number }) => {
    logger.info({ key: t.key, exitCode, kind: s.kind }, "PTY session exited");
    s.pty = null;
    for (const client of s.clients) {
      if (client.readyState === client.OPEN) {
        client.send(JSON.stringify({ type: "exit", exitCode }));
      }
    }
  });

  return s;
}

// ── REST: Execute shell command (Odysseus agent tool — localhost only) ────────
router.post("/shell/exec", (req: Request, res: Response) => {
  const parsed = ExecShellCommandBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { command, timeoutMs = 10000, vm } = parsed.data;
  const target = resolveTarget(vm || undefined);

  const respond = (stdout: string, stderr: string, exitCode: number | null, timedOut: boolean) => {
    const out = ExecShellCommandResponse.parse({ stdout, stderr, exitCode, timedOut });
    // Include snake_case aliases alongside camelCase so Odysseus tool_implementations.py
    // (which checks `exit_code` / `timed_out`) and TypeScript clients (camelCase) both work.
    res.json({ ...out, exit_code: out.exitCode, timed_out: out.timedOut });
  };

  let spawnCmd: string;
  let spawnArgs: string[];

  if (target.kind === "vm-ssh") {
    spawnCmd = "ssh";
    // One-shot exec: key auth + BatchMode so a missing/rejected key fails fast
    // instead of blocking on a password prompt with no TTY.
    spawnArgs = [
      ...buildSshArgs(
        { sshPort: target.sshPort!, sshUser: target.sshUser ?? null, sshKeyPath: target.sshKeyPath ?? null },
        { batch: true },
      ),
      command,
    ];
  } else if (target.kind === "vm-serial") {
    respond("", `Cannot exec on '${target.label}': serial console does not support one-shot commands (use SSH mode).`, -1, false);
    return;
  } else if (target.kind === "vm-down") {
    respond("", `Cannot exec on '${target.label}': VM is not running.`, -1, false);
    return;
  } else {
    spawnCmd = process.platform === "win32" ? "powershell.exe" : "/bin/bash";
    spawnArgs = process.platform === "win32" ? ["-Command", command] : ["-c", command];
  }

  let stdout = "";
  let stderr = "";
  let timedOut = false;

  const child = spawn(spawnCmd, spawnArgs, {
    cwd: process.env.HOME || process.cwd(),
    env: shellEnv(),
  });

  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, timeoutMs);

  child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
  child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });

  child.on("close", (exitCode: number | null) => {
    clearTimeout(timer);

    shellHistory.unshift({
      id: ++historyIdCounter,
      command,
      stdout,
      stderr,
      exitCode,
      timestamp: new Date().toISOString(),
    });
    if (shellHistory.length > 200) shellHistory.pop();

    respond(stdout, stderr, exitCode, timedOut);
  });

  child.on("error", (err) => {
    clearTimeout(timer);
    respond("", err.message, -1, false);
  });
});

// REST: Shell history
router.get("/shell/history", (_req: Request, res: Response) => {
  res.json(shellHistory.slice(0, 50));
});

// ── SSE: Live log stream ──────────────────────────────────────────────────────
// Whole-system log viewer. Sources:
//   system            host/FoulFox OS journal (default; all services)
//   unit:<name>       a single systemd unit's journal (foulfox-api, ollama…)
//   odysseus          the Odysseus service log file
//   vm:<id>:qemu      QEMU output for a VM (persisted to <vm dir>/qemu.log)
//   vm:<id>:windows   Windows guest System+Application event logs over SSH
// Accepts both the shell session token and view-only session tokens so the
// session portal can connect with either.

function logStreamAuthed(req: Request): boolean {
  const { isValidViewToken } = require("../lib/view-tokens");
  const provided = (req.headers["x-shell-token"] ?? req.query["token"]) as string | undefined;
  return provided === SHELL_SESSION_TOKEN || isValidViewToken(provided);
}

const UNIT_NAME_RE = /^[A-Za-z0-9@:._-]{1,128}$/;
// Units worth offering even when systemctl can't be queried (dev container).
// Must match the unit files shipped in os/live-build includes.chroot.
const KNOWN_UNITS = [
  "foulfox-api.service",
  "foulfox-prepare.service",
  "foulfox-kiosk.service",
  "foulfox-vm-autostart.service",
  "foulfox-update-check.service",
  "foulfox-seed-ollama.service",
  "foulfox-gpu-fallback.service",
  "odysseus-service.service",
  "ollama.service",
];

// REST: list the log sources this machine can stream right now.
router.get("/shell/logs/sources", (req: Request, res: Response) => {
  if (!logStreamAuthed(req)) {
    res.status(401).json({ error: "Missing or invalid session token" });
    return;
  }
  const sources: Array<{ id: string; label: string; group: string }> = [
    { id: "system", label: "System journal (all services)", group: "FoulFox OS" },
  ];

  const finish = () => {
    sources.push({ id: "odysseus", label: "Odysseus service log", group: "FoulFox OS" });
    // Installed apps (Voice Forge etc.) run under the app runner, so their
    // output is NOT in the journal — expose each app's run log directly.
    try {
      const { listApps } = require("../lib/app-registry");
      for (const app of listApps()) {
        sources.push({ id: `app:${app.id}`, label: `${app.name ?? app.id} (app)`, group: "Apps" });
      }
    } catch { /* app registry unavailable */ }
    for (const vm of listVms()) {
      sources.push({ id: `vm:${vm.id}:qemu`, label: `${vm.name} — QEMU / console`, group: "Virtual machines" });
      if ((vm.osKind ?? "").toLowerCase().includes("win")) {
        sources.push({ id: `vm:${vm.id}:windows`, label: `${vm.name} — Windows event log`, group: "Virtual machines" });
      }
    }
    res.json({ sources });
  };

  // Discover live foulfox/ollama units; fall back to the static list.
  const child = spawn("systemctl", ["list-units", "--all", "--no-legend", "--plain", "foulfox-*.service", "ollama*.service"], { stdio: ["ignore", "pipe", "ignore"] });
  let out = "";
  let settled = false;
  const settle = (units: string[]) => {
    if (settled) return;
    settled = true;
    for (const u of units) {
      if (UNIT_NAME_RE.test(u)) sources.push({ id: `unit:${u}`, label: u.replace(/\.service$/, ""), group: "Services" });
    }
    finish();
  };
  const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* ignore */ } settle(KNOWN_UNITS); }, 2000);
  child.stdout?.on("data", (d: Buffer) => { out += d.toString(); });
  child.on("error", () => { clearTimeout(timer); settle(KNOWN_UNITS); });
  child.on("close", (code) => {
    clearTimeout(timer);
    const units = out.split("\n").map((l) => l.trim().split(/\s+/)[0]).filter((u): u is string => !!u && u.endsWith(".service"));
    settle(code === 0 && units.length > 0 ? units : KNOWN_UNITS);
  });
});

// Cap concurrent log streams so a leaked/shared token can't fork-bomb the
// appliance with per-connection journalctl/tail/ssh processes.
const MAX_LOG_STREAMS = 16;
let activeLogStreams = 0;

router.get("/shell/logs/stream", (req: Request, res: Response) => {
  if (!logStreamAuthed(req)) {
    res.status(401).json({ error: "Missing or invalid session token" });
    return;
  }
  if (activeLogStreams >= MAX_LOG_STREAMS) {
    res.status(429).json({ error: "Too many concurrent log streams — close other viewers first" });
    return;
  }
  const source = typeof req.query["source"] === "string" ? req.query["source"] : "system";

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // disable nginx buffering on appliance
  res.flushHeaders();

  const sendLine = (line: string, level = "info", ts?: number) => {
    const payload = JSON.stringify({ ts: ts ?? Date.now(), level, text: line.trimEnd() });
    try { res.write(`data: ${payload}\n\n`); } catch { /* client gone */ }
  };

  // Keep the connection alive while idle.
  activeLogStreams++;
  const heartbeat = setInterval(() => { try { res.write(": ping\n\n"); } catch { /* ignore */ } }, 15_000);
  let cleaned = false;
  const cleanups: Array<() => void> = [() => clearInterval(heartbeat)];
  const cleanup = () => {
    if (cleaned) return; // idempotent — close/error/exit can all fire
    cleaned = true;
    activeLogStreams--;
    for (const fn of cleanups.splice(0)) { try { fn(); } catch { /* ignore */ } }
  };
  req.on("close", cleanup);
  req.on("error", cleanup);

  // ── Child-process based sources (journal / file tails) ──
  // detached:true puts bash + its foreground journalctl/tail into their own
  // process group so teardown (kill(-pid)) can't leave orphans behind.
  const streamCommand = (cmd: string) => {
    const child = spawn("bash", ["-c", cmd], { stdio: ["ignore", "pipe", "pipe"], detached: true });
    const onData = (chunk: Buffer, level: string) => {
      for (const line of chunk.toString().split("\n")) {
        if (line.trim()) sendLine(line, level);
      }
    };
    child.stdout?.on("data", (c: Buffer) => onData(c, "info"));
    child.stderr?.on("data", (c: Buffer) => onData(c, "warn"));
    child.on("error", () => { cleanup(); try { res.end(); } catch { /* ignore */ } });
    child.on("exit", () => { cleanup(); try { res.end(); } catch { /* ignore */ } });
    cleanups.push(() => {
      const pid = child.pid;
      if (!pid) return;
      try { process.kill(-pid, "SIGTERM"); } catch { try { child.kill("SIGTERM"); } catch { /* ignore */ } }
      // Force-kill the group after a grace period if anything survived.
      const force = setTimeout(() => { try { process.kill(-pid, "SIGKILL"); } catch { /* ignore */ } }, 3000);
      force.unref?.();
    });
  };

  // ── Windows guest event-log polling over SSH ──
  const streamWindowsEvents = (vmId: string) => {
    // Cursor starts 15 minutes back so the first batch shows recent history.
    // Queries overlap the cursor by 5s and dedupe on (log, record id) so
    // same-timestamp events are never dropped between polls.
    let cursor = new Date(Date.now() - 15 * 60 * 1000);
    let lastErr = "";
    let inFlight = false;
    let stopped = false;
    const seen = new Set<string>();
    const seenOrder: string[] = [];
    const remember = (key: string): boolean => {
      if (seen.has(key)) return false;
      seen.add(key);
      seenOrder.push(key);
      if (seenOrder.length > 2000) { const old = seenOrder.splice(0, 1000); for (const k of old) seen.delete(k); }
      return true;
    };
    const poll = async () => {
      if (inFlight || stopped) return;
      const vm = getVm(vmId);
      if (!vm) { sendLine(`VM '${vmId}' no longer exists`, "error"); return; }
      const rt = getRuntime(vmId);
      if (rt.state !== "running") {
        if (lastErr !== "not-running") { sendLine(`${vm.name} is not running — waiting for it to start…`, "warn"); lastErr = "not-running"; }
        return;
      }
      inFlight = true;
      try {
        const startIso = new Date(cursor.getTime() - 5000).toISOString(); // inclusive overlap
        const ps =
          `Get-WinEvent -FilterHashtable @{LogName=@('System','Application');StartTime=[datetime]::Parse('${startIso}')} -MaxEvents 300 -ErrorAction SilentlyContinue | ` +
          `Sort-Object TimeCreated | ForEach-Object { '{0:o}\u0001{1}\u0001{2}\u0001{3}\u0001{4}\u0001{5}' -f $_.TimeCreated,$_.LevelDisplayName,$_.ProviderName,$_.LogName,$_.RecordId,(($_.Message | Out-String) -replace \"\\r?\\n\",' ').Trim() }`;
        const encoded = Buffer.from(ps, "utf16le").toString("base64");
        const r = await runSshCommand(vm, `powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`, 25_000);
        if (stopped) return; // viewer disconnected while the SSH poll ran
        if (!r.ok) {
          const msg = (r.stderr || "SSH command failed").trim().split("\n")[0] ?? "SSH command failed";
          if (msg !== lastErr) { sendLine(`Windows event log unavailable: ${msg}`, "warn"); lastErr = msg; }
          return;
        }
        lastErr = "";
        let newest = cursor;
        for (const line of r.stdout.split("\n")) {
          const parts = line.split("\u0001");
          if (parts.length < 6) continue;
          const when = new Date(parts[0] ?? "");
          if (isNaN(when.getTime())) continue;
          if (!remember(`${parts[3]}#${parts[4]}`)) continue; // (log, record id) dedupe
          if (when > newest) newest = when;
          const lvlName = (parts[1] ?? "").toLowerCase();
          const level = lvlName.includes("error") || lvlName.includes("critical") ? "error" : lvlName.includes("warn") ? "warn" : "info";
          sendLine(`[${parts[2]}] ${parts[5]}`, level, when.getTime());
        }
        cursor = newest;
      } finally {
        inFlight = false;
      }
    };
    sendLine("Streaming Windows System + Application event logs (polled every 10s over SSH)…", "info");
    void poll();
    const interval = setInterval(() => { void poll(); }, 10_000);
    cleanups.push(() => { stopped = true; clearInterval(interval); });
  };

  // ── Route the requested source ──
  // NB: `tail -F` on a missing file retries forever without exiting, so `||
  // echo fallback` chains never fire. Test availability explicitly, print an
  // honest status line, and let `tail -F` pick the file up when it appears.
  if (source === "system") {
    streamCommand(
      'if command -v journalctl >/dev/null 2>&1 && journalctl -n 1 >/dev/null 2>&1; then ' +
      '  journalctl -f -n 100 --output=short-precise; ' +
      'else ' +
      '  LOG="${ODYSSEUS_DATA_DIR:-/tmp}/odysseus.log"; ' +
      '  [ -e "$LOG" ] || echo "System journal unavailable on this host — following Odysseus log ($LOG) when it appears"; ' +
      '  tail -F -n 100 "$LOG" 2>/dev/null; ' +
      'fi',
    );
  } else if (source === "odysseus") {
    streamCommand(
      'LOG="${ODYSSEUS_DATA_DIR:-/tmp}/odysseus.log"; ' +
      '[ -e "$LOG" ] || echo "Odysseus log file not found yet ($LOG) — waiting for it to appear"; ' +
      'tail -F -n 200 "$LOG" 2>/dev/null',
    );
  } else if (source.startsWith("unit:")) {
    const unit = source.slice(5);
    if (!UNIT_NAME_RE.test(unit)) { sendLine(`Invalid unit name`, "error"); res.end(); return; }
    streamCommand(
      'if command -v journalctl >/dev/null 2>&1 && journalctl -n 1 >/dev/null 2>&1; then ' +
      `  journalctl -f -n 100 --output=short-precise -u ${unit}; ` +
      'else ' +
      '  echo "journalctl unavailable on this host (per-service logs require FoulFox OS)"; ' +
      'fi',
    );
  } else if (/^vm:[A-Za-z0-9._-]+:qemu$/.test(source)) {
    const vmId = source.split(":")[1]!;
    const vm = getVm(vmId);
    if (!vm) { sendLine(`Unknown VM '${vmId}'`, "error"); res.end(); return; }
    const logPath = path.join(vmDiskDir(vmId), "qemu.log");
    streamCommand(
      `LOG=${JSON.stringify(logPath)}; ` +
      '[ -e "$LOG" ] || echo "No QEMU log yet — it appears after the VM is started"; ' +
      'tail -F -n 300 "$LOG" 2>/dev/null',
    );
  } else if (/^vm:[A-Za-z0-9._-]+:windows$/.test(source)) {
    streamWindowsEvents(source.split(":")[1]!);
  } else if (/^app:[A-Za-z0-9._-]+$/.test(source)) {
    // Installed-app run log (in-memory ring buffer in the app runner). Dump
    // the current buffer, then poll for new lines every 2s.
    const appId = source.slice(4);
    const { getApp } = require("../lib/app-registry");
    const { runLog, runSummary } = require("../lib/app-runner");
    if (!getApp(appId)) { sendLine(`Unknown app '${appId}'`, "error"); try { res.end(); } catch { /* ignore */ } return; }
    let last: string[] = [];
    const emitNew = () => {
      const lines = runLog(appId).split("\n").filter((l: string) => l.length > 0);
      // Find where the previous snapshot's tail sits in the new buffer so ring
      // trimming doesn't cause replays; emit only what follows it.
      let startIdx = 0;
      if (last.length > 0) {
        const anchor = last[last.length - 1]!;
        for (let i = lines.length - 1; i >= 0; i--) {
          if (lines[i] === anchor) { startIdx = i + 1; break; }
        }
      }
      for (const line of lines.slice(startIdx)) {
        const lower = line.toLowerCase();
        sendLine(line, lower.includes("error") ? "error" : lower.includes("warn") ? "warn" : "info");
      }
      last = lines;
    };
    const summary = runSummary(appId);
    sendLine(`App '${appId}' is ${summary.phase ?? "not running"} — showing its run log`, "info");
    emitNew();
    const interval = setInterval(emitNew, 2000);
    cleanups.push(() => clearInterval(interval));
  } else {
    sendLine(`Unknown log source '${source}'`, "error");
    try { res.end(); } catch { /* ignore */ }
  }
});

// ── WebSocket handler ─────────────────────────────────────────────────────────
export function handleShellWebSocket(ws: WebSocket, req: IncomingMessage) {
  const reqUrl = new URL(req.url ?? "/", "http://localhost");
  const vmId = reqUrl.searchParams.get("vm") || undefined;

  const initial = resolveTarget(vmId);
  const session = ensurePty(initial);
  session.clients.add(ws);

  logger.info({ key: initial.key, kind: initial.kind }, "Shell WebSocket client connected");

  // Send a welcome banner reflecting where this terminal is connected.
  const banner =
    initial.kind === "vm-ssh"
      ? `\x1b[32mConnected to ${initial.label} via SSH\x1b[0m`
      : initial.kind === "vm-serial"
      ? `\x1b[32mConnected to ${initial.label} via serial console\x1b[0m`
      : initial.kind === "vm-down"
      ? `\x1b[33m${initial.label} is not running — start the VM to open a terminal\x1b[0m`
      : "\x1b[32mLocal host shell ready\x1b[0m";
  ws.send(JSON.stringify({ type: "data", data: `\r\n${banner}\r\n` }));

  ws.on("message", (raw: Buffer | string) => {
    // Re-resolve the target live so a VM that just started gets a real session.
    const t = resolveTarget(vmId);
    const s = ensurePty(t);
    if (!s.pty) return; // vm-down: nothing to write to yet
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "data") {
        s.pty.write(msg.data);
      } else if (msg.type === "resize" && msg.cols && msg.rows) {
        s.pty.resize(msg.cols, msg.rows);
      }
    } catch {
      s.pty.write(raw.toString());
    }
  });

  ws.on("close", () => {
    session.clients.delete(ws);
    logger.info({ key: initial.key }, "Shell WebSocket client disconnected");
  });

  ws.on("error", (err: Error) => {
    logger.error({ err, key: initial.key }, "Shell WebSocket error");
    session.clients.delete(ws);
  });
}

export function createShellWss(server: import("http").Server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request: IncomingMessage, socket, head) => {
    if (!request.url?.startsWith("/api/shell/ws")) return;

    const netSocket = socket as import("net").Socket;

    // 1. Enforce loopback-only (blocks remote attackers)
    const remoteAddr = netSocket.remoteAddress ?? "";
    const isLocal =
      remoteAddr === "127.0.0.1" ||
      remoteAddr === "::1" ||
      remoteAddr === "::ffff:127.0.0.1";

    if (!isLocal) {
      logger.warn({ remoteAddr }, "Rejected non-localhost shell WebSocket upgrade");
      netSocket.write("HTTP/1.1 403 Forbidden\r\nContent-Length: 9\r\n\r\nForbidden");
      netSocket.destroy();
      return;
    }

    // 2. Require session token (CSRF protection — prevents malicious pages from
    //    opening a shell WebSocket against the loopback API server)
    const reqUrl = new URL(request.url, "http://localhost");
    const providedToken = reqUrl.searchParams.get("token");
    if (providedToken !== SHELL_SESSION_TOKEN) {
      logger.warn("Rejected shell WebSocket upgrade: invalid token");
      netSocket.write("HTTP/1.1 401 Unauthorized\r\nContent-Length: 12\r\n\r\nUnauthorized");
      netSocket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket as any, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });

  wss.on("connection", handleShellWebSocket);
  return wss;
}

export default router;

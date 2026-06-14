import { Router, type IRouter, type Request, type Response } from "express";
import { type IncomingMessage } from "http";
import { WebSocketServer, type WebSocket } from "ws";
import * as pty from "node-pty";
import { spawn } from "child_process";
import { URL } from "url";
import { ExecShellCommandBody, ExecShellCommandResponse } from "@workspace/api-zod";
import { getVm, getRuntime } from "../lib/vm-registry";
import { logger } from "../lib/logger";
import { SHELL_SESSION_TOKEN } from "../lib/shell-token";

const router: IRouter = Router();

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
}

function sshArgsFor(sshPort: number, sshUser: string | null): string[] {
  const args = [
    "-o", "StrictHostKeyChecking=no",
    "-o", "UserKnownHostsFile=/dev/null",
    "-o", "ConnectTimeout=5",
    "-p", String(sshPort),
  ];
  args.push(sshUser ? `${sshUser}@localhost` : "localhost");
  return args;
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
  };
}

function buildPtyCommand(t: ResolvedTarget): { cmd: string; args: string[] } | null {
  if (t.kind === "vm-ssh") {
    return { cmd: "ssh", args: sshArgsFor(t.sshPort!, t.sshUser ?? null) };
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
    env: process.env as Record<string, string>,
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
    spawnArgs = [...sshArgsFor(target.sshPort!, target.sshUser ?? null), command];
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
    env: process.env,
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

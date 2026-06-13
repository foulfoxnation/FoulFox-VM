import { Router, type IRouter, type Request, type Response } from "express";
import { type IncomingMessage } from "http";
import { WebSocketServer, type WebSocket } from "ws";
import * as pty from "node-pty";
import { spawn } from "child_process";
import { ExecShellCommandBody, ExecShellCommandResponse } from "@workspace/api-zod";
import { vmRuntime, loadVmConfig } from "../lib/vm-state";
import { logger } from "../lib/logger";

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

// ── PTY / SSH session state ───────────────────────────────────────────────────
type SessionKind = "local" | "vm-ssh" | "vm-serial";

let activePty: ReturnType<typeof pty.spawn> | null = null;
let activeKind: SessionKind = "local";
const ptyClients: Set<WebSocket> = new Set();

function resolveSessionKind(): SessionKind {
  if (vmRuntime.state !== "running") return "local";
  const config = loadVmConfig();
  return config.connectionMode === "serial" ? "vm-serial" : "vm-ssh";
}

function buildPtyCommand(): { cmd: string; args: string[] } {
  const kind = resolveSessionKind();

  if (kind === "vm-ssh") {
    const config = loadVmConfig();
    const sshArgs = [
      "-o", "StrictHostKeyChecking=no",
      "-o", "UserKnownHostsFile=/dev/null",
      "-o", "ConnectTimeout=5",
      "-p", String(config.sshPort),
    ];
    if (config.sshUser) {
      sshArgs.push(`${config.sshUser}@localhost`);
    } else {
      sshArgs.push("localhost");
    }
    return { cmd: "ssh", args: sshArgs };
  }

  if (kind === "vm-serial") {
    return { cmd: "telnet", args: ["localhost", "4444"] };
  }

  // Default: local shell
  const shell = process.platform === "win32" ? "powershell.exe" : (process.env.SHELL || "/bin/bash");
  return { cmd: shell, args: [] };
}

function getOrCreatePty(): ReturnType<typeof pty.spawn> {
  const desiredKind = resolveSessionKind();

  // Tear down existing session if VM state changed (e.g. VM started or stopped)
  if (activePty && activeKind !== desiredKind) {
    try { activePty.kill(); } catch { /* ignore */ }
    activePty = null;
    // Notify clients about session reset
    for (const client of ptyClients) {
      if (client.readyState === client.OPEN) {
        const msg = desiredKind === "local"
          ? "\r\n\x1b[33mVM stopped — switching to local shell\x1b[0m\r\n"
          : `\r\n\x1b[32mVM running — opening ${desiredKind === "vm-ssh" ? "SSH" : "serial"} session\x1b[0m\r\n`;
        client.send(JSON.stringify({ type: "data", data: msg }));
      }
    }
  }

  if (activePty) return activePty;

  activeKind = desiredKind;
  const { cmd, args } = buildPtyCommand();

  logger.info({ kind: desiredKind, cmd, args }, "Spawning PTY session");

  activePty = pty.spawn(cmd, args, {
    name: "xterm-color",
    cols: 80,
    rows: 24,
    cwd: process.env.HOME || process.cwd(),
    env: process.env as Record<string, string>,
  });

  activePty.onData((data: string) => {
    for (const client of ptyClients) {
      if (client.readyState === client.OPEN) {
        client.send(JSON.stringify({ type: "data", data }));
      }
    }
  });

  activePty.onExit(({ exitCode }: { exitCode: number }) => {
    logger.info({ exitCode, kind: activeKind }, "PTY session exited");
    activePty = null;
    for (const client of ptyClients) {
      if (client.readyState === client.OPEN) {
        client.send(JSON.stringify({ type: "exit", exitCode }));
      }
    }
    ptyClients.clear();
  });

  return activePty;
}

// ── REST: Execute shell command (Odysseus agent tool — localhost only) ────────
router.post("/shell/exec", (req: Request, res: Response) => {
  const parsed = ExecShellCommandBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { command, timeoutMs = 10000 } = parsed.data;

  // When VM is running, execute commands via SSH if possible
  const kind = resolveSessionKind();
  let spawnCmd: string;
  let spawnArgs: string[];

  if (kind === "vm-ssh") {
    const config = loadVmConfig();
    const userAt = config.sshUser ? `${config.sshUser}@` : "";
    spawnCmd = "ssh";
    spawnArgs = [
      "-o", "StrictHostKeyChecking=no",
      "-o", "UserKnownHostsFile=/dev/null",
      "-o", "ConnectTimeout=5",
      "-p", String(config.sshPort),
      `${userAt}localhost`,
      command,
    ];
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

    res.json(ExecShellCommandResponse.parse({ stdout, stderr, exitCode, timedOut }));
  });

  child.on("error", (err) => {
    clearTimeout(timer);
    res.json(ExecShellCommandResponse.parse({
      stdout: "",
      stderr: err.message,
      exitCode: -1,
      timedOut: false,
    }));
  });
});

// REST: Shell history
router.get("/shell/history", (_req: Request, res: Response) => {
  res.json(shellHistory.slice(0, 50));
});

// ── WebSocket handler ─────────────────────────────────────────────────────────
export function handleShellWebSocket(ws: WebSocket, _req: IncomingMessage) {
  const term = getOrCreatePty();
  ptyClients.add(ws);

  logger.info({ kind: activeKind }, "Shell WebSocket client connected");

  // Send a welcome banner
  const vmMsg = activeKind === "vm-ssh"
    ? "\x1b[32mConnected to Windows VM via SSH\x1b[0m"
    : activeKind === "vm-serial"
    ? "\x1b[32mConnected to Windows VM via serial console\x1b[0m"
    : "\x1b[32mLocal shell ready\x1b[0m";
  ws.send(JSON.stringify({ type: "data", data: `\r\n${vmMsg}\r\n` }));

  ws.on("message", (raw: Buffer | string) => {
    // Re-check VM state on every message — switch session if needed
    const currentTerm = getOrCreatePty();
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "data") {
        currentTerm.write(msg.data);
      } else if (msg.type === "resize" && msg.cols && msg.rows) {
        currentTerm.resize(msg.cols, msg.rows);
      }
    } catch {
      currentTerm.write(raw.toString());
    }
  });

  ws.on("close", () => {
    ptyClients.delete(ws);
    logger.info("Shell WebSocket client disconnected");
  });

  ws.on("error", (err: Error) => {
    logger.error({ err }, "Shell WebSocket error");
    ptyClients.delete(ws);
  });
}

export function createShellWss(server: import("http").Server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request: IncomingMessage, socket, head) => {
    if (request.url === "/api/shell/ws") {
      wss.handleUpgrade(request, socket as any, head, (ws) => {
        wss.emit("connection", ws, request);
      });
    }
  });

  wss.on("connection", handleShellWebSocket);
  return wss;
}

export default router;

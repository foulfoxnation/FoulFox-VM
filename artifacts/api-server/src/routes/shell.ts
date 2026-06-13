import { Router, type IRouter, type Request, type Response } from "express";
import { type IncomingMessage } from "http";
import { WebSocketServer, type WebSocket } from "ws";
import * as pty from "node-pty";
import { ExecShellCommandBody, ExecShellCommandResponse } from "@workspace/api-zod";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// In-memory shell command history (last 200 entries)
const shellHistory: Array<{
  id: number;
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timestamp: string;
}> = [];
let historyIdCounter = 0;

// Active pty session
let activePty: ReturnType<typeof pty.spawn> | null = null;
const ptyClients: Set<WebSocket> = new Set();

function getOrCreatePty() {
  if (activePty) return activePty;

  const shell = process.platform === "win32" ? "powershell.exe" : process.env.SHELL || "bash";
  activePty = pty.spawn(shell, [], {
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
    logger.info({ exitCode }, "PTY session exited");
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

// REST: Execute a command and capture output (for Odysseus agent tool)
router.post("/shell/exec", (req: Request, res: Response) => {
  const parsed = ExecShellCommandBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { command, timeoutMs = 10000 } = parsed.data;

  const { spawn } = require("child_process");
  const shell = process.platform === "win32" ? "powershell.exe" : "/bin/bash";
  const args = process.platform === "win32" ? ["-Command", command] : ["-c", command];

  let stdout = "";
  let stderr = "";
  let timedOut = false;

  const child = spawn(shell, args, {
    cwd: process.env.HOME || process.cwd(),
    env: process.env,
  });

  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, timeoutMs);

  child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
  child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

  child.on("close", (exitCode: number | null) => {
    clearTimeout(timer);

    const entry = {
      id: ++historyIdCounter,
      command,
      stdout,
      stderr,
      exitCode,
      timestamp: new Date().toISOString(),
    };
    shellHistory.unshift(entry);
    if (shellHistory.length > 200) shellHistory.pop();

    const result = ExecShellCommandResponse.parse({ stdout, stderr, exitCode, timedOut });
    res.json(result);
  });
});

// REST: Get shell history
router.get("/shell/history", (_req: Request, res: Response) => {
  res.json(shellHistory.slice(0, 50));
});

// WebSocket handler — called from the HTTP server in index.ts
export function handleShellWebSocket(ws: WebSocket, _req: IncomingMessage) {
  const term = getOrCreatePty();
  ptyClients.add(ws);

  logger.info("Shell WebSocket client connected");

  ws.on("message", (raw: Buffer | string) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "data") {
        term.write(msg.data);
      } else if (msg.type === "resize" && msg.cols && msg.rows) {
        term.resize(msg.cols, msg.rows);
      }
    } catch {
      term.write(raw.toString());
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

  // Send a welcome message
  ws.send(JSON.stringify({ type: "data", data: "\r\n\x1b[32mShell ready\x1b[0m\r\n" }));
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

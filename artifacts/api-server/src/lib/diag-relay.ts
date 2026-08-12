import { WebSocketServer, WebSocket, type RawData } from "ws";
import { type IncomingMessage, type Server, get as httpGet } from "http";
import fs from "fs";
import path from "path";
import { URL } from "url";
import { logger } from "./logger";

// ── Live log relay ────────────────────────────────────────────────────────────
// The FoulFox appliance sits on the user's LAN and cannot be reached from the
// Replit workspace. This module gives the workspace live eyes on the machine
// the way the user designed it: the APPLIANCE opens an outbound WebSocket to
// the workspace and streams every log source of the Session Portal viewer
// (journal, services, apps, QEMU, Windows guest events) over it, live.
//
//   appliance (client, SERVE_SHELL_STATIC)  ──ws──▶  workspace (sink)
//
// The relay is strictly one-way: the sink only ever receives; no commands or
// control messages flow back to the machine. The marker below is not a secret
// (the repo is public) — it only keeps random scanners out of the sink dir;
// the data itself is the same logs the LAN-local portal already shows.

const RELAY_PATH = "/api/diag/relay";
const RELAY_MARKER = "foulfox-diag-v1";
const DEFAULT_RELAY_URL =
  "wss://348b5a4c-275f-4101-a37f-7d3b6eca826b-00-33btqqqsxst0t.picard.replit.dev/api/diag/relay";

// ── Sink (workspace side) ─────────────────────────────────────────────────────

// Resolve from cwd (artifacts/api-server in dev), NOT __dirname — the esbuild
// bundle rewrites __dirname to dist/ and the reports would land outside the repo.
const SINK_DIR = process.env["FOULFOX_DIAG_SINK_DIR"] ||
  path.resolve(process.cwd(), "..", "..", ".local", "machine-logs");
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SINK_CONNS = 3;
const MAX_SINK_FILES = 64; // total distinct source files — bounds total disk use
const MAX_LINES_PER_SEC = 200; // global sink rate limit

function sanitizeSourceName(source: string): string | null {
  const clean = source.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80);
  return clean.length > 0 ? clean : null;
}

export function createDiagRelayWss(server: Server): void {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  let conns = 0;
  const knownFiles = new Set<string>();
  let windowStart = 0;
  let windowCount = 0;

  server.on("upgrade", (request: IncomingMessage, socket, head) => {
    const u = new URL(request.url ?? "/", "http://localhost");
    if (u.pathname !== RELAY_PATH) return; // other handlers own their paths
    // The sink only runs in the dev workspace — the appliance is a client.
    if (process.env["SERVE_SHELL_STATIC"] || u.searchParams.get("marker") !== RELAY_MARKER || conns >= MAX_SINK_CONNS) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
  });

  wss.on("connection", (ws: WebSocket) => {
    conns++;
    logger.info("diag relay: appliance connected");
    try { fs.mkdirSync(SINK_DIR, { recursive: true }); } catch { /* ignore */ }
    try {
      fs.writeFileSync(path.join(SINK_DIR, "_status.json"), JSON.stringify({ connected: true, since: new Date().toISOString() }));
    } catch { /* ignore */ }

    ws.on("message", (raw: RawData) => {
      try {
        // Global rate limit: bounds event-loop and disk work no matter the sender.
        const nowSec = Math.floor(Date.now() / 1000);
        if (nowSec !== windowStart) { windowStart = nowSec; windowCount = 0; }
        if (++windowCount > MAX_LINES_PER_SEC) return;

        let msg: { source?: string; ts?: number; level?: string; text?: string };
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        const name = typeof msg.source === "string" ? sanitizeSourceName(msg.source) : null;
        if (!name || typeof msg.text !== "string") return;
        // Bound the number of distinct files an untrusted sender can create.
        if (!knownFiles.has(name)) {
          if (knownFiles.size >= MAX_SINK_FILES) return;
          knownFiles.add(name);
        }
        const file = path.join(SINK_DIR, `${name}.log`);
        const tsOk = typeof msg.ts === "number" && Number.isFinite(msg.ts) && Math.abs(msg.ts) < 8.64e15;
        const stamp = new Date(tsOk ? (msg.ts as number) : Date.now()).toISOString();
        const line = `${stamp} [${String(msg.level ?? "info").slice(0, 10)}] ${msg.text.slice(0, 4000)}\n`;
        try { if (fs.statSync(file).size > MAX_FILE_BYTES) fs.truncateSync(file, 0); } catch { /* new file */ }
        fs.appendFileSync(file, line);
      } catch { /* never let a malformed message crash the server */ }
    });

    ws.on("close", () => {
      conns--;
      logger.info("diag relay: appliance disconnected");
      try {
        fs.writeFileSync(path.join(SINK_DIR, "_status.json"), JSON.stringify({ connected: false, lastSeen: new Date().toISOString() }));
      } catch { /* ignore */ }
    });
    ws.on("error", () => { /* close handler does the bookkeeping */ });
  });
}

// ── Client (appliance side) ───────────────────────────────────────────────────
// Forwards the SAME sources the portal's Logs tab offers by consuming the local
// SSE endpoints (loopback, authed with the process's own session token), so the
// relay can never drift from what the viewer shows.

interface SseFollower { stop: () => void }

function followLocalSse(port: number, token: string, source: string, onLine: (e: { ts: number; level: string; text: string }) => void): SseFollower {
  let stopped = false;
  let req: ReturnType<typeof httpGet> | null = null;
  let retry: NodeJS.Timeout | null = null;

  const connect = () => {
    if (stopped) return;
    const url = `http://127.0.0.1:${port}/api/shell/logs/stream?token=${encodeURIComponent(token)}&source=${encodeURIComponent(source)}`;
    req = httpGet(url, (res) => {
      if (res.statusCode !== 200) { res.resume(); scheduleRetry(); return; }
      res.setEncoding("utf8"); // avoid corrupting multi-byte chars split across chunks
      let buf = "";
      res.on("data", (chunk: string) => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const l of frame.split("\n")) {
            if (!l.startsWith("data: ")) continue;
            try {
              const e = JSON.parse(l.slice(6));
              if (typeof e.text === "string") onLine({ ts: e.ts ?? Date.now(), level: e.level ?? "info", text: e.text });
            } catch { /* skip malformed frame */ }
          }
        }
        if (buf.length > 65536) buf = buf.slice(-16384); // never grow unbounded
      });
      res.on("end", scheduleRetry);
      res.on("error", scheduleRetry);
    });
    req.on("error", scheduleRetry);
  };

  const scheduleRetry = () => {
    if (stopped || retry) return;
    retry = setTimeout(() => { retry = null; connect(); }, 30_000);
  };

  connect();
  return {
    stop: () => {
      stopped = true;
      if (retry) clearTimeout(retry);
      try { req?.destroy(); } catch { /* ignore */ }
    },
  };
}

function fetchJson(port: number, p: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const req2 = httpGet(`http://127.0.0.1:${port}${p}`, { timeout: 15_000 }, (res) => {
      let body = "";
      res.on("data", (d: Buffer) => { body += d.toString(); if (body.length > 1e6) req2.destroy(); });
      res.on("end", () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
      res.on("error", reject);
    });
    req2.on("timeout", () => { req2.destroy(new Error("local fetch timeout")); });
    req2.on("error", reject);
  });
}

// Keep a headroom margin under the server's MAX_LOG_STREAMS so human viewers
// (portal Logs tab) always have stream budget left.
const MAX_RELAY_FOLLOWERS = 32;

export function startDiagRelayClient(port: number): void {
  const target = process.env["FOULFOX_RELAY_URL"] || DEFAULT_RELAY_URL;
  if (target === "off" || target === "disabled") return;

  let followers: SseFollower[] = [];
  let backoffMs = 15_000;
  // Connection generation: every (re)connect bumps this. Async follower setup
  // checks it before installing anything, so a socket that died while source
  // discovery was in flight can never leak orphan followers into a later
  // connection (they'd double-stream and pin local SSE slots forever).
  let generation = 0;

  const stopFollowers = () => { for (const f of followers.splice(0)) f.stop(); };

  const startFollowers = async (gen: number, sock: WebSocket) => {
    // Ask our own sources endpoint so the relayed set always matches the viewer.
    try {
      const tok = (await fetchJson(port, "/api/shell/session-token")).token as string;
      const { sources } = await fetchJson(port, `/api/shell/logs/sources?token=${encodeURIComponent(tok)}`);
      if (gen !== generation || sock.readyState !== WebSocket.OPEN) return; // stale connection — abort
      const wanted = (sources as Array<{ id: string }>).map((s) => s.id)
        .filter((id, i, arr) => arr.indexOf(id) === i)
        .slice(0, MAX_RELAY_FOLLOWERS);
      // Backpressure queue: when the socket's send buffer is full (typical at
      // (re)connect, when all followers dump their buffers at once), park lines
      // instead of dropping them. Silent drops previously lost the one-line
      // diagnostic breadcrumbs from quiet sources (e.g. an app's
      // "Registry: status=..." line) because high-volume sources filled the
      // buffer first — exactly the lines needed to debug a stopped app.
      const MAX_PENDING = 2000;
      const pending: string[] = [];
      let flusher: NodeJS.Timeout | null = null;
      const flush = () => {
        while (pending.length > 0) {
          if (gen !== generation || sock.readyState !== WebSocket.OPEN) { pending.length = 0; break; }
          if (sock.bufferedAmount >= 512 * 1024) return; // still congested — retry next tick
          const p = pending.shift()!;
          try { sock.send(p); } catch { /* ignore */ }
        }
        if (pending.length === 0 && flusher) { clearInterval(flusher); flusher = null; }
      };
      followers.push({ stop: () => { if (flusher) { clearInterval(flusher); flusher = null; } pending.length = 0; } });
      for (const id of wanted) {
        followers.push(followLocalSse(port, tok, id, (e) => {
          if (gen !== generation || sock.readyState !== WebSocket.OPEN) return;
          const payload = JSON.stringify({ source: id, ...e });
          if (sock.bufferedAmount >= 512 * 1024 || pending.length > 0) {
            // Congested: queue (drop OLDEST on overflow so fresh lines win).
            if (pending.length >= MAX_PENDING) pending.shift();
            pending.push(payload);
            if (!flusher) flusher = setInterval(flush, 250);
            return;
          }
          try { sock.send(payload); } catch { /* ignore */ }
        }));
      }
      logger.info({ count: wanted.length, target }, "diag relay client: streaming sources");
    } catch (err) {
      logger.warn({ err }, "diag relay client: failed to start followers");
    }
  };

  const connect = () => {
    const gen = ++generation;
    let sock: WebSocket;
    try {
      sock = new WebSocket(`${target}?marker=${RELAY_MARKER}`, { handshakeTimeout: 15_000 });
    } catch (err) {
      // Malformed FOULFOX_RELAY_URL must never crash the appliance API.
      logger.warn({ err, target }, "diag relay client: invalid relay URL — retrying later");
      backoffMs = Math.min(backoffMs * 2, 10 * 60_000);
      setTimeout(connect, backoffMs);
      return;
    }

    sock.on("open", () => {
      backoffMs = 15_000;
      logger.info({ target }, "diag relay: connected to workspace");
      void startFollowers(gen, sock);
    });

    let downHandled = false;
    const onDown = () => {
      if (downHandled || gen !== generation) return;
      downHandled = true;
      stopFollowers();
      try { sock.terminate(); } catch { /* ignore */ }
      backoffMs = Math.min(backoffMs * 2, 10 * 60_000);
      const jitter = Math.floor(Math.random() * 10_000);
      setTimeout(connect, backoffMs + jitter);
    };
    sock.on("close", onDown);
    sock.on("error", () => { /* close fires next */ });
  };

  // Give the local HTTP server a moment to bind before self-connecting.
  setTimeout(connect, 20_000);
}

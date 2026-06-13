/**
 * Electron main process for Windows Odysseus + Unity.
 * Spawns the API server and Odysseus Python service as supervised children,
 * then opens a BrowserWindow loading the bundled frontend.
 *
 * Run locally (not in Replit):
 *   pnpm --filter @workspace/odysseus-shell run electron:dev   # dev mode
 *   pnpm --filter @workspace/odysseus-shell run electron:build # package
 */

"use strict";

const { app, BrowserWindow, Menu, dialog } = require("electron");
const { spawn } = require("child_process");
const path = require("path");
const http = require("http");
const fs = require("fs");

// ── Child process handles ────────────────────────────────────────────────────
let apiProcess = null;
let odysseusProcess = null;

const API_PORT = 8080;
const ODYSSEUS_PORT = 7000;

// ── Path resolution ───────────────────────────────────────────────────────────
// In production (packaged) Electron, child binaries are in extraResources.
// In development, they live in the source tree relative to this file.

const IS_PACKAGED = app.isPackaged;

// Path layout:
//   This file:  artifacts/odysseus-shell/electron/main.cjs  (__dirname)
//   packaged → extraResources land under process.resourcesPath/
//   dev      → resolve from __dirname up to the artifacts/ directory
//
//   __dirname  = artifacts/odysseus-shell/electron
//   ..         = artifacts/odysseus-shell
//   ../..      = artifacts/                         ← RESOURCES_ROOT in dev
//   ../../..   = repo root  (NOT what we want)

const RESOURCES_ROOT = IS_PACKAGED
  ? process.resourcesPath
  : path.resolve(__dirname, "..", "..");  // = artifacts/

// API server dist (external node-pty is NOT bundled; must be next to dist/)
const API_DIST = path.join(RESOURCES_ROOT, "api-server", "dist", "index.mjs");
const API_CWD  = path.join(RESOURCES_ROOT, "api-server");

// Odysseus Python service
const ODYSSEUS_DIR = path.join(RESOURCES_ROOT, "odysseus-service");

const ODYSSEUS_START = path.join(ODYSSEUS_DIR, "start.sh");

// Frontend HTML for production load (file:// URL to bundled index.html)
const FRONTEND_HTML = IS_PACKAGED
  ? path.join(__dirname, "..", "dist", "public", "index.html")
  : path.join(__dirname, "..", "dist", "public", "index.html");

// ── Logging ──────────────────────────────────────────────────────────────────
function log(tag, msg) {
  const ts = new Date().toISOString().substring(11, 19);
  process.stdout.write(`[${ts}][${tag}] ${msg}\n`);
}

// ── Shared bridge token ────────────────────────────────────────────────────────
// Generated once per Electron session. Passed to both the API server
// (as SHELL_SESSION_TOKEN + ODYSSEUS_INTERNAL_TOKEN) and to Odysseus
// (as ODYSSEUS_BRIDGE_TOKEN) so Odysseus tool calls to /api/shell/exec
// are accepted by the Express token-auth middleware.
const { randomBytes } = require("crypto");
const BRIDGE_TOKEN = randomBytes(32).toString("hex");

function buildApiEnv() {
  return {
    ...process.env,
    PORT: String(API_PORT),
    NODE_ENV: "production",
    HOST: "127.0.0.1",
    // Pre-seed the shell session token so Odysseus can share it
    SHELL_SESSION_TOKEN: BRIDGE_TOKEN,
    // Also exposed as ODYSSEUS_INTERNAL_TOKEN so the Express middleware
    // accepts Odysseus's X-Odysseus-Internal-Token header
    ODYSSEUS_INTERNAL_TOKEN: BRIDGE_TOKEN,
  };
}

function buildOdysseusEnv() {
  const env = { ...process.env };
  env.HOST = "127.0.0.1";
  env.PORT = String(ODYSSEUS_PORT);
  env.AUTH_ENABLED = "false";
  env.ODYSSEUS_DATA_DIR = path.join(ODYSSEUS_DIR, "data");

  // Route Odysseus tool /api/shell/exec calls to the Express API server
  env.ODYSSEUS_SHELL_BASE = `http://127.0.0.1:${API_PORT}`;
  // Shared token so Express accepts Odysseus's internal header
  env.ODYSSEUS_BRIDGE_TOKEN = BRIDGE_TOKEN;

  // Map Replit AI Anthropic key if present
  if (env.AI_INTEGRATIONS_ANTHROPIC_API_KEY && !env.OPENAI_API_KEY) {
    env.OPENAI_API_KEY = env.AI_INTEGRATIONS_ANTHROPIC_API_KEY;
  }
  if (!env.OPENAI_BASE_URL) {
    env.OPENAI_BASE_URL = "https://openai-proxy.replit.com/v1";
  }
  if (!env.OPENAI_MODEL) {
    env.OPENAI_MODEL = "claude-sonnet-4-5";
  }

  return env;
}

function startApiServer() {
  if (!fs.existsSync(API_DIST)) {
    log("api", `WARNING: dist not found at ${API_DIST} — run 'pnpm build' in api-server first`);
    return;
  }

  apiProcess = spawn(process.execPath, [API_DIST], {
    cwd: API_CWD,
    env: buildApiEnv(),
    stdio: "pipe",
  });

  apiProcess.stdout.on("data", (d) => log("api", d.toString().trim()));
  apiProcess.stderr.on("data", (d) => log("api:err", d.toString().trim()));
  apiProcess.on("error", (err) => log("api:err", `spawn error: ${err.message}`));
  apiProcess.on("exit", (code) => log("api", `exited with code ${code}`));
}

function startOdysseus() {
  const useScript = fs.existsSync(ODYSSEUS_START);
  const cmd = useScript ? "bash" : "python";
  const args = useScript
    ? [ODYSSEUS_START]
    : ["-m", "uvicorn", "app:app", "--host", "127.0.0.1", "--port", String(ODYSSEUS_PORT)];

  odysseusProcess = spawn(cmd, args, {
    cwd: ODYSSEUS_DIR,
    env: buildOdysseusEnv(),
    stdio: "pipe",
  });

  odysseusProcess.stdout.on("data", (d) => log("odysseus", d.toString().trim()));
  odysseusProcess.stderr.on("data", (d) => log("odysseus:err", d.toString().trim()));
  odysseusProcess.on("error", (err) => log("odysseus:err", `spawn error: ${err.message}`));
  odysseusProcess.on("exit", (code) => log("odysseus", `exited with code ${code}`));
}

// ── Wait for HTTP port ─────────────────────────────────────────────────────────
function waitForPort(port, maxMs = 30000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      const req = http.request(
        { hostname: "127.0.0.1", port, path: "/api/healthz", timeout: 1000 },
        (res) => { resolve(res.statusCode < 500); },
      );
      req.on("error", () => {
        if (Date.now() - start < maxMs) setTimeout(check, 500);
        else resolve(false);
      });
      req.on("timeout", () => { req.destroy(); setTimeout(check, 500); });
      req.end();
    };
    check();
  });
}

// ── Kill all children ─────────────────────────────────────────────────────────
function killChildren() {
  [apiProcess, odysseusProcess].forEach((proc) => {
    if (proc) {
      try { proc.kill("SIGTERM"); } catch { /* ignore */ }
      setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* ignore */ } }, 3000);
    }
  });
}

// ── Main window ───────────────────────────────────────────────────────────────
async function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: "Windows Odysseus + Unity",
    backgroundColor: "#09090b",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  });

  Menu.setApplicationMenu(null);

  const isDev = process.env.NODE_ENV === "development" || !IS_PACKAGED;

  if (isDev) {
    // Development: load Vite dev server (must be running separately)
    const devPort = process.env.VITE_PORT || "26142";
    log("app", `DEV mode — loading http://localhost:${devPort}/`);
    win.webContents.openDevTools();
    await win.loadURL(`http://localhost:${devPort}/`);
  } else {
    // Production: serve built static files from file:// URL.
    // The frontend connects to the API server via http://127.0.0.1:8080/api/...
    // which is already started and bound to loopback.
    if (!fs.existsSync(FRONTEND_HTML)) {
      dialog.showErrorBox(
        "Startup failed",
        `Built frontend not found at:\n${FRONTEND_HTML}\n\nRun 'pnpm electron:build' to create a distributable.`,
      );
      app.quit();
      return;
    }

    log("app", `Waiting for API server on port ${API_PORT}…`);
    const ready = await waitForPort(API_PORT, 30000);
    if (!ready) {
      dialog.showErrorBox("Startup failed", "API server did not become healthy within 30 seconds.");
      app.quit();
      return;
    }

    log("app", `Loading frontend from file: ${FRONTEND_HTML}`);
    await win.loadFile(FRONTEND_HTML);
  }

  win.on("closed", killChildren);
}

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  log("app", `Starting (packaged=${IS_PACKAGED}, resources=${RESOURCES_ROOT})`);
  startApiServer();
  startOdysseus();

  // Give services a head-start, then open the window (which polls for API readiness)
  setTimeout(createWindow, 800);
});

app.on("window-all-closed", () => {
  killChildren();
  app.quit();
});

app.on("before-quit", killChildren);

// macOS: re-open on dock click
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

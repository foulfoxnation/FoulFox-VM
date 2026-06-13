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

const { app, BrowserWindow, Menu, ipcMain, dialog } = require("electron");
const { spawn } = require("child_process");
const path = require("path");
const http = require("http");
const fs = require("fs");

// ── Child process handles ────────────────────────────────────────────────────
let apiProcess = null;
let odysseusProcess = null;

const API_PORT = 8080;
const ODYSSEUS_PORT = 7000;

// Project root (two levels up from electron/)
const PROJECT_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const API_DIST = path.join(PROJECT_ROOT, "artifacts", "api-server", "dist", "index.mjs");
const ODYSSEUS_DIR = path.join(PROJECT_ROOT, "artifacts", "odysseus-service");
const ODYSSEUS_START = path.join(ODYSSEUS_DIR, "start.sh");
const FRONTEND_DIST = path.join(__dirname, "..", "dist", "public", "index.html");

// ── Logging ──────────────────────────────────────────────────────────────────
function log(tag, msg) {
  const ts = new Date().toISOString().substring(11, 19);
  console.log(`[${ts}][${tag}] ${msg}`);
}

// ── Service startup ──────────────────────────────────────────────────────────
function buildOdysseusEnv() {
  const env = { ...process.env };
  env.HOST = "127.0.0.1";
  env.PORT = String(ODYSSEUS_PORT);
  env.AUTH_ENABLED = "false";
  env.ODYSSEUS_DATA_DIR = path.join(ODYSSEUS_DIR, "data");
  // Allow callers to pre-set OPENAI_API_KEY; otherwise Odysseus starts unconfigured
  return env;
}

function startApiServer() {
  if (!fs.existsSync(API_DIST)) {
    log("api", `WARNING: dist not found at ${API_DIST} — run pnpm build first`);
    return;
  }

  apiProcess = spawn(process.execPath, [API_DIST], {
    cwd: path.join(PROJECT_ROOT, "artifacts", "api-server"),
    env: { ...process.env, PORT: String(API_PORT), NODE_ENV: "production" },
    stdio: "pipe",
  });

  apiProcess.stdout.on("data", (d) => log("api", d.toString().trim()));
  apiProcess.stderr.on("data", (d) => log("api:err", d.toString().trim()));
  apiProcess.on("error", (err) => log("api:err", `spawn error: ${err.message}`));
  apiProcess.on("exit", (code) => log("api", `exited with code ${code}`));
}

function startOdysseus() {
  const cmd = fs.existsSync(ODYSSEUS_START) ? "bash" : "python";
  const args = fs.existsSync(ODYSSEUS_START)
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

// ── Wait for port ─────────────────────────────────────────────────────────────
function waitForPort(port, maxMs = 30000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      const req = http.request({ hostname: "127.0.0.1", port, path: "/", timeout: 1000 }, () => resolve(true));
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

  // Suppress default menu bar
  Menu.setApplicationMenu(null);

  const isDev = !fs.existsSync(FRONTEND_DIST);

  if (isDev) {
    // Development: load Vite dev server
    log("app", "DEV mode — loading http://localhost:26142/");
    await win.loadURL("http://localhost:26142/");
    win.webContents.openDevTools();
  } else {
    // Production: load built static files via api server
    log("app", `Waiting for API server on port ${API_PORT}…`);
    const ready = await waitForPort(API_PORT, 30000);
    if (!ready) {
      dialog.showErrorBox("Startup failed", "API server did not start within 30 seconds.");
      app.quit();
      return;
    }
    log("app", "Loading production build via API server");
    await win.loadURL(`http://127.0.0.1:${API_PORT}/`);
  }

  win.on("closed", () => {
    killChildren();
  });
}

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  log("app", "Starting child services…");
  startApiServer();
  startOdysseus();

  // Give them a moment to start, then open the window
  // (Window will poll/wait for the API server to be ready in production)
  setTimeout(createWindow, 1000);
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

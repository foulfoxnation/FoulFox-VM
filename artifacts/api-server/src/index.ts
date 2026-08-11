import http from "http";
import express, { type Request, type Response, type NextFunction } from "express";
import app from "./app";
import { logger } from "./lib/logger";
import appUiRouter from "./routes/app-ui";
import { createShellWss } from "./routes/shell";
import { ensureDefaultVm } from "./lib/vm-registry";
import { reconcileOrphans } from "./lib/vm-launch";
import { backfillVmSshKeys } from "./lib/vm-provision";
import { createDisplayWss } from "./lib/vm-display";
import { createHostDisplayWss } from "./lib/host-display";
import { autostartApps, stopAllApps } from "./lib/app-runner";
import { seedDefaultApps } from "./lib/default-apps";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// Create HTTP server so we can attach WebSocket server
const server = http.createServer(app);

// Attach shell WebSocket server
createShellWss(server);

// Attach the per-VM display (noVNC) WebSocket proxy.
createDisplayWss(server);

// Attach the host desktop display WebSocket proxy (proxies to x11vnc port 5900).
createHostDisplayWss(server);

// Bootstrap the multi-VM registry: ensure a "default" VM exists (migrating any
// legacy single-VM config) and reconcile orphaned QEMU processes left behind by
// a previous run before they can corrupt a managed disk.
ensureDefaultVm()
  .then(() => {
    try {
      reconcileOrphans();
    } catch (err) {
      logger.error({ err }, "Orphan reconciliation failed");
    }
    // Generate missing SSH keypairs for any VMs that were provisioned without
    // one. This is a no-op when keys already exist so it is safe every boot.
    backfillVmSshKeys().catch((err) =>
      logger.error({ err }, "SSH keypair backfill failed"),
    );
  })
  .catch((err) => logger.error({ err }, "Failed to initialize default VM"));

// Bind to loopback by default (127.0.0.1) so the API is only reachable
// from the local machine. The Electron app and Vite dev proxy both connect
// from localhost, so this is safe. Override with HOST env for dev tunnels.
const host = process.env["HOST"] ?? "127.0.0.1";

server.listen(port, host, () => {
  logger.info({ port, host }, "Server listening");
  // Launch installed apps marked autostart:true (e.g. the hands-free voice
  // agent) so they are live at login without any interaction.
  try {
    autostartApps();
  } catch (err) {
    logger.error({ err }, "App autostart failed");
  }
  // Install any OS-bundled default apps (first boot only per app id); each is
  // started after install if its manifest says autostart.
  seedDefaultApps().catch((err) =>
    logger.error({ err }, "Default app seeding failed"),
  );
});

server.on("error", (err) => {
  logger.error({ err }, "Server error");
  process.exit(1);
});

// Graceful shutdown: stop every managed app process (SIGTERM → SIGKILL after
// grace) so voice/AI sidecars are never orphaned when the api-server exits.
let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "shutting down: stopping managed apps");
  try {
    stopAllApps();
  } catch (err) {
    logger.error({ err }, "stopAllApps failed during shutdown");
  }
  server.close(() => process.exit(0));
  // Hard deadline: don't hang forever on open connections.
  setTimeout(() => process.exit(0), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// ── Dedicated app-UI origin (privilege separation) ────────────────────────────
// On the appliance the shell embeds installed-app UIs from this SEPARATE
// loopback origin (http://127.0.0.1:<APP_UI_PORT>) instead of the shell origin.
// The iframe keeps allow-same-origin (so mic/getUserMedia works via the kiosk
// policy for this origin) but app JS is same-origin only with THIS server,
// which serves nothing except the UI proxy — it cannot read the shell session
// token or call any token-gated shell API cross-origin. Only started in
// appliance mode (SERVE_SHELL_STATIC); the Replit dev preview can't reach a
// second port, so dev uses the same-origin path with an opaque-sandbox iframe.
if (process.env["SERVE_SHELL_STATIC"]) {
  const appUiPort = Number(process.env["APP_UI_PORT"] ?? "8081");
  const appUiApp = express();
  appUiApp.use((req: Request, res: Response, next: NextFunction) => {
    const remoteAddr = req.socket.remoteAddress;
    const isLocal =
      remoteAddr === "127.0.0.1" ||
      remoteAddr === "::1" ||
      remoteAddr === "::ffff:127.0.0.1";
    if (!isLocal) {
      res.status(403).json({ error: "Only accessible from localhost" });
      return;
    }
    next();
  });
  // Same mount path as the dev same-origin route so the proxy's prefix
  // rewriting and runtime shim work unchanged.
  appUiApp.use("/api/apps", appUiRouter);
  appUiApp
    .listen(appUiPort, "127.0.0.1", () => {
      logger.info({ appUiPort }, "App UI origin listening");
    })
    .on("error", (err) => {
      logger.error({ err, appUiPort }, "App UI origin failed to start");
    });
}

import http from "http";
import app from "./app";
import { logger } from "./lib/logger";
import { createShellWss } from "./routes/shell";
import { ensureDefaultVm } from "./lib/vm-registry";
import { reconcileOrphans } from "./lib/vm-launch";
import { createDisplayWss } from "./lib/vm-display";

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
  })
  .catch((err) => logger.error({ err }, "Failed to initialize default VM"));

// Bind to loopback by default (127.0.0.1) so the API is only reachable
// from the local machine. The Electron app and Vite dev proxy both connect
// from localhost, so this is safe. Override with HOST env for dev tunnels.
const host = process.env["HOST"] ?? "127.0.0.1";

server.listen(port, host, () => {
  logger.info({ port, host }, "Server listening");
});

server.on("error", (err) => {
  logger.error({ err }, "Server error");
  process.exit(1);
});

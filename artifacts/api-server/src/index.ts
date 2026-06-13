import http from "http";
import app from "./app";
import { logger } from "./lib/logger";
import { createShellWss } from "./routes/shell";

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

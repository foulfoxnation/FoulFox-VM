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

server.listen(port, () => {
  logger.info({ port }, "Server listening");
});

server.on("error", (err) => {
  logger.error({ err }, "Server error");
  process.exit(1);
});

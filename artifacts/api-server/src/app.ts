import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import path from "path";
import fs from "fs";
import router from "./routes";
import { logger } from "./lib/logger";
import { SHELL_SESSION_TOKEN } from "./lib/shell-token";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return { id: req.id, method: req.method, url: req.url?.split("?")[0] };
      },
      res(res) {
        return { statusCode: res.statusCode };
      },
    },
  }),
);

// CORS: allow same-origin and localhost origins only
const localCors = cors({
  origin: (origin, cb) => {
    if (
      !origin ||
      origin === "null" ||
      /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
    ) {
      cb(null, true);
    } else {
      cb(null, false);
    }
  },
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Shell-Token", "X-Odysseus-Internal-Token"],
});

// ── Middleware helpers ─────────────────────────────────────────────────────────

function localhostOnly(req: Request, res: Response, next: NextFunction) {
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
}

// ── Shell token CSRF protection ───────────────────────────────────────────────
// Prevents malicious web pages from using XHR/fetch against the loopback API.
// Accepts:
//   a) X-Shell-Token: <session_token>  — from browser/Electron frontend
//   b) X-Odysseus-Internal-Token: <odysseus_internal_token> — from Odysseus Python tools
//      (Odysseus adds this header automatically to all internal loopback calls)
const ODYSSEUS_BRIDGE_TOKEN = process.env["ODYSSEUS_INTERNAL_TOKEN"];

function requireShellToken(req: Request, res: Response, next: NextFunction) {
  const shellToken = req.headers["x-shell-token"] ?? req.query["token"];
  if (shellToken === SHELL_SESSION_TOKEN) {
    next();
    return;
  }
  // Accept Odysseus's internal token as an alternative (Odysseus tool calls)
  const odysseusToken = req.headers["x-odysseus-internal-token"];
  if (ODYSSEUS_BRIDGE_TOKEN && odysseusToken === ODYSSEUS_BRIDGE_TOKEN) {
    next();
    return;
  }
  logger.warn({ url: req.url }, "Rejected shell request: invalid token");
  res.status(401).json({ error: "Missing or invalid shell session token" });
}

// ── VM mutation CSRF protection ───────────────────────────────────────────────
// State-changing VM endpoints also require the shell token to prevent
// browser-based CSRF attacks against VM lifecycle operations.
function requireVmToken(req: Request, res: Response, next: NextFunction) {
  // Read-only methods don't need CSRF protection
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
    next();
    return;
  }
  const shellToken = req.headers["x-shell-token"] ?? req.query["token"];
  if (shellToken === SHELL_SESSION_TOKEN) {
    next();
    return;
  }
  const odysseusToken = req.headers["x-odysseus-internal-token"];
  if (ODYSSEUS_BRIDGE_TOKEN && odysseusToken === ODYSSEUS_BRIDGE_TOKEN) {
    next();
    return;
  }
  logger.warn({ url: req.url, method: req.method }, "Rejected VM mutation: invalid token");
  res.status(401).json({ error: "Missing or invalid session token for VM mutation" });
}

// Apply localhost + token checks to shell execution endpoints
app.use("/api/shell/exec", localhostOnly, requireShellToken);
app.use("/api/shell/history", localhostOnly);

// File explorer + USB frontload endpoints: localhost + token (powerful FS access)
app.use("/api/files", localhostOnly, requireShellToken);

// All VM endpoints: localhost only. requireVmToken lets read-only GET/HEAD
// through (status, list, capabilities, provision SSE) but requires the session
// token for every state-changing call — including the multi-VM create/lifecycle
// and per-VM (/api/vm/:id/...) routes.
app.use("/api/vm", localhostOnly, requireVmToken);

// Shell session token endpoint — localhost only so remote callers can't obtain it
app.get("/api/shell/session-token", localhostOnly, (_req, res) => {
  res.json({ token: SHELL_SESSION_TOKEN });
});

app.use(localCors);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

// ── Static shell serving (appliance / packaged mode) ──────────────────────────
// In the Replit dev workspace the shell is served by Vite, so this stays off.
// FoulFox OS sets SERVE_SHELL_STATIC=1 so a single origin serves the built
// shell + the /api routes + the Odysseus proxy (keeping same-origin /api calls
// working without the Vite dev proxy). SHELL_STATIC_DIR overrides the location.
if (process.env["SERVE_SHELL_STATIC"]) {
  const shellDir =
    process.env["SHELL_STATIC_DIR"] ??
    path.resolve(__dirname, "../../odysseus-shell/dist/public");
  if (fs.existsSync(path.join(shellDir, "index.html"))) {
    app.use(express.static(shellDir));
    // SPA fallback: any non-/api GET returns index.html so client routing works.
    app.get(/^\/(?!api\/).*/, (_req: Request, res: Response) => {
      res.sendFile(path.join(shellDir, "index.html"));
    });
    logger.info({ shellDir }, "Serving built shell from api-server");
  } else {
    logger.warn(
      { shellDir },
      "SERVE_SHELL_STATIC is set but no index.html was found; build the shell first",
    );
  }
}

export default app;

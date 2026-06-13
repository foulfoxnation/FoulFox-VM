import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
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

// VM mutation endpoints: localhost + token
app.use("/api/vm/start", localhostOnly, requireVmToken);
app.use("/api/vm/stop", localhostOnly, requireVmToken);
app.use("/api/vm/restart", localhostOnly, requireVmToken);
app.use("/api/vm/snapshot", localhostOnly, requireVmToken);
app.use("/api/vm/config", localhostOnly, requireVmToken);

// Shell session token endpoint — localhost only so remote callers can't obtain it
app.get("/api/shell/session-token", localhostOnly, (_req, res) => {
  res.json({ token: SHELL_SESSION_TOKEN });
});

app.use(localCors);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

export default app;

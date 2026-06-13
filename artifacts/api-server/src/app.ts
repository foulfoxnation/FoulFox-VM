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
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

// CORS: allow same-origin and localhost origins only
const localCors = cors({
  origin: (origin, cb) => {
    if (!origin || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) || origin === "null") {
      cb(null, true);
    } else {
      cb(null, false);
    }
  },
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Shell-Token"],
});

// ── Middleware: restrict to localhost socket ───────────────────────────────────
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

// ── Middleware: require X-Shell-Token header (CSRF protection) ─────────────────
// Prevents malicious web pages from using fetch/XHR to trigger shell commands
// against the loopback API server (a common localhost-attack pattern).
function requireShellToken(req: Request, res: Response, next: NextFunction) {
  const provided = req.headers["x-shell-token"] ?? req.query["token"];
  if (provided !== SHELL_SESSION_TOKEN) {
    logger.warn({ url: req.url }, "Rejected shell request: missing or invalid X-Shell-Token");
    res.status(401).json({ error: "Missing or invalid shell session token" });
    return;
  }
  next();
}

// Apply localhost + token checks to shell execution endpoints
app.use("/api/shell/exec", localhostOnly, requireShellToken);
app.use("/api/shell/history", localhostOnly);

// Shell token endpoint — returns the session token for the UI to store.
// localhost-only so remote callers cannot obtain it.
app.get("/api/shell/session-token", localhostOnly, (_req, res) => {
  res.json({ token: SHELL_SESSION_TOKEN });
});

app.use(localCors);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

export default app;

import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

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

// Public CORS for non-sensitive routes (Odysseus proxy, VM status, health)
const publicCors = cors({
  origin: (origin, cb) => {
    // Allow same-origin (no origin header), localhost, and Replit dev domains
    if (!origin || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      cb(null, true);
    } else {
      cb(null, false);
    }
  },
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
});

// Strict middleware for shell/exec — localhost requests only (no remote access)
function localhostOnly(req: Request, res: Response, next: NextFunction) {
  const remoteAddr = req.socket.remoteAddress;
  const isLocal = remoteAddr === "127.0.0.1" || remoteAddr === "::1" || remoteAddr === "::ffff:127.0.0.1";
  if (!isLocal) {
    res.status(403).json({ error: "Shell execution is only accessible from localhost" });
    return;
  }
  next();
}

// Apply localhost-only restriction to command execution routes
app.use("/api/shell/exec", localhostOnly);
app.use("/api/shell/ws", localhostOnly);

app.use(publicCors);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

export default app;

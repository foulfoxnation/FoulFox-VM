import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import path from "path";
import fs from "fs";
import router from "./routes";
import { logger } from "./lib/logger";
import { SHELL_SESSION_TOKEN } from "./lib/shell-token";
import appUiRouter from "./routes/app-ui";
import appBrokerRouter from "./routes/app-broker";
import { isManagedAppPeer } from "./lib/app-runner";

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
  // Same-origin requests (no Origin header) and explicit localhost origins only.
  // Opaque origins (Origin: null) are intentionally NOT allowed: the in-shell
  // browser renders fetched pages in a sandboxed (no allow-same-origin) iframe
  // whose scripts run with Origin: null, and such a page must never be able to
  // read a loopback API response (e.g. the shell session token) cross-origin.
  origin: (origin, cb) => {
    // The dedicated app-UI origin (APP_UI_PORT, appliance mode) is explicitly
    // excluded: installed-app JS runs there and must not be able to CORS-read
    // any shell API response — the origin split exists precisely so apps and
    // the shell share no readable surface.
    const appUiPort = process.env["APP_UI_PORT"] ?? "8081";
    if (
      !origin ||
      (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) &&
        !origin.endsWith(`:${appUiPort}`))
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

// ── State-change CSRF protection ──────────────────────────────────────────────
// State-changing endpoints (VM lifecycle, OS live-updates) also require the shell
// token to prevent browser-based CSRF against them. Read-only GET/HEAD pass.
function requireStateChangeToken(req: Request, res: Response, next: NextFunction) {
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
  logger.warn({ url: req.url, method: req.method }, "Rejected state-changing request: invalid token");
  res.status(401).json({ error: "Missing or invalid session token" });
}

// Apply localhost + token checks to shell execution endpoints
app.use("/api/shell/exec", localhostOnly, requireShellToken);
app.use("/api/shell/history", localhostOnly);

// File explorer + USB frontload endpoints: localhost + token (powerful FS access)
app.use("/api/files", localhostOnly, requireShellToken);

// All VM endpoints: localhost only. requireStateChangeToken lets read-only
// GET/HEAD through (status, list, capabilities, provision SSE) but requires the
// session token for every state-changing call — including the multi-VM
// create/lifecycle and per-VM (/api/vm/:id/...) routes.
app.use("/api/vm", localhostOnly, requireStateChangeToken);

// OS live-update endpoints: localhost only. The GET status under this prefix
// passes through; the apply/rollback POSTs require the shell token (they drive
// foulfox-patcher via sudo). /api/os/app-update-info is intentionally NOT here —
// it is a public read-only probe like /api/os/release-info.
app.use("/api/os/update", localhostOnly, requireStateChangeToken);
app.use("/api/os/disk-install", localhostOnly, requireStateChangeToken);

// Service restart ("Retry Setup") + boot diagnostics: localhost only. The
// restart POST drives systemctl/first-run via sudo, so it needs the shell
// token; the diagnostics GET (journal tails) passes with localhostOnly via
// requireStateChangeToken's read-only exemption.
app.use("/api/os/restart-services", localhostOnly, requireStateChangeToken);
app.use("/api/os/diagnostics", localhostOnly, requireStateChangeToken);

// Power management: localhost only, shell token required (these are destructive).
app.use("/api/power", localhostOnly, requireStateChangeToken);

// In-shell web browser. All endpoints are localhost only. The proxy GET is
// authorized by its own HttpOnly cookie (an iframe navigation can't send a
// header), while the cookie-issuing /session and the Chromium /launch POST
// require the shell token. /proxy + /capabilities pass with localhostOnly alone.
app.use("/api/browser", localhostOnly);
app.use("/api/browser/session", requireShellToken);
app.use("/api/browser/launch", requireShellToken);
app.use("/api/browser/open", requireShellToken);

// Hardware/peripheral endpoints: localhost only, with requireStateChangeToken
// letting read-only GETs (capabilities/status/list/scan) through while requiring
// the shell token for every state-changing POST (wifi connect/forget, USB
// attach/detach, Bluetooth power/scan/pair/connect/trust/remove).
app.use("/api/network", localhostOnly, requireStateChangeToken);
app.use("/api/usb", localhostOnly, requireStateChangeToken);
app.use("/api/bluetooth", localhostOnly, requireStateChangeToken);

// Local model connection endpoints: localhost only. requireStateChangeToken lets
// the read-only GET (list endpoints) through but requires the shell token for the
// state-changing test/create POSTs. These routes inject the privileged Odysseus
// internal token upstream, so the browser-facing side must stay token-gated.
app.use("/api/local-model", localhostOnly, requireStateChangeToken);

// Storage setup: localhost only. requireStateChangeToken lets the read-only GET
// (the sizing recommendation) through while requiring the shell token for the
// state-changing POSTs (applying VM sizing, and — Phase 2 — driving the
// privileged partitioner via sudo).
app.use("/api/setup", localhostOnly, requireStateChangeToken);

// FoulFox App UI proxy: localhost only, NO shell token — an iframe navigation
// and its subresources can't carry custom headers. It can only reach a running
// app's own loopback server; the broker token never transits this path. Mounted
// before express.json() so request bodies stream through untouched.
//
// SECURITY: on the appliance (SERVE_SHELL_STATIC set) app UIs are served ONLY
// from the dedicated loopback origin (see appUiApp in index.ts / APP_UI_PORT),
// never from the shell origin. If untrusted app JS ran same-origin with the
// shell it could read /api/shell/session-token and escalate to every
// token-gated endpoint. In the Replit dev workspace there is no second
// reachable origin, so the same-origin mount stays — but the shell then embeds
// it WITHOUT allow-same-origin (opaque origin), which blocks that read.
const APP_UI_SEPARATE_ORIGIN = !!process.env["SERVE_SHELL_STATIC"];
if (!APP_UI_SEPARATE_ORIGIN) {
  app.use("/api/apps", localhostOnly, appUiRouter);
}

// Tells the shell where to embed app UIs from: a distinct loopback origin on
// the appliance (privilege separation), or null in dev (same-origin path with
// an opaque-sandboxed iframe).
app.get("/api/apps/ui-base", localhostOnly, (_req, res) => {
  res.json({
    base: APP_UI_SEPARATE_ORIGIN
      ? `http://127.0.0.1:${process.env["APP_UI_PORT"] ?? "8081"}`
      : null,
  });
});

// FoulFox App broker (spec §5): localhost only, authenticated by each app's
// per-boot bearer token (Authorization header), NOT the shell token — the
// caller is the app's backend process, not the browser. Capability checks are
// enforced inside the router. Needs its own json() since it precedes the
// global body parsers.
app.use("/api/apps", localhostOnly, express.json(), appBrokerRouter);

// FoulFox App fetch/install/runtime: localhost only. requireStateChangeToken
// lets the read-only GETs (list / install status / logs / run status) through
// while requiring the shell token for state changes (install, start/stop,
// uninstall).
app.use("/api/apps", localhostOnly, requireStateChangeToken);

// Shell session token endpoint — localhost only so remote callers can't obtain
// it. Additionally REFUSED to managed app processes (socket-peer check via
// /proc): installed apps run on the same loopback interface but must only ever
// hold their per-boot broker token, never the shell session token.
app.get("/api/shell/session-token", localhostOnly, (req, res) => {
  if (isManagedAppPeer(req.socket.remotePort)) {
    res.status(403).json({ error: "App processes cannot obtain the shell session token." });
    return;
  }
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

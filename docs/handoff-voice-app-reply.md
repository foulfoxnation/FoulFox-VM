# Reply: FoulFox App runtime for hands-free voice — rev2 security hardening (final)

Status: **implemented on main and verified** (18/18 E2E checks pass, see
`artifacts/api-server/scripts/e2e-dummy-app.sh`).

## What the runtime guarantees

- **Supervised start**: `start` is an argv array spawned without a shell, cwd
  confined to the app repo dir. Contract env injected: `<portEnv>`, `<dataEnv>`,
  `FOULFOX_APP_ID`, `FOULFOX_APP_TOKEN` (per-boot broker credential, backend
  only), `FOULFOX_API_BASE`, `OLLAMA_BASE_URL`.
- **Health**: `/healthz` polled every 2s; generous first-boot budget (models may
  compile), enforced for real — a process that never turns healthy is killed.
- **Crash restarts**: exponential backoff 1s → 30s, counter resets after 60s of
  health, **max 8 consecutive restarts** then honest give-up (UI shows crashed +
  last exit; manual Start retries).
- **Ports**: fixed loopback range **27000–27199** (predictable for firewall
  rules and socket attribution).
- **OOM**: `oom_score_adj -300` best effort so voice engines are not the
  kernel's first victims.
- **Autostart** on api-server boot; **stopAllApps on shutdown** (SIGTERM/SIGINT
  → graceful stop of every managed app, SIGKILL after grace).

## Security model (rev2)

- **Dedicated app-UI origin**: on the appliance, app UIs are served only from a
  separate loopback origin (`APP_UI_PORT`, default **8081**; the rev2 draft said
  8090 — same architecture, different number). The iframe keeps
  `allow-same-origin` (Chromium getUserMedia constraint) but app JS is
  same-origin only with the UI-proxy server, never with the shell API. Main API
  CORS excludes the app-UI origin. In dev (single origin) the iframe is
  opaque-sandboxed instead.
- **Session-token denial to apps**: `/api/shell/session-token` refuses managed
  app processes via a `/proc` socket-peer check (peer port → socket inode →
  fd scan across the app's process tree, descendants included). Fail-open on
  parse errors so the real shell is never locked out.
- **Foreign-Origin write rejection**: non-GET/HEAD requests through the app-UI
  proxy are refused (403) unless the Origin is absent (non-browser), loopback,
  or — dev only — the Replit preview origin / opaque (`null`) dev iframe.
  `Origin: null` is **rejected in appliance mode**.
- **No body parsers** on the app-UI path (mounted before `express.json()`);
  uploads and JSON posts stream through untouched, no shell token required
  (iframe subresources cannot carry custom headers).
- **Kiosk policy**: managed Chromium policy grants mic + autoplay to
  `127.0.0.1/localhost` on **8080 and 8081** only, plus
  `--autoplay-policy=no-user-gesture-required` in the kiosk launcher.

## E2E coverage (`scripts/e2e-dummy-app.sh`)

Install-from-zip → token-gated start → running via healthz → port-range check →
GET + tokenless POST through the proxy → foreign-Origin POST refused →
loopback-Origin POST allowed → **app process denied the session token (403 from
inside the app)** → kill -9 → automatic restart observed → CORS refusal on the
main API → stop → uninstall. 18/18 pass in the dev workspace.

## Deviations from the rev2 draft

- App-UI origin port is **8081** (not 8090) — established on main first; the
  kiosk policy and CORS exclusions already reference it.
- Upstream-only features kept: zip upload + install-from-file (flash drive)
  routes.

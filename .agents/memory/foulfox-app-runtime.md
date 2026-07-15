---
name: FoulFox app runtime
description: Installed-app runtime (supervisor, UI proxy, broker) — security model and dev-vs-appliance gotchas
---

# FoulFox app runtime (installed "FoulFox Apps")

## Origin split is load-bearing (privilege separation)
Untrusted app UIs must NEVER be same-origin with the shell API: with
`allow-same-origin` an app iframe could read `GET /api/shell/session-token`
(localhost-only, no token) and escalate to every token-gated endpoint.
- **Appliance mode** (`SERVE_SHELL_STATIC` set): app UIs served ONLY from a
  dedicated loopback origin `http://127.0.0.1:${APP_UI_PORT:-8081}` (second
  express server in api-server index.ts, same `/api/apps/:id/ui` path so the
  proxy shim works unchanged). The shell-origin ui mount is NOT registered.
  Iframe uses `allow-same-origin` (mic works via kiosk policy for :8081).
- **Dev** (Replit preview): second port unreachable → same-origin path stays,
  but the iframe drops `allow-same-origin` (opaque origin). Consequence: app
  UI JS fetches are CORS-blocked in dev preview (static HTML renders; that's
  the accepted tradeoff — mic/hands-free is appliance-only anyway).
- Shell asks `GET /api/apps/ui-base` which origin to embed from (null = dev).
- shell localCors explicitly EXCLUDES the `:8081` origin, and the
  session-token route is registered BEFORE the cors middleware — keep both.
- Kiosk chromium policy `foulfox-media.json` must list BOTH 8080 and 8081
  origins for mic/autoplay.

## Runner invariants
- `startApp` has an in-flight promise-dedupe map (concurrent starts would
  otherwise double-spawn).
- Health budget (10 min) is enforced by SIGKILL on timeout (exit handler then
  restarts with backoff) — don't regress to log-only.
- Per-boot broker token; `ODYSSEUS_INTERNAL_TOKEN` is stripped from app env.

## Dev broker E2E
Broker `agent.task` → Odysseus `/api/v1/chat` needs the SHARED
`ODYSSEUS_INTERNAL_TOKEN` env in BOTH workflows; in dev it's a development-env
var (set 2026-07). Without a configured model endpoint the task returns an
honest error status — that's expected in dev (no Ollama).

## Test-app gotcha
`foxapp.json` requires `schemaVersion: 1` or install-zip rejects it.

---
name: Odysseus embedding architecture
description: How the bundled Odysseus FastAPI app is run and embedded in the Odysseus VM shell.
---

# Embedding the bundled Odysseus app

`artifacts/odysseus-service` is a vendored copy of the upstream Odysseus FastAPI
app. It runs on port 7000 (`start.sh`) and is shown inside the odysseus-shell web
app via an iframe pointed at `/api/odysseus/`, proxied by the Express api-server
(`artifacts/api-server/src/routes/odysseus-proxy.ts`).

## Local SQLite, not the workspace Postgres
Odysseus reads `DATABASE_URL` and defaults to `sqlite:///{DATA_DIR}/app.db`. The
Replit workspace sets `DATABASE_URL` to its Postgres (used by api-server), which
leaks in and makes Odysseus demand `psycopg2`.
**Rule:** `start.sh` must `unset DATABASE_URL` so Odysseus uses its own local
SQLite store. **Why:** Odysseus is a self-contained desktop agent; sharing the
api-server's Postgres is wrong and pulls in an unneeded driver.

## Port binding for the workflow
The workflow has `waitForPort = 7000`. uvicorn binding to `127.0.0.1` is NOT
detected by Replit's port checker, so the workflow times out even though the app
is up. **Rule:** in the Replit workspace (`$REPL_ID`/`$REPLIT_DEV_DOMAIN` set)
bind `HOST=0.0.0.0`; keep `127.0.0.1` for packaged Electron builds.

## Dev vs packaged Python env
In the workspace, `start.sh` must use the system `python3` (deps live in
`.pythonlibs`). Creating a venv (the packaged-build path) would hide those deps.
Gate the venv branch on Replit env vars being absent.

## Root-absolute URL rewriting in the proxy
Odysseus serves HTML/CSS/JS with root-absolute URLs (`/static/...`, and JS sets
`API_BASE = window.location.origin` so API calls are origin-absolute `/api/...`).
Inside an iframe served at `/api/odysseus/`, these resolve against the shell root
and 404. The proxy fixes this by (identity-encoding the upstream — it strips
`accept-encoding` to defeat gzip — then):
- rewriting HTML `src/href/action="/..."` to relative (resolve under the prefix),
- injecting a runtime shim that prefixes fetch/XHR/EventSource URLs with the proxy
  prefix (computed from `location.pathname`) and disables service-worker
  registration,
- rewriting CSS `url(/...)` to depth-correct `../` relative paths.
**Why:** a `<base>` tag does NOT fix root-absolute URLs, and the browser-facing
prefix (vite/Replit layers) isn't reliably known server-side, so relative +
client-computed prefix is base-path agnostic.

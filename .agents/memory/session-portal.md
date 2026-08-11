---
name: FoulFox Session Portal
description: Architecture decisions, auth wiring, and known pitfalls for the Session Portal artifact (artifacts/session-portal).
---

# FoulFox Session Portal

## What it is
A standalone always-dark RDP-like portal at `/session-portal/`. Shows machine info, running VMs (noVNC display), an interactive terminal (xterm.js), and a live log stream (SSE). Shareable via view-only tokens.

## Auth chain (CRITICAL)
1. Frontend calls `GET /api/shell/session-token` (no auth needed) → gets `shellToken`.
2. Calls `setDefaultHeaders({ 'X-Shell-Token': shellToken })` from `@workspace/api-client-react` to inject the token into all generated-client requests.
3. Passes `token: shellToken` as a query param to `useGetSessionInfo()`.
4. WS connections (terminal, VNC) use the shell token or per-VM display token as `?token=...` query params.
5. If a `?token=` URL param is present (shareable view link): use it for VNC + SSE; still fetch a fresh shell token for terminal WS.

**Why:** `useGetSessionInfo` runs before the async shell-token fetch resolves, so it must be `enabled: !!sessionToken` and only fire once a token is available.

## Backend endpoints added
- `GET /api/session/info` — machine info + VM list + WS paths; accepts shell token OR view token
- `POST /api/session/view-token` — requires shell token; returns `{ token, expiresAt, sessionUrl }` (2h TTL)
- `GET /api/shell/logs/stream` — SSE log stream (journalctl -f or /tmp/odysseus.log fallback); accepts shell token OR view token
- `GET /api/vm/ws/display` — updated to also accept valid view tokens (not just per-VM display tokens)

## Key modules
- `artifacts/api-server/src/lib/view-tokens.ts` — shared in-memory view token store + `isValidViewToken()`
- `artifacts/api-server/src/routes/session.ts` — session info + view token routes

## noVNC pin (from existing memory)
Must pin `@novnc/novnc@1.4.0` and import from `@novnc/novnc/core/rfb.js`. Already done in session-portal package.json.

## OS: x11vnc
Added to `os/live-build/config/package-lists/foulfox.list.chroot`. Start with `x11vnc -display :0 -localhost -nopw -forever` to expose host desktop VNC for the portal.

**Why:** The session portal's VNC left panel needs a way to show the host desktop (not just VMs) on real FoulFox OS hardware.

## Console tab in main shell
Added `SquareTerminal` icon import + `activeTab === "console"` body + taskbar button to `artifacts/odysseus-shell/src/pages/Home.tsx`. Renders the existing `<Terminal />` component full-height.

---
name: FoulFox diag relay
description: How the appliance streams its logs live to the dev workspace (outbound WS), and the pitfalls found building it.
---

# FoulFox live log relay

The appliance is LAN-only; the workspace can never dial in. The user's design of record: the MACHINE opens an outbound WebSocket to the workspace and streams every Logs-viewer source live. Implemented in api-server `src/lib/diag-relay.ts`:

- Appliance client (gated on SERVE_SHELL_STATIC) connects to `wss://<dev-domain>/api/diag/relay?marker=foulfox-diag-v1` (override/disable via `FOULFOX_RELAY_URL`, value `off` disables) and forwards its own local SSE log streams (`/api/shell/logs/stream`) — so relayed sources always match the portal viewer.
- Workspace sink appends to `.local/machine-logs/<source>.log` (2MB truncate, 64-file cap, 200 lines/s, 64KB maxPayload); `_status.json` shows connected/lastSeen. **Read these files to see the live machine.**
- Strictly one-way: no message from the sink is ever acted on by the appliance.

**Why:** user rejected snapshot phone-home and tunnels; the websocket relay reusing viewer sources is the agreed design.

Gotchas:
- The public dev URL routes `/api/*` (incl. WS upgrades) through the odysseus-shell Vite proxy (`ws:true`) to api-server :8080 — external port 80 maps to Vite, not api-server.
- esbuild bundle rewrites `__dirname` to `dist/` — resolve repo-relative paths from `process.cwd()` in api-server, or files land outside the workspace.
- Reconnect safety needs a connection-generation guard: async follower setup must abort if the socket died during source discovery, else orphan SSE followers leak and double-stream.
- Dev-domain URL is hardcoded as default; a new workspace/domain means updating `DEFAULT_RELAY_URL` or setting `FOULFOX_RELAY_URL` on-device.

## Backpressure & clock skew (Aug 2026)
- The relay client once DROPPED lines silently when the WS send buffer hit 512KB — at (re)connect all ~30 followers dump buffers at once, so high-volume sources (system journal, busy app logs) crowded out one-line diagnostic breadcrumbs from quiet sources (e.g. `Registry: status=...` for a stopped app). Fixed with a bounded FIFO queue (cap 2000, drop-oldest, 250ms flusher) cleared on reconnect.
- **How to apply:** if a quiet source's expected header/breadcrumb lines are missing from `.local/machine-logs/`, suspect congestion at connect, not the source.
- Device clock can be hours behind workspace time (RTC/NTP drift, resets across reboots). Sink line prefixes carry DEVICE timestamps; file mtimes carry workspace receive time. Never compare the two directly when building timelines.

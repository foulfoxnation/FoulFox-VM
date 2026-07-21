---
name: FoulFox app-runtime rev2 security model
description: Security invariants of the installed-app runtime — token isolation, origin separation, peer check — and why each exists.
---

Rules (keep these invariants when touching the app runtime):
- Apps NEVER hold the shell session token — only their per-boot broker token. `/api/shell/session-token` refuses managed-app peers via a /proc socket-peer check (peer port → /proc/net/tcp{,6} inode → fd scan over the app's descendant pid tree). Deliberately fail-open so procfs races can't lock out the real shell.
- App-UI proxy: non-GET/HEAD writes reject foreign Origins. `Origin: null` allowed ONLY in dev (opaque iframe); rejected in appliance mode where iframes are same-origin with the dedicated :8081 origin.
- App-UI origin is :8081 (kiosk policy + CORS exclusions reference it). A rev2 draft said 8090 — do NOT renumber.
- App backend ports are fixed range 27000-27199; restart backoff capped at 8 consecutive crashes (then desired=stop, honest give-up); stopAllApps on SIGTERM/SIGINT.

**Why:** untrusted app JS/backends run on the same loopback as the token-gated shell API; origin + token separation is the entire privilege boundary.
**How to apply:** run `BASE=http://localhost:80 bash artifacts/api-server/scripts/e2e-dummy-app.sh` (18 checks, incl. in-app token denial and kill-9 crash-restart) after any runtime/proxy/auth change.

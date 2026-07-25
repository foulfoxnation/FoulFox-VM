---
name: Shell token rotation self-healing
description: api-server restarts mint a NEW shell session token; frontend must refresh + retry, never cache forever
---

The api-server generates a new random SHELL_SESSION_TOKEN on every start (unless pre-seeded via env). Anything that restarts it on the appliance — "Retry Setup", live app updates — instantly invalidates every token the frontend has cached, and all protected POSTs (WiFi, Bluetooth, power, VM, apps) fail with 401 "Missing or invalid session token" until a page refresh.

**Why:** hit on real hardware — user pressed Retry Setup while offline, then couldn't connect WiFi or use Bluetooth at all.

**How to apply:** all state-changing frontend calls must go through `authedFetch()` in `odysseus-shell/src/lib/shell-token.ts` (caches the token, refreshes on 401 and retries once, keeps the generated api-client's default headers in sync). Never hand-plumb `useShellToken()` data into fetch headers or pin per-request tokens (they go stale); never gate buttons on `!token`. After triggering a service restart, schedule `refreshShellToken()`.

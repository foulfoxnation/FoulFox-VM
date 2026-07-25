---
name: api-server route prefix pitfall
description: Routers are mounted at /api — route paths must NOT repeat the /api prefix
---

`routes/index.ts` aggregates all routers and app.ts mounts it at `/api`. Individual routers must define paths WITHOUT the `/api` prefix (e.g. `/vm/list`, `/network/status`).

**Why:** power.ts and service-restart.ts once defined `/api/power/...` and `/api/os/restart-services` → served at `/api/api/...` → every request 404'd forever, and the UI toasted success anyway, so it shipped broken to real hardware.

**How to apply:** when adding a router, copy the path convention from vm.ts/network.ts (no `/api`), and smoke-test the endpoint with curl on localhost:8080. Also: UI must gate success toasts on the actual response, and destructive backends should report real command results (see power.ts).

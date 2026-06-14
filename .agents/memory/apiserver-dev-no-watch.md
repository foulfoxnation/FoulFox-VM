---
name: api-server dev is build+start (no watch)
description: Backend code changes don't hot-reload; you must restart the workflow
---
`artifacts/api-server` dev script is `pnpm run build && pnpm run start` (esbuild bundles to `dist/` via build.mjs, then `node dist/index.mjs`). There is NO file watcher. After editing any api-server source, the running process keeps serving the OLD bundle — new routes silently 404 and changed responses return stale shapes — until you restart the `artifacts/api-server: API Server` workflow.

**Why:** caused a confusing cycle where new `/api/vm/*` routes 404'd and `/api/vm/capabilities` returned the old JSON shape even though the code was correct and typechecked clean.
**How to apply:** always restart the API Server workflow after backend edits before testing endpoints (curl or UI). Contrast with the web (Vite) workflow, which DOES hot-reload.

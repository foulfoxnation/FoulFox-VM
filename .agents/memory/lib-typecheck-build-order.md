---
name: Lib typecheck build order (stale dist .d.ts)
description: Why a per-artifact tsc --noEmit can report phantom "property does not exist" errors after codegen/merge, and how to fix it.
---

# Per-artifact typecheck reads stale lib `dist/*.d.ts`

`@workspace/*` libs (e.g. `api-zod`, `api-client-react`) export from `./src`,
but artifacts consume them through TypeScript **project references**, which
resolve to each lib's built declaration output in `dist/` (which is
**gitignored**, so it is never committed and only exists if someone ran a build).

Running a single artifact's typecheck in isolation —
`pnpm --filter @workspace/<artifact> run typecheck` (i.e. `tsc -p tsconfig.json
--noEmit`) — does **not** rebuild referenced libs. If the lib `src` changed
(e.g. orval regenerated `ExecShellCommandBody` to add a `vm` field) but its
`dist/*.d.ts` is stale, the artifact typecheck reports phantom errors like
`Property 'vm' does not exist on type '{ command: string; ... }'` even though the
source is correct.

**Fix:** rebuild the lib declarations first, then typecheck the artifact:
`pnpm run typecheck:libs` (= `tsc --build`) regenerates every lib's `dist`.

**Why:** runtime is unaffected (api-server esbuild bundles straight from lib
`src`), and the merge agent's full `pnpm run typecheck` passed because the root
script runs `typecheck:libs` before per-artifact checks — so the stale-dist
failure only shows up when you typecheck one artifact standalone.

**How to apply:** after any OpenAPI/orval codegen, or after merging a task that
changes generated types, run `pnpm run typecheck:libs` (or `pnpm --filter
@workspace/api-spec run codegen`, which ends with it) before trusting a single
artifact's typecheck. Post-merge `db push` (drizzle schema pull) also runs ~100s
here, so the post-merge timeout must stay generous (≥120s) and use the
non-interactive `push-force` (stdin is closed during post-merge).

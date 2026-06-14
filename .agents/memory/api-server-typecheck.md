---
name: api-server typecheck (project refs)
description: Why a cold api-server typecheck times out and the build-refs-first workaround.
---

# api-server typecheck times out cold

Running `pnpm --filter @workspace/api-server run typecheck` (which is `tsc -p tsconfig.json --noEmit`) on a cold tree can exceed 120s and time out, because tsc has to build the upstream TypeScript **project references** (`@workspace/db`, `@workspace/api-zod`) from scratch in the same pass.

**Workaround:** build the referenced projects first, then typecheck:
```
pnpm --filter @workspace/db --filter @workspace/api-zod exec tsc -b
pnpm --filter @workspace/api-server run typecheck
```
With the refs' `.tsbuildinfo` warm, the api-server typecheck finishes in a few seconds (EXIT 0).

**Why:** the monorepo uses TS project references; a cold incremental graph is the slow part, not the api-server sources themselves.

**How to apply:** any time you need to verify api-server types, run the `tsc -b` on the deps first. Re-running is cheap once the build cache exists.

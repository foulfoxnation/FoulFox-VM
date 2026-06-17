---
name: FoulFox OS ISO build (CI)
description: How the GitHub "Build FoulFox OS ISO" workflow builds the app, and the non-obvious traps (pnpm pinning, internal-packages libs, can't build locally).
---

# FoulFox OS ISO build (GitHub Actions)

Chain: `.github/workflows/build-foulfox-os.yml` → `os/scripts/build-image.sh`
→ `stage-app.sh` (pnpm install + build shell/api artifacts + rsync into the
live-build chroot) → `validate-layout.sh` → Debian `live-build` (the long,
multi-GB stage). A failure in ~2 min is BEFORE live-build, i.e. in install or
the artifact builds.

## Pin pnpm — never `corepack prepare pnpm@latest`
**Rule:** pin pnpm to the version that generated `pnpm-lock.yaml` via BOTH
`package.json` `"packageManager": "pnpm@<x.y.z>"` and
`corepack prepare pnpm@<x.y.z> --activate` in the workflow.
**Why:** `pnpm@latest` on a clean runner can be a newer MAJOR than the lockfile
(e.g. npm `latest` was 11.x while the lockfile was made by 10.26.1). The
lockfile-format mismatch makes `pnpm install --frozen-lockfile` fail fast — a
classic ~2-min clean-checkout failure that never reproduces where pnpm is older.
**How to apply:** if CI install fails on a fresh checkout but local works, check
the pnpm major first; keep package.json + workflow versions in lockstep.

## `@workspace/*` libs are "internal packages" (export raw src)
**Rule:** `lib/db`, `lib/api-zod`, `lib/api-client-react` export
`./src/index.ts` UNCONDITIONALLY; all generated sources (orval, schema) are
committed. Vite (shell) and esbuild (api-server) bundle from that SRC, not from
the libs' `dist/`. `tsc --build` (root `typecheck:libs`) emits ONLY `.d.ts` to
each lib's gitignored `dist/`.
**Why:** so do NOT assume "artifact build fails because lib dist is missing" —
the bundlers don't consume lib dist. Building libs first (tsc --build) validates
types and emits declarations, but is not what makes the bundlers succeed.
**How to apply:** for a clean-checkout artifact-build failure, suspect the
bundler/install path (pnpm pin, or a production-only `vite build` error that dev
never exercises), not missing lib output.

## live-build defaults to UBUNTU mode on the `ubuntu-latest` runner
**Rule:** a Debian (bookworm) live recipe MUST explicitly pass `--mode debian`
PLUS explicit Debian mirrors (`--mirror-bootstrap/-chroot/-binary` →
`http://deb.debian.org/debian/`, `-security` → `http://security.debian.org/debian-security/`)
in `auto/config`, and the workflow must `apt-get install debian-archive-keyring`.
**Why:** GitHub's `ubuntu-latest` ships `/etc/live/build.conf` with the Ubuntu
defaults, so without `--mode debian` live-build builds a "ubuntu/amd64 system"
and debootstrap tries to fetch the Debian suite `bookworm` from
`archive.ubuntu.com` → `E: Failed getting release file .../dists/bookworm/Release`
→ no base system → no ISO. The keyring is needed to verify Debian's Release sig.
**How to apply:** never rely on live-build's host-derived mode/mirror defaults in
CI; pin them. This only surfaces once the corepack/pnpm step passes (earlier runs
died before `lb build` ever ran).

## Debian security pocket: runner's live-build emits the OBSOLETE suite
**Rule:** do NOT rely on live-build's built-in security source on the CI runner.
Set `--security false` in `auto/config` and ship the correct security repo via
`config/archives/debian-security.list.chroot` + `.list.binary` containing
`deb http://security.debian.org/debian-security bookworm-security <areas>`.
**Why:** the Ubuntu-shipped live-build on `ubuntu-latest` predates Debian's
bullseye-era rename of the security suite, so it auto-generates the pre-Debian-11
name `bookworm/updates` → `404 Not Found` / `does not have a Release file` → the
chroot `apt update` aborts with `exit code 100`. Since Debian 11 the pocket is
`<dist>-security`, not `<dist>/updates`. This only surfaces AFTER `--mode debian`
fixes debootstrap (base system installs, then chroot apt fails on security).
**How to apply:** `config/archives/*.list.chroot` survives `lb clean` + `lb config`
(only `lb clean --purge` wipes config/); no key import needed because
`debian-archive-keyring` (installed in the base) already trusts `bookworm-security`.

## live-build wrappers must FAIL LOUDLY (no masked errors)
**Rule:** `auto/build` must use `#!/bin/bash` + `set -euo pipefail` (dash has no
pipefail) so `lb build ... | tee build.log` propagates lb's failure instead of
tee's 0. `build-image.sh` must `exit 1` when no `*.iso` exists, not
`ls *.iso || echo "(none)"` (the echo returns 0 → false green).
**Why:** these two maskings made a failed debootstrap report step #7 "Build the
image" as SUCCESS, with the real failure only surfacing one step later at
"Collect ISO" — confusing and easy to misdiagnose.

## Heavy builds can't run in this repl — verify on CI
**Rule:** with the dev workflows running, this repl is resource-starved; `vite
build`, esbuild bundles, and even `tsc --build` of the 3 tiny libs time out
(>110s) or get OOM-killed. The shell's production `vite build` only ever runs in
CI (dev uses the Vite dev server), so it's an untested path locally.
**How to apply:** don't trust "build hangs locally" as a real bug; validate
statically (`bash -n`, registry checks) and rely on the GitHub runner as the
real build environment.

---
name: FoulFox cloud ISO build (GitHub Actions)
description: How/why the on-demand FoulFox OS .iso is built in CI, and the non-obvious constraints that shaped the design.
---

# FoulFox OS on-demand ISO build

The "click → build latest → download" ISO generator is a GitHub Actions
workflow (`.github/workflows/build-foulfox-os.yml`, `workflow_dispatch` +
`os-v*` tags). It does **not** reimplement the build — it calls
`os/scripts/build-image.sh` as the single source of truth.

**Why CI and not the Replit sandbox:** assembling a bootable live image needs a
privileged amd64 Linux host (chroot, loop mounts, mksquashfs) that a hosted app
sandbox doesn't grant. `ubuntu-latest` is amd64 + allows `sudo`, and matches the
appliance arch — important because `stage-app.sh` bundles compiled native node
modules (node-pty, ssh2) that must match the boot target. Never frame this as a
Replit KVM limitation in anything user-facing.

**Download path — the load-bearing decision:** GitHub **Release assets are
capped at ~2 GiB per file**; a full Debian live desktop image (Chromium, QEMU,
firmware, the staged monorepo) will likely exceed that. So:
- The **Actions run artifact** (timestamped, `compression-level: 0` since a
  squashfs ISO is already compressed) is the *guaranteed* download.
- The rolling `foulfox-os-latest` **release** is a convenience "always-latest"
  link, but it is **size-gated** (only published when ISO < 2 GiB) and runs with
  `continue-on-error: true` so a release hiccup never reds a good build.

**"Latest" means latest pushed-to-GitHub commit.** CI only sees GitHub, so the
repo must be on GitHub (one-time connect via Replit's Git pane) and the user must
commit+push before clicking. The dev sandbox's local checkpoints are not enough.

**No lib pre-build needed for the image build:** workspace libs export from
`./src/*.ts`, so vite/esbuild bundle them from source. (The stale-`dist` gotcha
is `tsc`-only — see lib-typecheck-build-order.md — and the image build does not
typecheck.)

**Upgrade path (not built yet):** an in-app "Generate ISO" button in
odysseus-shell → api-server endpoint → GitHub `workflow_dispatch` via the GitHub
connector (`connector:ccfg_github_*`, was `not_setup`), polling run status and
surfacing the artifact/release link. Keep the token server-side, least-privilege.

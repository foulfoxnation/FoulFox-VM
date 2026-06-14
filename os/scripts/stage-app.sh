#!/usr/bin/env bash
# Build the FoulFox web stack on this host and stage it into the live-build
# chroot includes at config/includes.chroot/opt/foulfox/app.
#
# IMPORTANT: run this on an amd64 Linux host. The staged tree includes compiled
# native Node modules (e.g. node-pty, ssh2 crypto bindings); they must match the
# appliance's architecture (amd64 Linux), so build where you'll boot.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
STAGE="$SCRIPT_DIR/../live-build/config/includes.chroot/opt/foulfox/app"

echo "[stage-app] Repo root: $REPO_ROOT"
cd "$REPO_ROOT"

command -v pnpm >/dev/null 2>&1 || { echo "pnpm not found (corepack enable && corepack prepare pnpm@latest --activate)"; exit 1; }

echo "[stage-app] Installing workspace dependencies..."
pnpm install --frozen-lockfile

# Build/validate the shared @workspace/* libraries (the TypeScript project
# references db, api-zod, api-client-react) before the app artifacts, in
# dependency order. `tsc --build` emits each lib's gitignored dist/ declarations
# and type-checks the libraries, so on a clean CI checkout any library error
# fails fast here -- before the long live-build stage -- instead of surfacing
# later or leaving stale build output.
echo "[stage-app] Building workspace libraries (@workspace/*)..."
pnpm run typecheck:libs

echo "[stage-app] Building the shell (BASE_PATH=/ for same-origin serving)..."
# This is the only place the shell's production Vite/Rollup build runs (dev uses
# the Vite dev server), and the bundle is large -- give Node extra heap headroom.
NODE_OPTIONS=--max-old-space-size=4096 BASE_PATH=/ pnpm --filter @workspace/odysseus-shell run build

echo "[stage-app] Building the api-server..."
pnpm --filter @workspace/api-server run build

echo "[stage-app] Staging into $STAGE ..."
rm -rf "$STAGE"
mkdir -p "$STAGE"

# Copy the whole workspace (preserving pnpm's relative symlinks so the
# api-server's externalized runtime deps resolve) but prune VCS/cache/log cruft
# and avoid recursively copying the staging target into itself.
rsync -a --delete \
  --exclude '.git/' \
  --exclude 'os/live-build/config/includes.chroot/' \
  --exclude '**/.cache/' \
  --exclude '**/.turbo/' \
  --exclude '**/*.log' \
  "$REPO_ROOT/" "$STAGE/"

echo "[stage-app] Done. Staged app at: $STAGE"
echo "[stage-app] Shell:  $STAGE/artifacts/odysseus-shell/dist/public"
echo "[stage-app] API:    $STAGE/artifacts/api-server/dist/index.mjs"

#!/usr/bin/env bash
# One-command FoulFox OS image build.
#
# Two supported environments:
#   * Local/host: an amd64 Debian/Ubuntu host with live-build + pnpm installed.
#       sudo apt install live-build
#       corepack enable && corepack prepare pnpm@latest --activate
#   * CI: the web app is staged on the host (which has the Node/pnpm toolchain),
#     then this script runs INSIDE a privileged debian:bookworm container with
#     FOULFOX_SKIP_STAGE_APP=1 so that `lb` is Debian's own live-build. The
#     Ubuntu runner ships Ubuntu's live-build 3.x, which mis-resolves a Debian
#     bookworm chroot and aborts at lb_chroot_live-packages; Debian's live-build
#     does not. See .github/workflows/build-foulfox-os.yml.
#
# Produces a hybrid ISO under os/live-build/ that boots on BIOS + UEFI and can
# be written to a USB stick (see ../docs/flash.md).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LB_DIR="$SCRIPT_DIR/../live-build"

command -v lb >/dev/null 2>&1 || { echo "live-build not installed: sudo apt install live-build"; exit 1; }

# live-build needs root to manage the chroot. When we're already root (e.g. in
# the CI container) invoke lb directly; otherwise escalate with sudo.
if [ "$(id -u)" -eq 0 ]; then SUDO=(); else SUDO=(sudo); fi

# The web app is built with pnpm/node and staged into the chroot includes. In CI
# that happens on the host (the build container has no Node toolchain), so allow
# skipping it here via FOULFOX_SKIP_STAGE_APP=1.
if [ "${FOULFOX_SKIP_STAGE_APP:-0}" = "1" ]; then
  echo "[build-image] (1/4) Skipping app staging (FOULFOX_SKIP_STAGE_APP=1; staged on host)."
  if [ ! -d "$LB_DIR/config/includes.chroot/opt/foulfox/app" ]; then
    echo "[build-image] ERROR: FOULFOX_SKIP_STAGE_APP=1 but no staged app found at" >&2
    echo "             $LB_DIR/config/includes.chroot/opt/foulfox/app" >&2
    echo "             Run os/scripts/stage-app.sh on the host first." >&2
    exit 1
  fi
else
  command -v pnpm >/dev/null 2>&1 || { echo "pnpm not installed: corepack enable && corepack prepare pnpm@latest --activate"; exit 1; }
  echo "[build-image] (1/4) Staging the web app..."
  "$SCRIPT_DIR/stage-app.sh"
fi

echo "[build-image] (2/4) Validating recipe layout..."
"$SCRIPT_DIR/validate-layout.sh"

echo "[build-image] (3/4) Setting executable bits on scripts + hooks..."
chmod +x "$SCRIPT_DIR"/*.sh
find "$LB_DIR/config/includes.chroot/usr/local/bin" -type f -exec chmod +x {} +
find "$LB_DIR/config/hooks" -type f -exec chmod +x {} +
chmod +x "$LB_DIR"/auto/* 2>/dev/null || true

echo "[build-image] (4/4) Running live-build (needs root for chroot)..."
cd "$LB_DIR"
"${SUDO[@]}" lb clean || true
"${SUDO[@]}" lb config

echo "[build-image] Resolved live-build config (must show Debian, not Ubuntu):"
grep -rhE '^LB_(MODE|DISTRIBUTION|PARENT_DISTRIBUTION|MIRROR_BOOTSTRAP|MIRROR_CHROOT|MIRROR_BINARY|MIRROR_CHROOT_SECURITY|MIRROR_BINARY_SECURITY)=' config/ 2>/dev/null | sort -u || true

"${SUDO[@]}" lb build

echo
echo "[build-image] Done. ISO(s):"
if ! ls -1 "$LB_DIR"/*.iso 2>/dev/null; then
  echo "[build-image] ERROR: no .iso produced — check $LB_DIR/build.log" >&2
  exit 1
fi

#!/usr/bin/env bash
# One-command FoulFox OS image build.
#
# Run on an amd64 Debian/Ubuntu host with live-build installed:
#   sudo apt install live-build
#   corepack enable && corepack prepare pnpm@latest --activate
#
# Produces a hybrid ISO under os/live-build/ that boots on BIOS + UEFI and can
# be written to a USB stick (see ../docs/flash.md).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LB_DIR="$SCRIPT_DIR/../live-build"

command -v lb   >/dev/null 2>&1 || { echo "live-build not installed: sudo apt install live-build"; exit 1; }
command -v pnpm >/dev/null 2>&1 || { echo "pnpm not installed: corepack enable && corepack prepare pnpm@latest --activate"; exit 1; }

echo "[build-image] (1/4) Staging the web app..."
"$SCRIPT_DIR/stage-app.sh"

echo "[build-image] (2/4) Validating recipe layout..."
"$SCRIPT_DIR/validate-layout.sh"

echo "[build-image] (3/4) Setting executable bits on scripts + hooks..."
chmod +x "$SCRIPT_DIR"/*.sh
find "$LB_DIR/config/includes.chroot/usr/local/bin" -type f -exec chmod +x {} +
find "$LB_DIR/config/hooks" -type f -exec chmod +x {} +
chmod +x "$LB_DIR"/auto/* 2>/dev/null || true

echo "[build-image] (4/4) Running live-build (needs root for chroot)..."
cd "$LB_DIR"
sudo lb clean || true
sudo lb config
sudo lb build

echo
echo "[build-image] Done. ISO(s):"
ls -1 "$LB_DIR"/*.iso 2>/dev/null || echo "  (no .iso found — check $LB_DIR/build.log)"

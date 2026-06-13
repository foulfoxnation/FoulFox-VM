#!/usr/bin/env bash
# Sanity-check the FoulFox OS recipe tree without building or booting anything.
# Verifies every required recipe file exists and (if shellcheck is installed)
# lints the shell scripts.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LB="$SCRIPT_DIR/../live-build"
fail=0

need() {
  if [ ! -e "$1" ]; then
    echo "MISSING: ${1#"$SCRIPT_DIR"/../}"
    fail=1
  else
    echo "ok: ${1#"$SCRIPT_DIR"/../}"
  fi
}

need "$LB/auto/config"
need "$LB/auto/build"
need "$LB/auto/clean"
need "$LB/config/package-lists/foulfox.list.chroot"
need "$LB/config/includes.chroot/etc/foulfox/foulfox.env"
need "$LB/config/includes.chroot/etc/systemd/system/foulfox-prepare.service"
need "$LB/config/includes.chroot/etc/systemd/system/odysseus-service.service"
need "$LB/config/includes.chroot/etc/systemd/system/foulfox-api.service"
need "$LB/config/includes.chroot/etc/systemd/system/foulfox-vm-autostart.service"
need "$LB/config/includes.chroot/usr/local/bin/foulfox-first-run"
need "$LB/config/includes.chroot/usr/local/bin/foulfox-kiosk"
need "$LB/config/includes.chroot/usr/local/bin/foulfox-open-vm-viewer"
need "$LB/config/includes.chroot/usr/local/bin/foulfox-vm-autostart"
need "$LB/config/hooks/normal/0010-foulfox-enable-services.hook.chroot"
need "$LB/config/hooks/normal/0020-foulfox-python-venv.hook.chroot"

if command -v shellcheck >/dev/null 2>&1; then
  echo "[validate-layout] Running shellcheck..."
  # Don't fail the whole check on style warnings; surface them for review.
  shellcheck -S warning \
    "$LB"/config/includes.chroot/usr/local/bin/* \
    "$SCRIPT_DIR"/*.sh || true
else
  echo "[validate-layout] shellcheck not installed; skipping lint"
fi

if [ "$fail" = "0" ]; then
  echo "Layout OK"
else
  echo "Layout INCOMPLETE"
  exit 1
fi

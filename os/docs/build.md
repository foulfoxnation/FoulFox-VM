# Building the FoulFox OS image

The image is built with [Debian `live-build`](https://wiki.debian.org/DebianLive)
on an **amd64 Linux host**. You don't need to build on the same machine you'll
run the appliance on, but the host **must be amd64 Linux** because the staged
app includes compiled native Node modules that must match the appliance's
architecture.

## Prerequisites

- An amd64 Debian or Ubuntu host (a VM is fine, but nested virtualization is
  *not* required just to build).
- Disk space: budget **15–20 GB** free (the chroot + app tree + ISO).
- Tools:
  ```bash
  sudo apt update
  sudo apt install live-build rsync
  corepack enable && corepack prepare pnpm@latest --activate
  ```

## One-command build

From the repository root:

```bash
os/scripts/build-image.sh
```

This runs four steps:

1. **Stage the app** (`scripts/stage-app.sh`): `pnpm install`, build the shell
   (`BASE_PATH=/`) and the api-server, then copy the workspace into
   `os/live-build/config/includes.chroot/opt/foulfox/app`.
2. **Validate the layout** (`scripts/validate-layout.sh`): confirm every recipe
   file is present (and lint the shell scripts if `shellcheck` is installed).
3. **Set executable bits** on the in-image scripts and live-build hooks.
4. **Run live-build** (`sudo lb clean && lb config && lb build`).

When it finishes you'll have a hybrid ISO in `os/live-build/` (named like
`live-image-amd64.hybrid.iso`). Continue to **flash.md**.

## What goes into the image

- **Kernel + firmware**: `linux-image-amd64` plus the non-free firmware bundles
  (Intel/Realtek/Atheros Wi-Fi, misc) for broad plug-and-play hardware support.
- **Networking**: NetworkManager (wired + Wi-Fi).
- **Virtualization**: `qemu-system-x86`, `qemu-utils`, `ovmf` (UEFI firmware for
  the guest), `swtpm` (virtual TPM for Windows 11), `virt-viewer` (the SPICE
  client), plus `usbutils`/`pciutils`.
- **Kiosk**: Xorg + Openbox + LightDM (autologin) + Chromium.
- **Runtimes**: Node.js + npm (api-server) and Python 3 + venv (Odysseus).
- **The FoulFox app**, staged at `/opt/foulfox/app`.

The systemd units, the kiosk session, and the `foulfox-*` helper scripts are
baked in under `config/includes.chroot/`, and two chroot hooks
(`config/hooks/normal/`) create the appliance user / enable the services and
pre-build the Odysseus Python venv so first boot is fast.

## Manual build (without the wrapper)

```bash
os/scripts/stage-app.sh
os/scripts/validate-layout.sh
cd os/live-build
sudo lb clean
sudo lb config
sudo lb build
```

## Rebuilding

`sudo lb clean` removes the previous build artifacts but keeps the downloaded
package cache, so subsequent builds are faster. Use `sudo lb clean --purge` to
wipe everything including the cache.

## Customizing

- **Guest size / display**: edit
  `live-build/config/includes.chroot/etc/foulfox/foulfox.env`
  (`VM_RAM_GB`, `VM_CPU_CORES`, `VM_DISK_SIZE`, `VM_DISPLAY_MODE`,
  `VM_SPICE_PORT`). The first-run provisioner reads these.
- **Extra packages**: add lines to
  `live-build/config/package-lists/foulfox.list.chroot`.
- **Debian release**: change `--distribution` in `live-build/auto/config`.

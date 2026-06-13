---
name: FoulFox OS appliance
description: How the bootable FoulFox OS appliance layer relates to the api-server, and the constraints that keep the dev workspace unaffected.
---

# FoulFox OS appliance (os/ live-build recipe)

`os/` is an author-only Debian live-build recipe that packages the app into a
USB-bootable Linux appliance (kiosk shell + Odysseus + QEMU/KVM Windows guest).
It cannot be boot-tested in this repl; it is validated on the user's hardware.

## Load-bearing constraints (don't break these)

- **Headless QEMU argv must stay byte-identical to the dev path.** The shared
  `buildQemuArgs` (api-server) defaults `displayMode:"headless"`, and headless
  must emit exactly the args the dev VM emitted before SPICE/VNC/USB were added.
  **Why:** the dev workspace and any existing callers depend on the unchanged
  headless launch; the appliance opts into SPICE via on-disk config only.
  **How to apply:** when touching `buildQemuArgs`, keep the headless branch
  producing the same vector; new behavior goes behind `displayMode !== headless`.

- **New VM config fields must be optional with defaults, merged on load.** The
  appliance writes `~/.odysseus-vm-config.json` directly (via `foulfox-first-run`);
  `loadVmConfig` merges it over `DEFAULT_CONFIG`. Adding a *required* field with
  no default would break old config files and the appliance.

- **Single-origin packaging.** On the appliance the api-server serves the built
  shell + `/api` + the Odysseus proxy from one origin, gated on
  `SERVE_SHELL_STATIC` (unset in dev, so dev keeps using Vite). The SPA fallback
  must stay *after* the `/api` router and only serve files from the shell build.

- **VM autostart only when there's something to boot.** `foulfox-first-run`
  leaves `diskPath` null until a Windows ISO appears (or the disk already
  exists); `foulfox-vm-autostart` skips when both `isoPath` and `diskPath` are
  null. **Why:** otherwise first boot launches QEMU against a blank disk.
  Frontloading an ISO requires re-running `foulfox-prepare` (reboot) — a
  VM-controls restart reuses the old config.

- **Never cite Replit's no-KVM limitation** in any appliance doc or message; the
  appliance runs on the user's bare metal where KVM is available.

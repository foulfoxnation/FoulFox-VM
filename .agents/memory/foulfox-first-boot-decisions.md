---
name: FoulFox OS first-boot design decisions
description: Cross-cutting decisions the install→boot→run path must stay consistent with (display, persistence, offline-safety, autostart).
---

Decisions for the bootable FoulFox appliance that future changes must respect.
**Why:** it must work the FIRST time it is flashed (no test loop), and offline
boot is a supported path.

- **Display = additive SPICE, never replace VNC.** The live QEMU launcher emits
  VNC + a localhost websocket (the in-shell noVNC viewer, the guaranteed path)
  AND, when the VM config is SPICE, ALSO a loopback `-spice`. Both coexist on one
  QEMU. Do not drop VNC for SPICE — the kiosk remote-viewer is a *secondary*
  attach. (The SPICE-capable standalone qemu-args helper is dead code; the live
  path is the launcher's buildQemuArgs.)
- **Persistence is non-destructive by design.** First-run only *detects* a
  missing `foulfox-persist` partition (`blkid -L`) and warns (stderr + a note
  file the shell surfaces); it NEVER repartitions the user's stick. Persistence
  is *required* to install Windows (otherwise ISO + guest disk live in a RAM
  overlay → lost on reboot + OOM). Docs must tell the user to create it.
- **Service start must be offline-safe.** Anything that pip/network-installs on
  boot must be sentinel-gated and wrapped so a failed/offline install does not
  abort under `set -e` and crash-loop a `Restart=on-failure` unit. The image
  build pre-provisions and stamps the sentinel; boot reinstall is skipped.
- **Do not wait on `network-online.target`** for first-run provisioning — its
  downloads are best-effort + reachability-probed, so blocking delays the kiosk
  on offline machines.
- **All mutable state under one persistent root.** Pin `ODYSSEUS_DATA_DIR` (both
  api-server and the Odysseus service honor it) to the persistence root so guest
  disks/config/registry survive reboots.

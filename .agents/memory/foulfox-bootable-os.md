---
name: FoulFox bootable-OS deployment target
description: FoulFox/Odysseus is intended to eventually boot from a flashed USB onto bare metal as its own OS; implications for the multi-VM workspace.
---

# FoulFox as a bootable OS

The product is packaged today as an Electron desktop app (`com.odysseus.vm`, bundles
api-server + odysseus-service). The stated forward goal is for FoulFox itself to be a
bootable OS flashed to a USB stick and run on bare metal — where it acts as the host
for the guest VMs.

## Why the multi-VM design fits this target
- Bare-metal Linux host ⇒ **KVM is native** (no nested-virt penalty). The KVM→tcg
  accelerator auto-select is exactly right; KVM is the first-class path.
- UI is local to the device ⇒ localhost-only binds and the 21000–25xxx port ranges
  are fine.
- Single device ⇒ the single-instance registry + file lock is correct.
- macOS guests stay gated (platform is `linux` on non-Apple bare metal) — honest.

## The one real conflict: storage persistence
**Why:** a live USB rootfs is a read-only squashfs with a RAM-backed (tmpfs) overlay.
Writing multi-GB OS images / qcow2 disks under `$HOME` would exhaust RAM and vanish on
reboot.
**How to apply:** all mutable VM state (registry file, VM disks, image cache) resolves
its base dir from `ODYSSEUS_DATA_DIR` (new optional env), falling back to `$HOME` for
Electron/dev. The OS init for the USB build MUST set `ODYSSEUS_DATA_DIR` to a
persistent writable partition. Legacy single-VM config is still read from `$HOME` for
one-time migration. Do not rename the preserved `ODYSSEUS_INTERNAL_TOKEN` /
`ODYSSEUS_PORT` vars — `ODYSSEUS_DATA_DIR` is purely additive and follows the same prefix.

## Packaging note (not yet built)
No bootable-OS infra exists in the repo (no grub/squashfs/iso build). Turning the
Electron app into an OS image (live Linux + kiosk browser pointing at the built UI +
qemu/kvm modules in the image) is a separate effort beyond the multi-VM task.

---
name: FoulFox VM launch path & guest hardware
description: Which QEMU arg builder is actually live, and the hardware a fresh Windows guest needs to install + be reachable.
---

# FoulFox VM launch path

There are TWO `buildQemuArgs` in the api-server. Only `vm-launch.ts` is live: the
flashed appliance's autostart unit calls `POST /api/vm/start` → `vm-launch.ts`.
`qemu-args.ts` has no importers and is tree-shaken out of the bundle — it is dead.

**Why:** a review once passed on `qemu-args.ts` while the appliance ran the
(different, wrong) `vm-launch.ts` path, so the feature was actually broken.

**How to apply:** any change to how VMs boot (disk bus, NIC, boot order, attached
media) MUST be made in `vm-launch.ts buildQemuArgs`. Editing `qemu-args.ts` changes
nothing at runtime.

# Fresh-install guest hardware requirements

A Windows guest provisioned from a stock retail ISO has no inbox virtio drivers,
so the generic high-performance virtio devices are invisible to it:

- **Disk:** virtio-blk is invisible to Windows Setup → boot the disk on AHCI
  (`ich9-ahci` + `ide-hd`). Linux keeps `if=virtio`.
- **NIC:** virtio-net has no inbox driver → Windows installs with no network and
  the auto-enabled OpenSSH/RDP are unreachable. Use `e1000e` (Windows drives it
  out of the box). Linux keeps `virtio-net`.
- **Install boot:** with a blank disk present, set the install CD `bootindex=0`
  and the disk `bootindex=1` so Setup actually boots.
- **autounattend.xml** must be delivered on a CD ISO (Windows Setup scans
  attached media for it); a loose file on the host is never read.

# Appliance ISO tooling

Auto-provisioning authors ISOs at runtime: the cloud-init **seed** ISO (Linux)
and the **unattend** ISO (Windows). The flashed appliance therefore needs an ISO
authoring tool in its package list (`xorriso` covers both code paths). Without
it, even the "working" Linux auto-download fails at the seed step on hardware.
None is present in the Replit dev container, so ISO authoring only works on the
flashed appliance — dev verification stops at catalog/resolve/typecheck.

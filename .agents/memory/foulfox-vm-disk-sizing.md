---
name: FoulFox VM guest disk sizing
description: Guest disk size is set in two layers that can silently disagree; keep them aligned.
---

# FoulFox VM guest disk sizing

The Windows/Linux guest disk *cap* is defined in **two independent layers**:

- **api-server defaults** — `os-catalog.ts` `defaultDiskGb` and `vm-registry.ts`
  `diskGb` (both 64). Used when a VM is created through the shell's picker.
- **OS appliance** — `foulfox.env` `VM_DISK_SIZE` + the `foulfox-first-run`
  script, which creates `windows.qcow2` at that size AND writes the VM config
  the api-server then *merges on load*. On a real appliance this layer wins for
  the auto-provisioned default VM.

**Rule:** change both layers together, or the appliance silently uses a
different size than the api-server default.

**Why:** the OS layer once defaulted to `128G` while the api-server used `64G`.
A 128 G qcow2 is sparse (a fresh disk is ~KB), but the *virtual ceiling* equal
to the whole physical disk is a footgun on the product's target hardware (one
128 GB total disk for OS + Windows VM): Windows sees a 128 GB C:, grows the
qcow2 to fill the entire drive, and starves the host/persist partition. Aligned
down to 64 G (Microsoft's recommended Win11 size) so OS + guest fit a 128 GB
disk with headroom.

**How to apply:** when changing guest disk size, update `VM_DISK_SIZE` in
`foulfox.env`, the `:-` fallback in `foulfox-first-run`, the api-server
`defaultDiskGb`/`diskGb` defaults, and the size strings in
`os/docs/first-boot.md` + `os/docs/flash.md` in lockstep.

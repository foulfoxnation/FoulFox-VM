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

## Aggregate-disk guardrail (enforcement)

The VM-create path enforces a real disk budget: it reads actual capacity via
`detectHostCapabilities()` (statfs on `ODYSSEUS_DATA_DIR`) and refuses to create
a VM when `sum(existing VM diskGb caps) + new diskGb` exceeds
`totalDiskGb − FOULFOX_DISK_RESERVE_GB` (reserve default 30 GB, held for FoulFox
OS + host-side apps), plus a floor that refuses when free space drops below the
reserve. diskGb is treated as a *reservation* (qcow2 is sparse, so this
over-counts real usage on purpose — predictable budgeting beats density on a
single-disk appliance).

**Why this is here, not in `vm-ports.ts`:** the `maxTotalDiskGb: 512` in
`defaultResourceGuards` is DEAD config — nothing calls it; real enforcement
lives in the `vm.ts` create handler next to the RAM check.

**Gotcha:** this dev host's statfs reports only ~32 GB total, so with the 30 GB
reserve the VM budget is ~2 GB and VM creation is effectively blocked here. That
is expected (the dev host has no KVM and can't boot VMs anyway), NOT a bug. The
guardrail fails OPEN when `totalDiskGb` is 0 (statfs unavailable). Real budget
only makes sense on the appliance's persist partition (e.g. 128 GB → 98 GB).

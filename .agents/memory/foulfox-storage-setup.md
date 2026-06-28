---
name: FoulFox storage setup (persistence auto-partition)
description: Safety model + dependency invariants for the first-run "Storage Setup" auto-partition choice.
---

# FoulFox Storage Setup — persistence partition

At first-run, the setup wizard offers a CHOICE: auto-partition the boot USB for
the user (destructive, opt-in, confirm-first) vs. manual instructions. The
auto path creates one `foulfox-persist` ext4 partition + a `/ union`
persistence.conf so live-system state survives reboot.

## The device-side helper is the ONLY safety boundary
`foulfox-storage-setup` (bash, runs via `sudo -n` as user `foulfox`) owns ALL
partitioning + every guard. The API/UI are conveniences, never trusted:
- It derives the boot disk itself (findmnt /run/live/medium → PKNAME). A
  UI-supplied device is only an `--expected-device` confirmation hint; a
  mismatch is refused.
- Append-only: the new partition starts aligned-up, at/after the last existing
  partition end, in TRAILING free space only — existing partitions are never
  moved, resized, or overwritten.
- Refuses if: `foulfox-persist` already exists, disk has any rw-mounted
  partition, device is virtual/managed, or the table fingerprint changed since
  the confirmed dry-run. Holds an `flock`. Re-runs every guard at apply (never
  trusts the dry-run).

**Why:** this is the one destructive operation in the product; a single bug
could wipe a user's other OS/data. Centralizing guards in one re-entrant helper
(not split across UI/API/helper) is what keeps it auditable and safe.

## Load-bearing invariants — do not break
- **`parted` must stay in `os/live-build/config/package-lists/foulfox.list.chroot`.**
  The helper drives `parted`/`partprobe`; it is NOT in the Debian base. Drop it
  and the on-device auto path silently dead-ends (TABLE_UNREADABLE). partx/findmnt/
  flock (util-linux) + mkfs.ext4 (e2fsprogs) are Priority:required → always present.
- **Virtual/managed disks are refused by design** (loop/zram/ram/dm/md/sr/fd +
  virtio vd*, Xen xvd*, nbd*, rbd*, pmem*). The target is a real USB on bare
  metal (sd*/nvme*/mmcblk*). This means it intentionally CANNOT auto-partition
  inside a VM (and there's no KVM on the dev repl) — verify on real hardware.
- Helper absent (e.g. the dev workspace) → API returns 501 and the UI shows
  "only on FoulFox OS"; apply also requires `confirm:true` + (UI sends) the
  dry-run fingerprint.

**How to apply:** before changing the package list, the helper's guard set, or
the confirm/fingerprint flow, treat the helper as the trust boundary and keep
all three layers (helper guards > API gating > UI confirm) intact.

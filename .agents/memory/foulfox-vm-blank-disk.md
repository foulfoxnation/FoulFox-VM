---
name: Windows VM blank-disk installer gate
description: Why a "ready" Windows VM can boot to the UEFI shell and how the blank-disk detection fixes it
---

**Rule:** "provisioning: ready" never guaranteed an installed OS — the appliance first-run pre-creates a blank 64G qcow2 and marks the VM ready, and a failed/never-run Microsoft ISO download was silently tolerated. A blank disk + no installer ISO must be treated as "no media."

**Why:** startVm only rejects when BOTH disk and ISO are absent; the pre-created blank disk made every start boot straight into the UEFI Interactive Shell, and doStartProvisioning's ready-early-return meant the ISO download was never retried (or attempted at all).

**How to apply:** `diskLooksBlank()` (host allocation `st.blocks*512 < 1GiB`, not apparent size) + `windowsNeedsInstaller()` in vm-provision.ts. ISO-present short-circuits, so early Windows Setup states (<1GiB written, installer CD still attached at bootindex 0) are safe. Clones clear isoPath but converted disks are >>1GiB. Both start routes re-provision on blank+no-ISO; provisionThenStart refuses to auto-start a still-blank disk. Don't reintroduce "ready" as an installed-OS signal.

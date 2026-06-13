---
name: VM snapshot bridge
description: Durable operational constraints for the Odysseus VM snapshot system (Node api-server + Python orchestrator snapshot-on-pass).
---

- **qemu-img must never modify a qcow2 that a running QEMU still has open** — doing so can corrupt the active disk. Offline image-level snapshot ops (list/save/restore/delete via qemu-img) are only safe when the VM is *fully stopped with no live QEMU process*. For a running VM, drive snapshots through the QEMU monitor (savevm/loadvm/delvm) instead.
  **Why:** flagged as a data-integrity risk during review.
  **How to apply:** gate any new image-level VM operation on the fully-stopped state; never run qemu-img against a disk a live VM holds.

- **Cross-service VM mutation (the Python service calling the Node api-server's VM POST endpoints) needs a shared internal token** (env `ODYSSEUS_INTERNAL_TOKEN`) set identically on *both* processes. If unset, each process falls back to its own random token, so the call gets a genuine 401 — and snapshot-on-pass records that error on the run rather than failing the (otherwise passing) work. It only succeeds once the user sets the shared token on their own machine.
  **Why:** in-container the bridge looks "broken" but is correct by design.
  **How to apply:** when wiring or debugging any Odysseus→api-server VM call (401s).

- **The Replit container has no /dev/kvm and no qemu binaries on PATH**, so the VM never boots here and snapshot/capability tooling returns ENOENT. Every VM/snapshot path must fail honestly — never silently report success.

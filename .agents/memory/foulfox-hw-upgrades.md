---
name: FoulFox hardware-targeted upgrades
description: Durable decisions from the VFIO/golden-image/telemetry/benchmark round (Ryzen 5600 + GTX 1070 Ti target)
---

- **Golden image**: `VM_DATA_DIR/golden-windows.qcow2` + `.cred.json`/`.sshkey` sidecars. Clone path (`tryGoldenClone`) must attach NO installer/unattend media and restore the saved creds/key — a fresh key or installer at boot priority breaks/reinstalls the cloned guest. Save is stopped-only, uses `qemu-img convert` (flattens + drops internal snapshots), unique tmp + in-flight lock.
- **GPU arbiter**: Ollama stop is SYNCHRONOUS (execSync, 30s) before QEMU spawn; restart happens in the QEMU exit handler (not on stop request) and only when no other passthrough VM runs. Sudoers whitelist: exactly `systemctl stop/start ollama`. No-op unless `/etc/foulfox/foulfox.env` exists.
- **VFIO**: `FOULFOX_VFIO_IDS` in foulfox.env → first-run writes modprobe conf, runs `update-initramfs -u` only on change, and does a same-boot sysfs unbind + `driver_override` rebind (modprobe alone won't detach an already-bound driver). gpu-fallback exits early when set.
- **/api/system routes** (telemetry/benchmark) are read-only but must be mounted with `localhostOnly` in app.ts — new prefixes get NO protection by default.
- **Session snapshots**: a RUNNING VM can `savevm`/`delvm` via monitor but cannot LIST snapshots → sidecar JSON (`<vmId>-session-snapshots.json`) tracks names for pruning (keep 5).
- **Headless**: `FOULFOX_HEADLESS=1` → kiosk `exec sleep infinity` (exiting makes LightDM respawn-loop).
- Running the whole odysseus-service pytest suite in one process shows cross-test interference failures (test_subagents); per-file runs are the truth.

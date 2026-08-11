---
name: FoulFox whole-system log viewer
description: Session Portal Logs tab multi-source SSE — where each log actually lives and the streaming gotchas
---

Where logs live on the appliance (source of truth for the portal's Logs source picker):
- systemd journal: everything started by systemd (foulfox-api, ollama, odysseus-service, kiosk, prepare, seed-ollama, gpu-fallback…).
- Installed apps (Voice Forge, Llama Llama Studio…): run under the app runner as children of api-server — their output is ONLY in the runner's in-memory ring buffer (`runLog(appId)`), NOT the journal. Any "system-wide logs" feature must expose them separately.
- QEMU/VM: persisted per-VM to `<vmDiskDir>/qemu.log` by vm-launch (5MB rotate); before this existed, VM failure output vanished with the process.
- Windows guest: no host-side file — poll `Get-WinEvent` over per-VM SSH key with an inclusive time overlap + (LogName,RecordId) dedupe; timestamp-only cursors drop same-second events.

Streaming gotchas (cost a debug round each):
- `tail -F missing-file || echo fallback` never falls back — `tail -F` retries forever without exiting. Test existence explicitly and print an honest status line first.
- Per-connection `bash -c` children must be spawned `detached:true` and killed via `process.kill(-pid)` or the foreground journalctl/tail survives as an orphan.
- Cap concurrent SSE log streams (view tokens are shareable → fork-bomb risk).

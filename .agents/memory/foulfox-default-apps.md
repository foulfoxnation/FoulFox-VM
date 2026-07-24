---
name: FoulFox default apps seeding
description: How OS-bundled default apps get installed on first boot, and the invariants to keep.
---
Default FoulFox Apps are zips baked into the OS image at `/usr/share/foulfox/default-apps/` (live-build includes.chroot); api-server's boot-time seeder (`FOULFOX_DEFAULT_APPS_DIR` override for dev/tests) installs each **once per app id**, marker file `.default-apps-seeded.json` under APPS_DIR.

Rules that must hold:
- **Seed at most once per id**: marker written only after a *successful* install → transient first-boot failures (no network for npm/pip) retry on next boot; a user uninstall is respected forever (marker survives).
- **Copy the zip before installing** — the installer deletes its source zip, and the bundled original lives on read-only squashfs.
- Autostart: `autostartApps()` only handles already-installed apps at boot; the seeder itself calls `startApp` after install when the manifest says autostart.
- `unzip` must stay in the OS package list — the installer shells out to it; without it every zip install silently fails.
- Manifest gotcha: `validateManifest` requires `schemaVersion: 1`; third-party zips often omit it → repack the zip patching foxapp.json (installer tolerates a single top-level wrapper dir, so no need to flatten).
- Heavy installs (torch CPU wheels ~200MB per venv) fit the 600s per-step timeout on good network; seeder waits up to 1h per app.

**Testing pitfall:** `pkill -f 'node dist/index.mjs'` matches the DEV api-server too — scope pkill by env marker or PID, or you kill the dev workflow (and its in-memory install jobs).

---
name: FoulFox OS ISO distribution
description: How the bootable appliance ISO is built, hosted, and surfaced for download in the shell.
---

# FoulFox OS ISO distribution

The bootable **FoulFox OS appliance** ISO is built by the GitHub Actions workflow
(`Build FoulFox OS ISO`) and published to a rolling pre-release tagged
`foulfox-os-latest` (asset `foulfox-os-latest.iso` + `.sha256`). The shell's
**"Get FoulFox OS"** tab links straight to it. The api-server resolves the URL
from env at `GET /api/os/release-info`: `FOULFOX_ISO_URL` (explicit, wins) else
`FOULFOX_GITHUB_REPO` (`owner/repo`, builds the rolling-release links) else
unconfigured. The endpoint then **probes** the constructed asset URL (cached
HEAD with ranged-GET fallback) and returns `status`: `ready` (downloadable now),
`building` (configured but the release isn't published yet), or `unconfigured`.
The tab shows the download button only on `ready`, a "building" notice on
`building` (the hook polls every 60s, so it auto-flips on its own), and setup
steps on `unconfigured`.

**Why:** A browser tab physically cannot write bootable USB media (no raw
block-device access via WebUSB/File System Access), so "click in-app → flash to
USB" is impossible. The realistic clean flow is in-app **download** + an external
one-click flasher (balenaEtcher) — same as every OS vendor. The release endpoint
is **public**, so any configured URL/repo must be non-secret (no signed/tokenized
URLs). The multi-GB live-build image cannot be built inside the Replit container
(needs amd64 Linux / GH Actions), so distribution is inherently external.

**How to apply:** When touching the download tab or release endpoint, keep the
flasher step external (never promise in-browser flashing) and keep the release
URL env-driven and public. The repo is not auto-discovered — it must be wired via
`FOULFOX_GITHUB_REPO`/`FOULFOX_ISO_URL` on the api-server (restart it after an env
change). Availability *is* auto-detected via the cached probe, so never gate the
download UI on `available` alone — drive it off `status`.

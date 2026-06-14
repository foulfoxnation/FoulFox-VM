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
`available:false` → the tab shows one-time setup steps.

**Why:** A browser tab physically cannot write bootable USB media (no raw
block-device access via WebUSB/File System Access), so "click in-app → flash to
USB" is impossible. The realistic clean flow is in-app **download** + an external
one-click flasher (balenaEtcher) — same as every OS vendor. The release endpoint
is **public**, so any configured URL/repo must be non-secret (no signed/tokenized
URLs). The multi-GB live-build image cannot be built inside the Replit container
(needs amd64 Linux / GH Actions), so distribution is inherently external.

**How to apply:** When touching the download tab or release endpoint, keep the
flasher step external (never promise in-browser flashing) and keep the release
URL env-driven and public. There is no runtime auto-discovery of the repo — it
must be wired via `FOULFOX_GITHUB_REPO`/`FOULFOX_ISO_URL` on the api-server.

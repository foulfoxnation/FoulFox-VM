---
name: FoulFox update mirror via published site
description: How OTA updates flow — GitHub primary, published Replit site as mirror; mirror routes only live after the user republishes.
---
- Update flow: device patcher fetches the rolling-release manifest from GitHub; on failure it falls back to `FOULFOX_UPDATE_MIRROR` (https-only, baked in foulfox.env → the user's published site `/api/updates/foulfox-app-latest.json`).
- The api-server mirror routes are public by design (field devices have no token; integrity comes from the sha256 the patcher verifies). bundleUrl is rewritten to the serving host via x-forwarded headers.
- **Gotcha:** any change to the mirror routes (or first deployment of them) is dead until the user REPUBLISHES the Replit site — the deployed prod site does not auto-update from dev.
- Shell "Odysseus Updates" button must never silently fall back to the legacy git-sync path on a probe failure — only when the server explicitly reports `supported:false`. The legacy path polls a nonexistent repo and was the original "couldn't reach update server" bug.

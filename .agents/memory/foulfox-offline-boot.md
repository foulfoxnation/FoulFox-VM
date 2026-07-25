---
name: FoulFox offline boot chain
description: why the kiosk showed "127.0.0.1 refused to connect" on offline hardware, and the rules that prevent it
---

On an offline machine, `network-online.target` waits ~90–120s. foulfox-api.service had After/Wants on it, while the kiosk only waited 60s for the API before launching Chromium — so Chromium landed on a never-retrying "refused to connect" error page, and everything (WiFi, USB list, shell API) looked dead.

**Why:** hit on the HP test hardware with no internet; user saw "Could not reach API" + browser refusing 127.0.0.1.

**How to apply:**
- NO appliance unit may wait on network-online.target — the whole stack is local-first (prepare/odysseus already documented this; api was the stray violator).
- foulfox-kiosk waits for the API with no time limit and shows a data:-URL "still starting" splash (class FoulFoxSplash) after 45s so fail-closed prepare failures are visible, not a black screen.
- Any best-effort boot-time download (virtio-win) needs --connect-timeout/--max-time and an atomic .part→rename so partial files aren't picked up next boot; foulfox-api Requires prepare, so anything that hangs prepare hangs the whole OS.

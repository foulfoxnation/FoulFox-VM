---
name: Kiosk fullscreen escape for external links
description: Links opened inside the --kiosk Chromium trap the user fullscreen; how external navigation must work
---

Any `target="_blank"` link or bare `chromium <url>` spawn on the appliance merges into the running `--kiosk` Chromium instance and opens FULLSCREEN with no header, navigation, or way back.

**Why:** Chromium single-instance semantics — a new invocation without a separate `--user-data-dir` joins the kiosk process and inherits kiosk mode. Reported by the user from the "Go to GitHub" button on the Get OS page.

**How to apply:**
- Shell external links must go through `openExternal()`/`externalLinkClick()` (`src/lib/open-external.ts`): POSTs `/api/browser/open {browser, url}` (shell token required) → `foulfox-open-browser` opens a decorated separate-profile window; falls back to `window.open` in dev.
- Never spawn bare `chromium <url>` server-side; use `foulfox-open-browser` (it sets the separate profile).
- Safety nets in the OS: kiosk runs with `--class=FoulFoxKiosk` so Openbox rules for class Chromium (decor yes, `<fullscreen>no</fullscreen>`) apply only to user-facing windows; Alt+F4 closes, Alt+Tab switches.

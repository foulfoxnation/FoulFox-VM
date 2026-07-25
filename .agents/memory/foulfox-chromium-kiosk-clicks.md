---
name: Chromium clicks in FoulFox kiosk
description: Real-hardware Chromium hit-testing/click failures and popup-behind-kiosk pitfalls
---

Symptom on real appliance hardware (HP, no proper GPU driver): JS-heavy sites (Replit) load, plain header links work, but buttons (Sign in) don't respond to clicks.

**Why:** Chromium GPU compositing without a real driver can misplace composited layers so hit-testing lands wrong; also popups (OAuth sign-in windows) can open BEHIND the fullscreen kiosk window since Openbox had application rules only for firefox-esr.

**How to apply:** keep `--disable-gpu-compositing` in `foulfox-open-browser` chromium launch, and keep the Chromium application rules (normal + dialog, decor/maximized/focus) in the kiosk Openbox rc.xml so new windows raise/focus over the kiosk.

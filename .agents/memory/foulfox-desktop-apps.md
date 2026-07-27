---
name: FoulFox OS desktop apps over the kiosk
description: How native desktop apps (Firefox, Chromium, Discord) are launched over the kiosk, and the window/click pitfalls on real hardware
---

# Launch path
Shell "Open Browser" dropdown → api-server POST /api/browser/open → /usr/local/bin/foulfox-open-browser <name> (runs as same foulfox user, DISPLAY defaulted to :0). Add a new app = chroot install hook + launcher case + rc.xml application rule + api-server allowlist + shell menu item.

# Rules that keep it usable (real HP hardware)
- **Chromium clicks**: any chromium launch on this hardware needs `--disable-gpu-compositing` or clicks land in the wrong spot on JS-heavy pages. It must be on EVERY invocation (kiosk, splash, user browser).
- **No fullscreen escape traps**: every user-facing app rule in openbox rc.xml must set `<fullscreen>no</fullscreen>` + `<decor>yes</decor>` — a fullscreen undecorated window strands a non-technical user. Only the FoulFoxKiosk class stays fullscreen.
- **Titlebar buttons were near-unclickable**: Openbox scales titlebar/buttons with the theme font; rc.xml sets 13pt fonts for this reason. Don't remove.
- **Kiosk isolation**: user Chromium windows must use a separate --user-data-dir or they merge into the kiosk instance and inherit --kiosk.

# Discord
Baked via chroot hook (downloads official .deb from discord.com/api/download?platform=linux&format=deb, apt installs, build fails loudly if binary missing; hook needs the resolv.conf symlink workaround like other network hooks).

**Why:** user works directly on the appliance and needs copy/paste + screenshots via Discord; browser windows previously opened fullscreen with broken tiny buttons.

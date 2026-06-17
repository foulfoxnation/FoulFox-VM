---
name: live-build multi-pass apt resolver
description: Why FoulFox OS ISO builds can fail at lb_chroot_live-packages on a transitive dependency, and how to fix it.
---

# live-build populates the chroot in SEPARATE apt transactions

Debian `live-build` does NOT install everything in one apt run. It runs the
package-list install pass(es) first, then a distinct `lb_chroot_live-packages`
pass that installs the live system packages (`live-boot`, `live-config`,
`live-config-systemd`) in its OWN apt transaction.

A package that is pulled in ONLY transitively during the package-list pass is a
weak resolver anchor in the later live-packages pass: apt is free to "solve" the
live-packages transaction by dropping it, which then breaks whatever hard-depends
on it and aborts the build with:

  `E: Error, pkgProblemResolver::Resolve generated breaks, this may be caused by held packages.`

## Concrete instance (the one that bit us)
- `libgtk-3-common` hard-depends on the virtual `gsettings-backend`; the ONLY
  provider in `main` is `dconf-gsettings-backend`.
- The GUI stack (chromium, lightdm-gtk-greeter, network-manager-gnome,
  spice-client-gtk, virt-viewer) pulled `dconf-gsettings-backend` in only
  transitively. It installed fine in the package-list pass, then the
  `lb_chroot_live-packages` pass dropped it → libgtk-3-common break → exit 100.
- Fix: list `dconf-gsettings-backend` explicitly in
  `os/live-build/config/package-lists/foulfox.list.chroot`.

**Why:** listing a package in `*.list.chroot` records it as *manually requested*,
so apt keeps it pinned across every chroot apt pass instead of treating it as a
droppable auto/transitive dependency.

**How to apply:** if a live-build run fails at `lb_chroot_live-packages` with
"X depends Y but Y is not going to be installed" where Y is currently only a
transitive dep, add Y (or the concrete provider of the virtual package) to the
chroot package list. Do NOT flip `--apt-recommends` to false as the fix — it is
broad, changes the appliance's package closure, and is not targeted to the break.
Fallback if it recurs: also list `live-boot`, `live-config`, `live-config-systemd`
explicitly so the live packages resolve in the first transaction too.

Note: this stage is only reachable once the earlier firmware auto-detection 404 is
fixed (`--firmware-chroot false` / `--firmware-binary false`, firmware installed
explicitly via the package list).

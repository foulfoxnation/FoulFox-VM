---
name: live-build multi-pass apt resolver
description: Why FoulFox OS ISO builds fail at lb_chroot_live-packages, and the fix that actually works.
---

# live-build populates the chroot in SEPARATE apt transactions

Debian `live-build` does NOT install everything in one apt run. It installs the
config package-list(s) first (`lb_chroot_install-packages`, which resolves the
whole list together), then runs a DISTINCT `lb_chroot_live-packages` pass that
does an INCREMENTAL `apt-get install` of the live system packages
(`live-boot`, `live-config`, `live-config-systemd`) on top of the already-installed
set.

That incremental install can dead-end where the combined install would have
succeeded: apt re-resolves the live packages against the installed desktop stack
and reports e.g.

  `libgtk-3-common : Depends: dconf-gsettings-backend but it is not going to be installed`
  `E: Error, pkgProblemResolver::Resolve generated breaks` -> exit 100

Meaning: apt can't add the live packages on top of the GUI without proposing to
drop the gsettings backend, so it gives up.

## What did NOT work
Pinning the dropped provider (`dconf-gsettings-backend`) as a manual package in
`foulfox.list.chroot` did NOT fix it. The provider was installed and "already the
newest version", yet the separate live-packages transaction STILL produced the
same break. The problem is the incremental transaction itself, not which packages
are marked manual.

## What WORKS
List the live system packages (`live-boot`, `live-config`, `live-config-systemd`)
directly in `os/live-build/config/package-lists/foulfox.list.chroot`. Then they
install in the SAME combined transaction as the GUI stack -- which resolves
cleanly, exactly like Debian's own desktop live images -- and the later
`lb_chroot_live-packages` pass finds them already present and becomes a no-op.

**Why:** apt's resolver finds a consistent solution when planning the full set at
once, but is more conservative (and here, fails) when asked to graft new packages
onto an existing install.

**How to apply:** if a live-build run fails at `lb_chroot_live-packages` with
"X depends Y but Y is not going to be installed", move the live packages into the
chroot package list so they resolve up-front. Do NOT chase the named dropped dep,
and do NOT flip `--apt-recommends` to false (broad; changes the appliance closure).

Note: this stage is only reachable once the earlier firmware auto-detection 404 is
fixed (`--firmware-chroot false` / `--firmware-binary false`, firmware installed
explicitly via the package list).

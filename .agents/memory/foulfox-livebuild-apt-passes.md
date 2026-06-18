---
name: FoulFox OS live-build CI — build tool must be Debian's, not the runner's
description: Why the ISO build keeps dying at lb_chroot_live-packages, and the fix (build inside a Debian container).
---

# Build the Debian live image with DEBIAN's live-build, not the runner's

The "Build FoulFox OS ISO" GitHub Actions workflow runs on `ubuntu-latest` and,
if you `apt-get install live-build` there, you get UBUNTU's ancient
`live-build 3.0~a57-1ubuntu49.1` (the 3.x branch). We build a DEBIAN bookworm
image with it (`lb config --mode debian --distribution bookworm`, mirrors at
deb.debian.org). That cross-distro pairing is the root cause of the persistent
failure.

## Symptom (the failure that wasted 3 build cycles)
live-build populates the chroot in multiple apt passes. The combined
`lb_chroot_install-packages` pass installs the whole package list (GTK desktop,
`dconf-gsettings-backend`, even `live-boot`/`live-config`/`live-config-systemd`)
WITH recommends and SUCCEEDS. Then Ubuntu live-build 3.x's SEPARATE
`lb_chroot_live-packages` pass re-runs `apt-get install` for the live packages
and instantly dead-ends:

  `libgtk-3-common : Depends: dconf-gsettings-backend but it is not going to be installed`
  `E: Error, pkgProblemResolver::Resolve generated breaks` -> exit 100

i.e. the old tool's internal apt invocation re-resolves the already-satisfied
Debian chroot and proposes to drop a hard dependency it can't drop. This is the
build TOOL's behaviour, not a missing package.

## What does NOT fix it (don't retry these)
- Pinning the dropped dep (`dconf-gsettings-backend`) as a manual package.
- Pre-installing `live-boot`/`live-config`/`live-config-systemd` in the chroot
  list so they resolve in the combined pass. (They DO install in pass 1, but the
  separate Ubuntu-live-build pass 2 still re-resolves and breaks.)
- Flipping `--apt-recommends`. No reliable apt knob exists for the 3.x pass.

## The fix
Run the live-build phase inside a **privileged `debian:bookworm` Docker
container** so `lb` is Debian's own modern live-build:
- Keep `runs-on: ubuntu-latest` and the host disk-cleanup step. Use `docker run`,
  NOT a job-level `container:` (a job container can't reclaim host toolcache/disk).
- Stage the web app on the HOST first (it has Node 20 + pnpm); the container has
  no Node toolchain. `build-image.sh` supports `FOULFOX_SKIP_STAGE_APP=1` and is
  root-aware (`SUDO=()` when uid 0, else `sudo`).
- `docker run --rm --privileged --security-opt seccomp=unconfined -v "$PWD":/workspace -w /workspace ... debian:bookworm` then apt-install live-build + iso tools and run `build-image.sh`. `--privileged` is required for the loop/mount work live-build does.

**Why:** Debian's live-build resolves a Debian chroot correctly; the Ubuntu 3.x
fork does not. Matching the build tool to the target distro removes the whole
class of chroot apt-resolution bugs.

**How to apply:** if a live-build run fails at `lb_chroot_*` resolving a
already-satisfied Debian chroot, FIRST check `lb --version` in the log — if it's
Ubuntu's `3.0~aNN`, move the build into a Debian container before touching the
package list. (The earlier firmware-auto-detect 404 and security-suite-name
fixes still apply regardless of which live-build runs.)

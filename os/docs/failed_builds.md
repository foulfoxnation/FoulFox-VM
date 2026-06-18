# FoulFox OS ISO — Failed Build Log

A running record of every way the **"Build FoulFox OS ISO"** GitHub Actions
workflow (`.github/workflows/build-foulfox-os.yml` → `os/scripts/build-image.sh`
→ Debian `live-build`) has broken, the root cause, and the fix that landed.

**Read this before touching the build.** Most of these failures are non-obvious
and several looked like package problems but were actually caused by the *build
tool* or the *runner environment*. Each entry says how to recognize the symptom
and what NOT to retry.

> Note on history: GitHub only retains the most recent run in the Actions API
> (older runs/logs have aged out), so the per-run details below are
> reconstructed from the fix-commit history and saved build logs. Exact run
> numbers for some early attempts are approximate; the **failure modes and
> fixes are authoritative**.

---

## Status summary

| # | Failure mode | Stage | Fix commit | Status |
|---|--------------|-------|-----------|--------|
| 1 | pnpm lockfile-format mismatch (`pnpm@latest`) | host `pnpm install` (~2 min) | `1cfe481` pin pnpm | FIXED |
| 2 | live-build ran in **Ubuntu mode**, debootstrap hit `archive.ubuntu.com` | `lb bootstrap` (debootstrap) | `f5fce3d` `--mode debian` + Debian mirrors | FIXED |
| 3 | Masked failures reported a **false green** | `auto/build` / Collect ISO | `f5fce3d` era: `bash`+`pipefail`, hard `exit 1` | FIXED |
| 4 | Obsolete security suite `bookworm/updates` → 404 | chroot `apt update` (exit 100) | `8294dfc` `--security false` + archives | FIXED |
| 5 | Firmware auto-detection 404 (`Contents-amd64.gz`) | `lb bootstrap`/chroot | `031cbb7` firmware flags false + explicit list | FIXED |
| 6 | `dconf-gsettings-backend` not installable / `pkgProblemResolver` | `lb chroot_install-packages live` (exit 100) | `fe3f58c`, `af8ec0b` — **both FAILED** | superseded |
| 7 | **Root cause of #6:** runner's Ubuntu live-build 3.x vs Debian image | same stage | `a45d4f1` build in privileged `debian:bookworm` container | **FIXED ✅** |

**Build #11 (`a45d4f1`) is the first fully GREEN run** — it cleared every chroot
stage and produced the ISO end-to-end (collect + upload + release).

---

## 1. pnpm lockfile-format mismatch (`corepack prepare pnpm@latest`)

- **Symptom:** `pnpm install --frozen-lockfile` aborts ~2 min into the run on a
  clean checkout with an `ERR_PNPM` lockfile-format error. Never reproduces
  locally (local pnpm is older).
- **Root cause:** `corepack prepare pnpm@latest --activate` installs whatever
  pnpm is newest on the runner — which can be a newer **major** than the pnpm
  that generated `pnpm-lock.yaml` (lockfile was made by `10.26.1`, `latest` was
  `11.x`). The lockfile format differs across majors, so `--frozen-lockfile`
  fails fast.
- **Fix (`1cfe481`):** pin pnpm in lockstep in BOTH places —
  `package.json` `"packageManager": "pnpm@10.26.1"` and
  `corepack prepare pnpm@10.26.1 --activate` in the workflow.
- **Do NOT:** use `pnpm@latest` anywhere in CI. If CI install fails on a fresh
  checkout but local works, check the pnpm **major** first.

## 2. live-build defaulted to Ubuntu mode (debootstrap hit the wrong mirror)

- **Symptom:** `E: Failed getting release file .../dists/bookworm/Release` from
  `archive.ubuntu.com`; no base system is built, so no ISO.
- **Root cause:** GitHub's `ubuntu-latest` ships `/etc/live/build.conf` with
  Ubuntu defaults. Without an explicit `--mode debian`, live-build builds a
  "ubuntu/amd64" system and debootstrap tries to fetch the Debian suite
  `bookworm` from the **Ubuntu** mirror, which has no such suite.
- **Fix (`f5fce3d`):** in `os/live-build/auto/config`, pin
  `--mode debian`, `--distribution bookworm`, explicit Debian mirrors
  (`--mirror-bootstrap/-chroot/-binary` → `http://deb.debian.org/debian/`),
  and `apt-get install debian-archive-keyring` in the workflow so Debian's
  `Release` signature verifies.
- **Do NOT:** rely on live-build's host-derived mode/mirror defaults in CI.

## 3. Masked failures produced a false green

- **Symptom:** the "Build the image" step reported **SUCCESS** but the next step
  ("Collect ISO") failed because no `.iso` existed — confusing and easy to
  misdiagnose.
- **Root cause:** two error maskings:
  1. `auto/build` ran under `dash` (no `pipefail`), so `lb build ... | tee
     build.log` returned `tee`'s exit 0 even when `lb` failed.
  2. `build-image.sh` used `ls *.iso || echo "(none)"`, which returns 0 even
     when there's no ISO.
- **Fix:** `auto/build` uses `#!/bin/bash` + `set -euo pipefail`;
  `build-image.sh` hard-`exit 1`s when no `*.iso` is present.
- **Do NOT:** let any build wrapper swallow a non-zero exit. Fail loudly.

## 4. Obsolete Debian security suite name (`bookworm/updates` → 404)

- **Symptom:** the chroot `apt update` aborts with `exit code 100`;
  `bookworm/updates` → `404 Not Found` / "does not have a Release file".
- **Root cause:** the Ubuntu-shipped live-build on the runner predates Debian's
  bullseye-era rename of the security pocket, so it auto-generates the
  pre-Debian-11 name `bookworm/updates`. Since Debian 11 the pocket is
  `<dist>-security` (i.e. `bookworm-security`).
- **Fix (`8294dfc`):** set `--security false` in `auto/config` and ship the
  correct repo via `config/archives/debian-security.list.chroot` +
  `.list.binary` (`deb http://security.debian.org/debian-security
  bookworm-security <areas>`). No key import needed — `debian-archive-keyring`
  in the base already trusts it. (`config/archives/*` survives `lb clean` +
  `lb config`; only `lb clean --purge` wipes `config/`.)

## 5. Firmware auto-detection 404

- **Symptom:** the build fails fetching a per-suite Contents index
  (`<mirror>/dists/bookworm/Contents-amd64.gz`) used to map kernel modules to
  firmware packages.
- **Root cause:** live-build's automatic firmware detection
  (`--firmware-chroot`/`--firmware-binary "true"`) downloads that index, which
  is not reliably available in this configuration → 404.
- **Fix (`031cbb7`):** set `--firmware-chroot false` and `--firmware-binary
  false`, keep `--archive-areas "main contrib non-free non-free-firmware"`, and
  install firmware bundles explicitly in
  `config/package-lists/foulfox.list.chroot` (`firmware-linux`,
  `firmware-iwlwifi`, …).
- **Do NOT:** re-enable automatic firmware detection to "get more drivers" —
  add explicit firmware packages to the list instead.

## 6. `dconf-gsettings-backend` not installable (the three failed attempts)

- **Symptom (builds ~#8, #9, #10):** at the separate live-packages chroot pass,
  apt dead-ends with:
  ```
  libgtk-3-common : Depends: dconf-gsettings-backend but it is not going to be installed
  E: Error, pkgProblemResolver::Resolve generated breaks
  ```
  → `exit code 100`. The **combined** package pass installs the whole list
  (including the GTK desktop) fine; only the *separate* live-packages pass
  re-resolves and breaks.
- **Failed fix attempts (do NOT retry these):**
  1. `fe3f58c` — pinning `dconf-gsettings-backend` as a manual package. FAILED.
  2. `af8ec0b` (build #10) — pre-installing `live-boot` / `live-config` /
     `live-config-systemd` in the chroot list so they resolve in the combined
     pass. They DO install in pass 1, but the separate pass still re-resolves
     and breaks. FAILED.
- **Why these failed:** the problem isn't a missing package at all — it's the
  build *tool* (see #7).

## 7. ROOT CAUSE of #6 — runner's Ubuntu live-build 3.x vs a Debian image ✅

- **Diagnosis:** `ubuntu-latest`'s `apt-get install live-build` gives Ubuntu's
  ancient **`live-build 3.0~a57`** (the 3.x branch), and we use it to build a
  **Debian bookworm** image. Ubuntu live-build 3.x's separate live-packages apt
  invocation mis-resolves the already-satisfied Debian chroot and proposes to
  drop a hard GTK dependency it cannot drop → the `pkgProblemResolver` break
  above. It is a cross-distro tooling mismatch, not a package-list problem —
  which is why all three package fixes in #6 failed.
- **Fix (`a45d4f1`, build #11):**
  - Stage the web app on the **host** (it has Node 20 + pnpm) in a dedicated
    step; the build container has no Node toolchain. `build-image.sh` honors
    `FOULFOX_SKIP_STAGE_APP=1` and is root-aware (`SUDO=()` when uid 0).
  - Run the live-build phase inside a **privileged `debian:bookworm`
    `docker run`** so `lb` is Debian's own modern live-build (`20230502`). Use
    `docker run`, **not** a job-level `container:`, so the host disk-cleanup
    step still reclaims space. Bind-mount the workspace so the ISO lands back on
    the host for collect/upload/release.
- **Verified:** build #11 ran with `live-build 20230502` and cleared
  `bootstrap_debootstrap` → `chroot_install-packages install` →
  **`chroot_install-packages live`** (the exact stage that killed #8/#9/#10) →
  hooks → `binary_rootfs`/squashfs → ISO, with zero `pkgProblemResolver`
  signatures.
- **Rule:** if a live-build run fails resolving an already-satisfied Debian
  chroot, FIRST check `lb --version` in the log. If it's Ubuntu's `3.0~aNN`,
  move the build into a Debian container before touching the package list.

---

## Current known-good configuration (as of build #11)

- `os/live-build/auto/config`: `--mode debian`, `--distribution bookworm`,
  Debian mirrors, `--security false` (+ `config/archives/debian-security.list.*`),
  `--firmware-chroot false` / `--firmware-binary false`,
  `--archive-areas "main contrib non-free non-free-firmware"`,
  `--apt-recommends true`.
- `os/live-build/auto/build`: `#!/bin/bash` + `set -euo pipefail` + `tee`.
- Workflow: pnpm pinned to `10.26.1`; host staging step; live-build runs in a
  privileged `debian:bookworm` container.

## Open risk (not a build-green issue — tracked separately)

- **Native node modules + glibc skew:** the web app is staged on `ubuntu-latest`
  (newer glibc) but boots on Debian bookworm (glibc 2.36). Native modules
  (e.g. `node-pty`, `ssh2`) compiled against the newer glibc could fail **at
  runtime/boot**, not during the build. If the booted appliance crashes on a
  native module, rebuild those modules in a bookworm-compatible environment.
  This does not affect whether the ISO build is green.

---

## How to add a new entry

When a future build fails:
1. Capture `lb --version`, the failing stage (`lb_chroot_*` / `lb chroot_* / lb
   binary_*`), and the exact apt/error lines from the run log (download the run
   artifact / `os/live-build/build.log`).
2. Add a row to the status table and a detailed section: **symptom → root cause
   → fix commit → do-NOT-retry notes**.
3. If it's a tooling/runner-environment cause (not a package), say so loudly —
   those are the ones that waste the most cycles.

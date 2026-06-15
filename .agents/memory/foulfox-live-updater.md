---
name: FoulFox live-updater (patcher) boot-safety
description: The pull-based app-stack updater's anti-brick invariant, fail-closed boot recovery, and deferred hardening seams.
---

# FoulFox live "patcher" (pull-based app-stack updates, no reflash)

Pushes api-server + odysseus-shell + odysseus-service updates to running devices via
an atomic `app-current` symlink flip with health-checked auto-rollback. Versioned
releases live under FF_HOME (`ODYSSEUS_DATA_DIR` wins, default `/var/lib/foulfox`).
Helper: `foulfox-patcher` (check|apply|rollback|status|boot-recover). Boot wiring:
`foulfox-first-run` (run by `foulfox-prepare.service`).

## Core anti-brick invariant
The durable "pending" recovery marker (holds the path to revert to) is cleared **only
after a flip to a known-good target has succeeded** — either the forward apply passing
its health check, or a *confirmed* rollback flip. **Any** `set_current` (symlink) flip
failure must leave the marker armed so the next boot reverts.
**Why:** clearing the marker while a bad/unverified release is still `app-current` =
exactly the power-loss brick the feature exists to prevent.
**How to apply:** `set_current()` returns non-zero on `ln`/`mv` failure; every caller
checks it. Rollback branches `clear_pending` only *inside* `if set_current "$prev"`.
Forward-flip failure (nothing changed yet) is the one case that disarms + aborts.

## Fail-CLOSED boot recovery (cross-file contract)
`do_boot_recover()` returns non-zero **iff** a marker is armed AND the boot-time
flip-back failed (explicit `return 0` on success so a cosmetic status-write failure
can't false-trip it). `foulfox-first-run` must NOT swallow that (`|| true` was a
fail-OPEN bug): it `exit 1`s on recovery failure. This is load-bearing because
`foulfox-api.service` and `odysseus-service.service` both declare
`Requires=foulfox-prepare.service` (+ `After=`), so a non-zero first-run blocks the
app services from starting the bad release. Marker stays armed → later boot retries;
first-run re-runs fully from the top so failing fast before its chown block is safe.
**Why:** without this, a failed boot-time rollback still let the unverified release boot.

## Implementation guardrails
- Patcher runs `set -uo pipefail` (NO errexit) → every return value must be checked
  explicitly; unchecked `mark_pending`/`set_current`/`atomic_write` silently fail-open.
- Updater dirs (updates/releases/venvs/update-staging) are root-owned and PRUNED from
  first-run's chown; status via mktemp+os.replace, pending/previous via atomic_write
  (refuses symlinked parent). No KVM here → cannot boot-test; verify logic by bash -n +
  architect, not runtime.

## Deferred hardening seams (documented follow-ups, NOT implemented)
- **Signature verification**: sha256 is mandatory now; minisign-style signature against a
  baked pubkey is a seam (download still trusts the configured manifest/repo URL only).
- **Cross-version data migrations**: no migration runner; an update assumes schema compat.
- **FF_HOME sticky-bit**: residual parent-rename TOCTOU (needs prior `foulfox` RCE on a
  single-user appliance). Complete fix = root-owned sticky-bit (1777) FF_HOME, deferred
  for on-hardware lightdm/X kiosk validation (black-screen risk > the vector it closes).

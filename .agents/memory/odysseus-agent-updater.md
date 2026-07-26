---
name: Odysseus agent updater
description: In-shell "Odysseus Updates" button — upstream Git sync of the vendored odysseus-service; safety excludes and auth pattern.
---

The vendored odysseus-service is NOT its own git checkout; upstream state is tracked by a marker file `.odysseus-upstream-commit` in the service dir (missing marker → action "update/install"). Sync = shallow clone upstream → `rsync -a --delete-after` into the service dir.

**Rules that must hold:**
- rsync excludes protect `data/`, `apps/`, `.venv/`, `start.sh` (FoulFox boot script — upstream ships its own!), `.env`, marker files. Never pass `--delete-excluded`.
- A sync overwrites any FoulFox-local Python modifications inside the vendored service — intentional per user, but keep FoulFox-critical boot logic in `start.sh` or outside the service dir.
- Repair == same sync path, triggered when the health probe (port 7000) fails.
- `/api/os/odysseus-update` must be behind `localhostOnly + requireStateChangeToken` in app.ts (GETs pass via read-only exemption; apply POST needs the shell token). New `/api/os/*` mutation routes are NOT auto-protected — each prefix must be added to app.ts explicitly.

**Why:** user requirement — updater must never clobber installed apps, the live app-stack updater, or local state; and an unauthenticated apply would let any localhost caller rewrite the agent and restart the service.

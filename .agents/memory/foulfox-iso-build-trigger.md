---
name: In-app FoulFox OS ISO build trigger
description: How the "Get FoulFox OS" page starts and tracks a cloud ISO build, and the security posture.
---

# In-app ISO build trigger

The "Get FoulFox OS" download tab can START and live-track the GitHub Actions ISO
build itself (no need to open GitHub). Backend lives in the api-server release
route: a public GET returns the real latest-run state (server-cached ~12s) and a
public POST fires a `workflow_dispatch` on `main` using the server-side GitHub
token (`FOULFOX_GITHUB_TOKEN` || `GH_PUSH_TOKEN` || `GITHUB_TOKEN`, in that
precedence). The build workflow only runs on dispatch — pushing a CI fix does NOT
auto-run it; you must dispatch (the button, or the POST endpoint) to get a run.

**Why public/unauthenticated:** the endpoints sit OUTSIDE the localhost-only
`/api/os/update` guard on purpose so the Replit preview (proxied, cross-origin)
can read status and trigger builds. The user explicitly deferred security
("worry about security when you have this working").

**How to apply:** if hardening later, the POST is the exposure — any reachable
client can spend Actions minutes via the server token. Add rate-limit + a
session/token guard (or environment-gate the public mode) rather than moving it
back behind localhostOnly, which would break the preview button.

**Frontend race note:** right after a successful dispatch GitHub needs a few
seconds to register the run and the status GET is cached ~12s, so a naive single
refetch can briefly show the PREVIOUS (failed/finished) run. The trigger hook
schedules staggered refetches (~0/4/9/15s) to surface the new run quickly; keep
that if you touch the polling.

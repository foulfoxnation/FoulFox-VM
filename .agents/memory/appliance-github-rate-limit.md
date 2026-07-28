---
name: Appliance GitHub API rate limit
description: The FoulFox device polls api.github.com WITHOUT a token — design every server-side GitHub call around a 60 req/hr total budget.
---

The appliance has no GitHub token (a secret cannot ship inside a public ISO), so all api.github.com calls from the device are unauthenticated: **60 requests/hour per IP, shared across every endpoint**.

**Why:** the Get OS page went dark on real hardware ("couldn't read the build service") because polling burned ~300 calls/hr — one freshness check wasn't cached at all, and other caches used token-sized TTLs.

**How to apply:**
- Any new server route that calls api.github.com must cache its result, with a much longer TTL when no token is configured (minutes, not seconds). Budget ALL routes together under 60/hr.
- On failure (403 rate limit, network blip) serve last-known-good data instead of an error; GitHub resets the budget hourly.
- `github.com/.../releases/download/...` (release asset downloads, e.g. the update manifest) is NOT the API and is not subject to this limit.

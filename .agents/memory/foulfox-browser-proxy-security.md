---
name: In-shell browser proxy security
description: Security invariants for the FoulFox shell's server-side web-browser proxy and the loopback api-server CORS allow-list.
---

# In-shell browser proxy security

The shell ships a server-side web proxy (`artifacts/api-server/src/routes/browser.ts`) that
renders fetched public pages inside a sandboxed iframe (`sandbox="allow-scripts allow-forms"`,
deliberately WITHOUT `allow-same-origin`). That sandbox gives the fetched page an opaque
origin, so its scripts send `Origin: null` on any fetch they make.

## Invariant 1 — never allow `Origin: null` in the loopback CORS allow-list
**Rule:** `app.ts` `localCors` allows only same-origin (`!origin`) and explicit localhost
origins. Do NOT re-add `origin === "null"`.
**Why:** if null is allowed, scripts in the sandboxed proxy page can CORS-read loopback API
responses cross-origin — including `/api/shell/session-token` — then replay that token to
token-gated state-changing endpoints (privilege escalation). The legit shell never needs
null: appliance mode is served same-origin (no Origin header) and dev uses a localhost origin.
**How to apply:** whenever touching CORS, the session-token endpoint, or the browser proxy.
(Electron `file://` would be null-origin, but it is not a working token path here.)

## Invariant 2 — SSRF guards must pin the connection to the validated IP
**Rule:** resolve + validate the host, then connect to *that* address by passing a custom
`net.LookupFunction` as the `http(s).request` `lookup` option. Keep the Host header and TLS
SNI derived from the original hostname. Re-validate AND re-pin on every redirect hop.
**Why:** validating the hostname and then letting Node re-resolve at connect time leaves a
DNS-rebinding window where the name can flip to a loopback/RFC1918 address between check and
connect.
**How to apply:** any server-side fetch of a user-supplied URL, not just this proxy.

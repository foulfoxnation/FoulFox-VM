---
name: Appliance env parity with dev
description: Envs set by the dev api-server lifecycle don't exist on the device; defaults must live in start.sh
---
The dev api-server's Odysseus lifecycle injects env vars (e.g. AUTH_ENABLED=false, bridge tokens) when spawning the service. On the appliance, systemd runs start.sh with only foulfox.env — none of those lifecycle envs exist, so any behavior gated on them silently diverges on real hardware.

**Why:** the Workspace auth 302/401 loop on the HP: dev disabled Odysseus's multi-user login via lifecycle env, the device didn't, so the appliance redirect-looped to /login with no account ever created.

**How to apply:** whenever odysseus-lifecycle.ts sets an env that changes behavior, mirror a matching default in start.sh's packaged branch (foulfox.env still overrides). start.sh ships in the app bundle → fixes reach devices via live update, no reflash.

---
name: Agent-suite endpoint assignment vs creation
description: Why creating a ModelEndpoint alone never changes AI cost — you must assign it to every agent role via provision.
---

# Switching the agent suite to a different model

**Rule:** redirecting the Odysseus/FoulFox agent suite to a new model takes TWO
steps: (1) create a `ModelEndpoint`, and (2) assign it to *every* role via
`POST /api/agent-suite/provision` with `role_models` for all three roles
(`windows`, `game`, `architect`). Creating an endpoint by itself does nothing to
which model agent runs use.

**Why:** each agent role reads its own assigned endpoint at run time. Until a role
is reassigned, it keeps using whatever it had before (by default the paid Replit AI
proxy). So a "$0 / self-hosted llama" goal is only actually met after provision —
the endpoint row alone is inert. This bit us when planning the "Connect local model"
feature: it looked done after create, but cost would not have dropped.

**How to apply:**
- Any "switch/connect model" UI must call `provision` itself, not just create the
  endpoint. Send `setup_complete: true` so the flow also satisfies first-run setup.
- The SetupWizard hides once `setup_complete` is true, so model-switching must live
  on an always-available surface (e.g. the shell-header `ConnectLlamaModal`), not
  only inside the wizard.
- After provision, invalidate both `["agent-suite-state"]` and `["models"]`.

**Privileged-write plumbing (browser → service):** the browser must never hold the
Odysseus admin token. The api-server `/api/local-model/*` routes inject
`X-Odysseus-Internal-Token` server-side and are gated `localhostOnly +
requireStateChangeToken` (read-only GET passes; state-changing POST needs the
`x-shell-token` header). The `provision` call instead goes through the existing
`/api/odysseus/*` proxy route and needs no token.

**Known gap (non-blocking for single-user appliance):** the local-model `base_url`
is only validated for http/https + no embedded creds — there is no SSRF defense
(loopback/private/link-local hosts, DNS rebinding) before the service probes it.
Harden before any multi-user/public exposure.

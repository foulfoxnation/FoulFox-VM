---
name: "Cloud Ollama" means the user's own deployed proxy, not ollama.com
description: In FoulFox setup, "Cloud Ollama" = a self-hosted Ollama-behind-bearer-proxy deployment, NOT the public paid ollama.com.
---

# "Cloud Ollama" in FoulFox = the user's OWN deployed service

In the SetupWizard AI Online step (and the Connect-local-model modal), "Cloud Ollama"
refers to a **standalone cloud service the user deployed themselves**: Ollama bound to
`127.0.0.1` behind a Node bearer-auth reverse proxy, deployed (e.g. as a Reserved VM),
exposing `https://<deploy>.replit.app/v1`. Spec lives in `docs/cloud-ollama-handoff.md`.

- Connect it by pasting its `/v1` URL + the **proxy key** (the cloud service's
  `OLLAMA_PROXY_KEY` bearer token) — FoulFox sends `Authorization: Bearer <key>`.
- It is **NOT** the public paid `ollama.com` hosted API. Do not hardcode `https://ollama.com`
  or label the key field "ollama.com API key".
- Engine priority the user wants: **local Ollama is the free default** (no key,
  `http://localhost:11434`); their cloud deployment is the always-on alternative.

**Why:** the wizard originally hardcoded `https://ollama.com` + an "ollama.com API key",
implying the public paid service, when the user had built their own cloud Ollama proxy.
That conflated two different things and looked like it ignored the work they'd done.

**How to apply:** any UI/config that surfaces "Cloud Ollama" should default to an empty
deployment URL (placeholder hinting `https://your-deploy.replit.app/v1`), label the secret
as a **proxy key** (`OLLAMA_PROXY_KEY`), and keep local Ollama as the free default.
There is no env prefill for the deployment URL inside FoulFox — the user pastes it.

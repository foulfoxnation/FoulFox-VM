---
name: Self-healing setup audit + AI-first gate
description: Durable constraints for FoulFox's self-healing setup flow — authoritative AI-online gate, redaction parity, server-side repair scope.
---

# Self-healing setup (SetupWizard + setup-heal routes)

The setup flow brings AI online FIRST (cloud Ollama primary, local fallback),
auto-repairs FoulFox's own code/services during install, and writes a
persistent, downloadable audit log of every error + fix.

## AI-online gate must be authoritative
The "AI Online" step's Next button must gate on a LIVE probe, not on a
successful save. Odysseus `create_model_endpoint` (and the test probe) return
HTTP 200 even when the endpoint is `online:false`/`status:"offline"`, so a
syntactically valid but dead URL would unlock the rest of setup if you trust
save-success.
**Why:** gating on save-success is a silent bypass of the user-locked
"AI comes online first" requirement.
**How to apply:** derive readiness from the models listing query
(`items.some(!offline && models.length>0)`), re-probed after every save. Never
re-introduce a manual `aiConfirmed`-style flag that short-circuits the probe.

## Audit-log redaction must be mirrored in TWO places
Secrets are stripped by Odysseus `_redact` before persisting, BUT the api-server
JSONL outage spool (`setup-heal.ts`) bypasses Odysseus entirely when the service
is down, and that same spool is read back by the download fallback.
**Why:** without a matching redactor on the spool write path, credentials can
land in the user-downloadable audit log during the very outage the log exists to
document.
**How to apply:** any change to Odysseus secret patterns should be mirrored in
the api-server spool redactor (apply at write time so download is covered too).

## Repair scope is enforced server-side, never by the browser
The browser sends only a `check_key`; the api-server injects the internal token
and Odysseus resolves the actual verify command from a whitelist
(`CHECK_COMMANDS`) and sets `self_repair_authorized=True` itself.
**Why:** keeps repair confined to FoulFox's own code/services in BASE_DIR and
prevents arbitrary-command escalation from the client.
**How to apply:** never plumb a raw command from the client through the proxy;
add new repair targets to the server-side whitelist keyed by `check_key`.

## Destructive ops are logged, not auto-retried
Partition apply/dry-run failures are recorded as `error_detected` audit events
but are NOT wrapped in the auto-repair/retry loop (that loop is only for
FoulFox-code steps: endpoint save, VM sizing, suite provision).
**Why:** autonomously retrying a disk format is unsafe and out of repair scope.

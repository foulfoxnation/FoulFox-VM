---
name: Rotating an un-editable secret in this repl
description: When viewEnvVars shows a secret as false but a stale value is still injected at runtime.
---

# Rotating a secret the user "can't update"

Symptom seen with `GH_PUSH_TOKEN`: the running process received a stale/invalid
token (GitHub 401), yet `viewEnvVars({keys:[...]})` reported the secret as
`false` (i.e. not set at the workspace level you can manage), and the user said
they could not change it in the Secrets UI.

**Why:** the live value came from an inherited/account-level injection, not the
workspace-level secret store. Re-requesting alone may be shadowed by the stale
copy.

**How to apply:** to rotate, FIRST `deleteEnvVars({keys:[KEY]})` to clear any
workspace-level copy, THEN `requestEnvVar({requestType:"secret", keys:[KEY]})`
so the user pastes the fresh value, THEN restart the consuming workflow (the
api-server here builds+starts with no watcher, so it must be restarted to pick
up a new secret). Verify with a real authenticated call, not just presence.
Agents cannot set secret VALUES programmatically — `setEnvVars` is env-only.

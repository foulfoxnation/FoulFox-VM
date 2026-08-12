---
name: Odysseus↔api-server bridge token
description: How the cross-service internal token is shared, and why self-heal POSTs 401 when the wiring is missing
---
Rule: any Odysseus-initiated state-changing call to the api-server (POST /api/vm/*, /api/os/*, /api/apps/*) must send `X-Odysseus-Internal-Token`; api-server resolves the expected value env-first (`ODYSSEUS_INTERNAL_TOKEN`) then falls back to `$ODYSSEUS_DATA_DIR/odysseus-bridge-token`. Odysseus's `core.middleware.INTERNAL_TOOL_TOKEN` is the matching source of truth on the Python side — helpers should import it rather than re-reading env/files.

**Why:** the diagnostics self-heal (generate-keys) silently POSTed without the header for months; every 5-min heal attempt was rejected with "invalid token", so the per-VM SSH key never existed and the agent/VM looked permanently offline. Separately, the token file bootstrap lived only in start.sh's packaged branch, so dev had no shared token at all.

**How to apply:** when adding any new Odysseus→api-server mutation, attach the header (scoped to the loopback API base only — never to arbitrary URLs, to avoid token exfiltration). Token bootstrap in odysseus start.sh must run in BOTH dev and packaged branches; env var wins over file on both sides, so if a workspace-level `ODYSSEUS_INTERNAL_TOKEN` env exists, the file is irrelevant — compare against the env value when debugging 401s.

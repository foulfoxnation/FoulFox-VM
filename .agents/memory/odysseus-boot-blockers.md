---
name: Odysseus boot blockers
description: Why the agent showed offline at appliance boot and the rule for keeping the import path network-free
---

Rule: nothing on Odysseus's module import path (everything app.py executes before uvicorn binds) may touch the network. A hanging fetch there keeps the port closed → shell shows "FoulFox OS Offline" and systemd's Restart just re-runs the same hang.

**Why:** the fastembed semantic-memory model was never baked into the ISO; FastEmbedClient (constructed during import via memory_vector/RAG lane build) downloaded it from HuggingFace with retries — offline or WiFi-settling boots stalled/crash-looped the service.

**How to apply:**
- Any model/data a startup code path needs must be baked into the ISO (chroot hook → /opt/foulfox/<thing>, fail-loud offline-verification pass) and seeded to the persistent partition by foulfox-first-run (rsync + success-only marker), same pattern as the Ollama model.
- Runtime loads go local-first (`local_files_only=True`); on cache miss, consult the post-boot net-quiet window (appliance marker + /proc/uptime vs FOULFOX_NET_QUIET_SECONDS) and fail fast during it — degrade gracefully rather than block the bind.
- The quiet-window helper exists in BOTH api-server (net-quiet lib) and odysseus-service (embeddings module); keep semantics aligned.

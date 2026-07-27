---
name: FoulFox baked local Ollama AI
description: How the ISO ships offline local AI (Ollama + Llama model) and the invariants that keep it booting.
---

# Baked local AI (Ollama) in FoulFox OS

- Build: `os/live-build/config/hooks/normal/0040-foulfox-ollama.hook.chroot` installs the Ollama runtime and pulls `llama3.1:8b-instruct-q4_K_M` (~5 GB) into read-only `/opt/foulfox/ollama-models` at image build. Build fails loudly if the pull fails — never bake a model-less image. Needs a throwaway `ollama serve` on :11599 + resolv.conf fixup inside the chroot.
- Runtime: `ollama.service` (User=foulfox, loopback `127.0.0.1:11434`, `OLLAMA_MODELS=/var/lib/foulfox/ollama/models`, Requires/After=foulfox-prepare, no network-online wait).
- Seeding: **deferred** — foulfox-seed-ollama.service (oneshot, After=prepare+api+odysseus, idle-IO, 45min budget) copies baked store → `$FOULFOX_HOME/ollama/models` via resumable rsync, sentinel `.baked-model-seeded` on success. ollama.service is After/Wants the seed. Moved OUT of foulfox-first-run because the 5 GB copy blocked the whole boot chain (kiosk stuck on "still starting").
- **Boot invariant:** foulfox-prepare must stay FAST (TimeoutStartSec=10min covers fastembed seed + chown on slow USB). Never put multi-GB work back into prepare — api/odysseus Require it and the kiosk waits on api.
- Auto-provision: `artifacts/odysseus-service/src/local_ollama_bootstrap.py` (startup task, gated on `FOULFOX_LOCAL_OLLAMA=1` in foulfox.env) polls :11434 up to 3600 s (must outlast the deferred seed window; poll is async, non-blocking), idempotently creates a ModelEndpoint (`http://127.0.0.1:11434/v1`, kind local, pins the model), and calls `provision_suite` for all 3 roles ONLY when no role has any endpoint configured — a user's model choice is never clobbered. No-op in dev (env flag absent).
- Model name lives in TWO places: the 0040 hook and `FOULFOX_LOCAL_MODEL` in foulfox.env — keep in sync.
- CI: ISO now ~9 GB → the collect step must use `ln` hardlinks (two `cp` copies blew disk); release upload auto-skips >2 GiB (run artifact is the download); extra runner cleanup incl. `docker image prune -af`.
- GPU: nvidia-driver + linux-headers-amd64 + firmware-misc-nonfree baked so GTX 1660 gets CUDA accel; CPU-only fallback works (slow).

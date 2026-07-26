---
name: FoulFox baked local Ollama AI
description: How the ISO ships offline local AI (Ollama + Llama model) and the invariants that keep it booting.
---

# Baked local AI (Ollama) in FoulFox OS

- Build: `os/live-build/config/hooks/normal/0040-foulfox-ollama.hook.chroot` installs the Ollama runtime and pulls `llama3.1:8b-instruct-q4_K_M` (~5 GB) into read-only `/opt/foulfox/ollama-models` at image build. Build fails loudly if the pull fails — never bake a model-less image. Needs a throwaway `ollama serve` on :11599 + resolv.conf fixup inside the chroot.
- Runtime: `ollama.service` (User=foulfox, loopback `127.0.0.1:11434`, `OLLAMA_MODELS=/var/lib/foulfox/ollama/models`, Requires/After=foulfox-prepare, no network-online wait).
- Seeding: foulfox-first-run copies the baked store → `$FOULFOX_HOME/ollama/models` once via **resumable rsync**, sentinel `.baked-model-seeded` written only on success.
- **Boot invariant:** foulfox-prepare has `TimeoutStartSec=30min`. The 5 GB first-boot seed runs inside prepare (Type=oneshot); systemd's default ~90 s timeout would fail prepare and — fail-closed — keep every FoulFox service down. Do not remove this override, and don't add more long work to prepare without checking the budget.
- Auto-provision: `artifacts/odysseus-service/src/local_ollama_bootstrap.py` (startup task, gated on `FOULFOX_LOCAL_OLLAMA=1` in foulfox.env) polls :11434 up to 600 s, idempotently creates a ModelEndpoint (`http://127.0.0.1:11434/v1`, kind local, pins the model), and calls `provision_suite` for all 3 roles ONLY when no role has any endpoint configured — a user's model choice is never clobbered. No-op in dev (env flag absent).
- Model name lives in TWO places: the 0040 hook and `FOULFOX_LOCAL_MODEL` in foulfox.env — keep in sync.
- CI: ISO now ~9 GB → the collect step must use `ln` hardlinks (two `cp` copies blew disk); release upload auto-skips >2 GiB (run artifact is the download); extra runner cleanup incl. `docker image prune -af`.
- GPU: nvidia-driver + linux-headers-amd64 + firmware-misc-nonfree baked so GTX 1660 gets CUDA accel; CPU-only fallback works (slow).

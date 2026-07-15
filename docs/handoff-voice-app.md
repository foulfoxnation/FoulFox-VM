# Handoff: package the in-house TTS/STT voice agent as a FoulFox App

**Audience:** the Repl Agent in the project that contains the voice system.
**Goal:** turn the existing TTS/STT + voice-cloning conversation system into a GitHub repo
that installs into FoulFox OS via its app-install feature (paste repo URL → installed).

**Read `foulfox-app-spec.md` (attached alongside this file) first — it is the binding
contract.** This document only adds the voice-app-specific requirements on top of it.

---

## 1. Target shape

One GitHub repo, a normal full-stack web app, plus `foxapp.json` at the repo root.

- **Backend:** your existing STT + TTS + voice-clone pipeline behind a single HTTP server.
  - Runtime must be `"node"` or `"python"` (pick whichever the pipeline already uses —
    almost certainly `python`).
  - Bind to `127.0.0.1:$PORT` (the port comes from env `PORT`; never hardcode).
  - `GET /healthz` → 200 once models are loaded and the app can take audio.
- **Frontend:** a single self-contained page at `/` — mic capture, push-to-talk or VAD,
  conversation transcript, voice picker for cloned voices. It talks ONLY to your own
  backend (same origin, relative URLs).
- **LLM:** talk to local Ollama directly at `http://127.0.0.1:11434` (OpenAI-compatible
  `/v1` or native `/api/chat`). Make the base URL configurable via env
  (`OLLAMA_BASE_URL`, default `http://127.0.0.1:11434`) so FoulFox's "cloud Ollama"
  proxy setups also work. Maintain the conversation history server-side per session so
  it is continuous conversation, not one-shot prompts.

## 2. `foxapp.json` (starting point — adjust commands to the real repo)

```json
{
  "schemaVersion": 1,
  "id": "foulfox-voice",
  "name": "FoulFox Voice",
  "version": "1.0.0",
  "description": "Hands-free voice conversation with the local Ollama model. In-house STT, TTS and voice cloning.",
  "icon": "icon.png",
  "runtime": "python",
  "install": [["pip", "install", "--no-cache-dir", "-r", "requirements.txt"]],
  "build": [],
  "start": ["python", "server.py"],
  "healthPath": "/healthz",
  "uiPath": "/",
  "portEnv": "PORT",
  "dataEnv": "FOULFOX_APP_DATA_DIR",
  "db": "sqlite",
  "capabilities": [],
  "autostart": true,
  "window": { "title": "FoulFox Voice", "width": 900, "height": 700, "singleInstance": true }
}
```

Constraints enforced by the installer (violations = failed install):
- `install`/`build` are lists of **argv arrays**, `start` is one argv array. Executed
  **without a shell**: no `&&`, no pipes, no `$VAR`, no `bash -c` strings. Multiple steps →
  multiple entries in `install`.
- `id` is a stable slug `[a-z0-9-]`, ≤64 chars. It keys the data dir — never change it.
- Allowed capabilities are only `agent.task` and `vm.computer_use`. A voice chat app
  needs neither → declare `[]`.

## 3. Model weights and data (voice-app critical)

- The repo directory is **disposable** (wiped on reinstall/update). Model weights,
  cloned-voice embeddings, conversation history, and the SQLite DB must live under
  `$FOULFOX_APP_DATA_DIR` only.
- **Do NOT commit multi-GB weights to the repo** (clone is `--depth 1` but still
  downloads blobs; keep the repo lean).
- Recommended: on first start, if weights are missing under
  `$FOULFOX_APP_DATA_DIR/models/`, download them there (with progress logged), then
  serve `/healthz` 200. On later boots, load from the data dir — running must work
  fully offline after first-run.
- Cloned voice profiles: store under `$FOULFOX_APP_DATA_DIR/voices/` and expose
  add/list/delete endpoints + UI.

## 4. Audio in the browser (voice-app critical)

- The UI is embedded in a **sandboxed iframe** with `allow-scripts allow-forms` and
  **no `allow-same-origin`**:
  - No cookies, no localStorage that survives reliably — keep session state server-side
    (session id in memory / URL).
  - `getUserMedia` (microphone) requires a permissions-policy grant from the embedding
    page. **Build a graceful fallback**: if mic access is denied/unavailable, show a
    clear message and offer file-upload / push-to-talk-via-upload so the app is never
    a white screen.
- Stream audio to the backend as chunks (WebSocket or POST of webm/opus blobs) and
  stream TTS audio back; target barge-in-capable, low-latency turn-taking.

## 5. Verify before handing back (do all of these)

```bash
PORT=5055 FOULFOX_APP_DATA_DIR=/tmp/foxdata FOULFOX_APP_ID=foulfox-voice \
FOULFOX_APP_TOKEN=dummy FOULFOX_API_BASE=http://127.0.0.1:8080 \
  python server.py
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:5055/healthz   # 200
curl -s http://127.0.0.1:5055/ | head                                    # UI HTML
```
- [ ] `foxapp.json` valid, at repo root; commands are pure argv arrays.
- [ ] Binds `127.0.0.1:$PORT`; foreground process; no daemonizing.
- [ ] All writes (models, voices, DB, temp audio) land under `$FOULFOX_APP_DATA_DIR`.
- [ ] Works with Ollama at a configurable `OLLAMA_BASE_URL`; degrades with a clear
      error (not a crash) when Ollama is unreachable.
- [ ] UI works inside an iframe without `allow-same-origin`; mic-denied fallback exists.
- [ ] After first-run model download, the app runs with networking disabled.
- [ ] Deliver either way: push to GitHub (deliverable = the repo URL), **or** zip the
      project (foxapp.json at the zip root, or inside a single top-level folder —
      "Download ZIP" from GitHub and zipping the project folder both work) and hand
      over the .zip. FoulFox installs from a pasted repo URL, an uploaded .zip, or a
      .zip on a plugged-in USB flash drive.

## 6. Known limitation on the FoulFox side (not your problem, but be aware)

FoulFox's install pipeline (clone → validate → install → build → register) is live.
The launch phase (starting your backend, opening the app window, autostart, broker)
is being built separately — so package strictly to the contract above and it will
run unmodified once the runner ships.

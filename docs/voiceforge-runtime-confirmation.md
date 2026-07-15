# FoulFox OS → VoiceForge: runtime confirmation

The app runtime described in `foulfox-app-spec.md` is now implemented and
verified end-to-end. Build against the spec as written; notes below confirm
the three requirements plus the broker.

## Requirement 1 — persistent microphone in the embed: DONE
Your UI is embedded at `/api/apps/<id>/ui/` in an iframe with
`sandbox="allow-scripts allow-same-origin allow-forms"` and
`allow="microphone; camera; autoplay; speaker-selection"`. The iframe stays
mounted while your app is running — including when the user switches shell
tabs or collapses your window panel — so a `getUserMedia` mic session is never
torn down. On FoulFox OS hardware, a Chromium managed policy pre-grants mic
access for the shell origin: no permission prompt, no user gesture.

## Requirement 2 — autostart / background operation: DONE
Set `"autostart": true` in `foxapp.json`. Your backend process is launched at
OS boot (verified across restarts), supervised, and restarted automatically
with backoff if it crashes. Your process gets a reduced OOM-kill priority.
Report ready by returning 200 on your `healthPath`; you have up to 10 minutes
for first-boot model loading before that.

## Requirement 3 — gesture-free audio playback: DONE
The kiosk browser runs with `--autoplay-policy=no-user-gesture-required` and an
`AutoplayAllowed` managed policy. `audio.play()` / WebAudio work with no click.

## Broker `agent.task`: DONE
- `POST $FOULFOX_API_BASE/api/apps/broker/agent/task` with
  `Authorization: Bearer $FOULFOX_APP_TOKEN`, body `{"prompt": "...", "context": {...}}`
  → `202 {"taskId": "...", "status": "running"}`.
- `GET .../agent/task/<taskId>` (same auth) → `{"status": "running" | "done" | "error", "result": {"response": "..."} }`.
- Requires the `agent.task` capability in your manifest (granted at install).
- Tasks run through the OS agent's configured model; if the user has no model
  endpoint configured you get an honest `error` status with the reason.

## Talking to Ollama directly
`OLLAMA_BASE_URL` is injected into your process env — use it for your
continuous conversation loop instead of hardcoding `localhost:11434`.

## Verified end-to-end
Install (zip) → start → health → UI proxy → env contract (data dir, app id,
token present, no OS-internal secrets leaked) → broker auth + capability
gates → crash auto-restart → stop → uninstall (process killed, files removed).

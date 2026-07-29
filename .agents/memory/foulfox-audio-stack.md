---
name: FoulFox audio stack
description: OS audio packages missing by default; how PulseAudio is started for the kiosk session and device selection works in VoiceForge.
---

## The problem (discovered July 2026)
`foulfox.list.chroot` had zero audio packages — no PulseAudio, no ALSA. Chromium's `getUserMedia` and TTS playback silently fail without a running audio server.

## Fix applied

### OS packages (`os/live-build/config/package-lists/foulfox.list.chroot`)
Added after the Bluetooth section:
- `pulseaudio` — user-mode audio daemon Chromium talks to
- `pulseaudio-utils` — `pactl`/`paplay` for scripts/debugging
- `alsa-utils` — ALSA card detection; PulseAudio sits on top

### Kiosk launch (`os/live-build/config/includes.chroot/usr/local/bin/foulfox-kiosk`)
Added before the Chromium `while true` loop:
```sh
pulseaudio --start --exit-idle-time=-1 --log-target=syslog 2>/dev/null || true
sleep 1   # let PA detect ALSA cards before Chromium opens
```
`--exit-idle-time=-1` is critical — without it PA exits after 5s idle, breaking voice after any gap.

### Chromium managed policy (`foulfox-media.json`)
Already had `AudioCaptureAllowed: true` + `AudioCaptureAllowedUrls` for the shell origin — no change needed.

### Shell device picker (`artifacts/odysseus-shell/src/hooks/use-audio-devices.ts`)
New hook — `useAudioDevices()`:
- `navigator.mediaDevices.enumerateDevices()` for mic + speaker lists
- Persists selected deviceIds in `localStorage` (`foulfox:voice:micDeviceId` / `foulfox:voice:speakerDeviceId`)
- Feature-detects `HTMLAudioElement.setSinkId` for output routing (Chromium only)
- Re-enumerates on `devicechange` events (hot-plug)

### VoiceForgeWidget integration
- `getUserMedia` now passes `{ deviceId: { exact: selectedMic } }` when a non-default mic is selected
- `audio.setSinkId(selectedSpeaker)` called before `audio.play()` for TTS output routing
- Gear icon (⚙) in panel header opens an inline device section with mic/speaker dropdowns
- "Grant access" button calls `requestPermission()` to get labelled device names on first use

**Why:** Browsers hide device labels until `getUserMedia` permission is granted; the hook handles this gracefully and re-enumerates after first record.

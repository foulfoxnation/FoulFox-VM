"""
FoulFox OS — Comprehensive functional-capability diagnostic engine.

Each check evaluates whether a core system is actually doing its intended job,
not just whether a process is alive.  Results carry a `category` field so the
UI and the fix-loop can group them meaningfully.

Check result shape:
  { id, category, name, status ("ok"|"warn"|"fail"|"unknown"), detail, value }
"""
from __future__ import annotations

import asyncio
import json
import os
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

# ── Result helpers ──────────────────────────────────────────────────────────────

def _r(id: str, cat: str, name: str, status: str, detail: str, value: Any = None) -> dict:
    return {"id": id, "category": cat, "name": name,
            "status": status, "detail": detail, "value": value}

def _ok(id, cat, name, detail, value=None):    return _r(id, cat, name, "ok",      detail, value)
def _warn(id, cat, name, detail, value=None):  return _r(id, cat, name, "warn",    detail, value)
def _fail(id, cat, name, detail, value=None):  return _r(id, cat, name, "fail",    detail, value)
def _unk(id, cat, name, detail="check could not run", value=None):
    return _r(id, cat, name, "unknown", detail, value)

# ── Subprocess helper ───────────────────────────────────────────────────────────

async def _cmd(args: list[str], timeout: float = 10.0) -> tuple[int, str, str]:
    try:
        proc = await asyncio.create_subprocess_exec(
            *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        return proc.returncode, stdout.decode(errors="replace").strip(), stderr.decode(errors="replace").strip()
    except asyncio.TimeoutError:
        return -1, "", "timeout"
    except FileNotFoundError:
        return -1, "", f"command not found: {args[0]}"
    except Exception as exc:
        return -1, "", str(exc)

# ── HTTP helper (sync, runs in-process thread pool) ────────────────────────────

def _http_get(url: str, timeout: float = 5.0) -> tuple[int, bytes]:
    """Return (http_status, body_bytes).  Raises on connection error."""
    import urllib.request, urllib.error
    try:
        r = urllib.request.urlopen(url, timeout=timeout)
        return r.status, r.read(131072)
    except urllib.error.HTTPError as e:
        return e.code, b""
    except Exception as exc:
        raise exc

async def _json_get(url: str, timeout: float = 5.0) -> Optional[Any]:
    """GET url → parsed JSON or None on any error."""
    loop = asyncio.get_event_loop()
    try:
        status, body = await loop.run_in_executor(None, lambda: _http_get(url, timeout))
        if status < 400:
            return json.loads(body)
    except Exception:
        pass
    return None

def _http_post(url: str, payload: Any = None, timeout: float = 10.0) -> tuple[int, bytes]:
    """POST url with JSON body → (http_status, body_bytes).  Raises on connection error."""
    import urllib.request, urllib.error
    data = json.dumps(payload or {}).encode()
    headers = {"Content-Type": "application/json"}
    # State-changing api-server endpoints (e.g. the generate-keys self-heal)
    # require auth. Send our internal bridge token — the api-server accepts it
    # as X-Odysseus-Internal-Token. Without this every self-heal POST is
    # rejected with "invalid token" and the check can never actually heal.
    try:
        from core.middleware import INTERNAL_TOOL_TOKEN, INTERNAL_TOOL_HEADER
        headers[INTERNAL_TOOL_HEADER] = INTERNAL_TOOL_TOKEN
    except Exception:
        pass
    req  = urllib.request.Request(url, data=data, headers=headers)
    try:
        r = urllib.request.urlopen(req, timeout=timeout)
        return r.status, r.read(131072)
    except urllib.error.HTTPError as e:
        return e.code, e.read(4096)
    except Exception as exc:
        raise exc

async def _json_post(url: str, payload: Any = None, timeout: float = 10.0) -> Optional[Any]:
    """POST url with JSON body → parsed JSON response or None on any error."""
    loop = asyncio.get_event_loop()
    try:
        status, body = await loop.run_in_executor(None, lambda: _http_post(url, payload, timeout))
        if status < 400:
            return json.loads(body)
    except Exception:
        pass
    return None

DATA_DIR = os.environ.get("ODYSSEUS_DATA_DIR", "/var/lib/foulfox")

# ── Service base URLs (read env vars so they work on both the appliance and dev) ─
# Appliance: foulfox.env sets ODYSSEUS_PORT=7000 and PORT=8080 (api-server).
# Replit dev: ODYSSEUS_PORT is the workflow-assigned Odysseus port; API_SERVER_PORT
#   is the Express api-server port (set explicitly by the api-server workflow).
# Never hardcode ports here — old images used 5001 which is now retired.
ODYSSEUS = f"http://127.0.0.1:{os.environ.get('ODYSSEUS_PORT', '7000')}"
API      = f"http://127.0.0.1:{os.environ.get('API_SERVER_PORT', '8080')}"

# ════════════════════════════════════════════════════════════════════════════════
# CATEGORY 1 — FoulFox OS Foundation
# ════════════════════════════════════════════════════════════════════════════════
CAT_OS = "foulfox_os"

async def check_os_version() -> dict:
    for path in ["/etc/foulfox-version", "/etc/foulfox/version",
                 os.path.join(DATA_DIR, ".version")]:
        if os.path.exists(path):
            ver = open(path).read().strip()
            return _ok("os_version", CAT_OS, "OS Version", f"FoulFox {ver}", ver)
    rc, out, _ = await _cmd(["cat", "/etc/os-release"])
    for line in (out or "").splitlines():
        if line.startswith("PRETTY_NAME="):
            val = line.split("=", 1)[1].strip('"')
            return _warn("os_version", CAT_OS, "OS Version",
                         f"No FoulFox version file; base OS: {val}")
    return _unk("os_version", CAT_OS, "OS Version", "Version file not found")

async def check_boot_type() -> dict:
    rc, fstype, _ = await _cmd(["findmnt", "-n", "-o", "FSTYPE", "/"])
    is_live = (rc == 0) and (fstype in ("overlay", "overlayfs", "aufs", "tmpfs"))
    if is_live:
        return _warn("boot_type", CAT_OS, "Boot Type",
                     "Running from Live USB — install to disk for persistence", "live")
    if rc == 0:
        return _ok("boot_type", CAT_OS, "Boot Type",
                   f"Installed to disk (fstype={fstype})", "disk")
    return _unk("boot_type", CAT_OS, "Boot Type", "findmnt unavailable")

async def check_kvm() -> dict:
    if os.path.exists("/dev/kvm"):
        return _ok("kvm", CAT_OS, "KVM Hardware Acceleration",
                   "/dev/kvm present — VMs run at full speed")
    return _fail("kvm", CAT_OS, "KVM Hardware Acceleration",
                 "No /dev/kvm — VMs will be extremely slow; enable VT-x/AMD-V in BIOS")

async def check_data_partition() -> dict:
    rc, out, _ = await _cmd(["df", "-h", DATA_DIR])
    if rc != 0:
        return _fail("data_partition", CAT_OS, "Data Partition",
                     f"{DATA_DIR} not mounted — persistence unavailable")
    lines = out.splitlines()
    if len(lines) >= 2:
        parts = lines[1].split()
        if len(parts) >= 5:
            try:
                pct = int(parts[4].rstrip("%"))
                st = "ok" if pct < 80 else ("warn" if pct < 92 else "fail")
                return _r("data_partition", CAT_OS, "Data Partition", st,
                          f"{parts[2]} used / {parts[1]} total ({pct}%)", pct)
            except ValueError:
                pass
    return _ok("data_partition", CAT_OS, "Data Partition", out)

async def check_root_disk() -> dict:
    rc, out, _ = await _cmd(["df", "-h", "/"])
    if rc != 0:
        return _fail("root_disk", CAT_OS, "Root Disk", "df / failed")
    lines = out.splitlines()
    if len(lines) >= 2:
        parts = lines[1].split()
        if len(parts) >= 5:
            try:
                pct = int(parts[4].rstrip("%"))
                st = "ok" if pct < 80 else ("warn" if pct < 92 else "fail")
                return _r("root_disk", CAT_OS, "Root Disk", st,
                          f"{parts[2]} used / {parts[1]} total ({pct}%)", pct)
            except ValueError:
                pass
    return _unk("root_disk", CAT_OS, "Root Disk")

async def check_api_server() -> dict:
    # Try /api/healthz first (Express api-server route), then /api/health fallback.
    # The port is read from API_SERVER_PORT env var (default 8080) so this
    # works on both the appliance and Replit dev without hardcoding.
    port = os.environ.get('API_SERVER_PORT', '8080')
    for path in ("/api/healthz", "/api/health", "/api/status"):
        data = await _json_get(f"{API}{path}", timeout=4)
        if data is not None:
            return _ok("api_server", CAT_OS, "API Server",
                       f"Responding on :{port}", data)
    return _fail("api_server", CAT_OS, "API Server",
                 f"Not reachable on :{port} — shell UI cannot function")

async def check_odysseus_service() -> dict:
    data = await _json_get(f"{ODYSSEUS}/api/agent-suite/state")
    if data is not None and isinstance(data, dict):
        suite = data.get("suite", {}) or {}
        if not isinstance(suite, dict):
            suite = {}
        port = os.environ.get("ODYSSEUS_PORT", "7000")
        roles = [r for r, v in suite.items() if isinstance(v, dict) and v.get("model")]
        return _ok("odysseus_svc", CAT_OS, "Odysseus AI Service",
                   f"Running on :{port}; {len(roles)} agent role(s) configured" if roles
                   else f"Running on :{port} (no model configured yet)")
    if data is not None:
        # Endpoint responded but returned non-dict JSON
        return _warn("odysseus_svc", CAT_OS, "Odysseus AI Service",
                     "Service reachable but returned unexpected response format")
    return _fail("odysseus_svc", CAT_OS, "Odysseus AI Service",
                 "Not reachable — AI features unavailable")

async def check_live_updater() -> dict:
    pending = os.path.join(DATA_DIR, ".update-pending")
    applied = os.path.join(DATA_DIR, ".update-applied")
    if os.path.exists(pending):
        return _warn("live_update", CAT_OS, "Live Updater",
                     "Update pending — will apply on next restart")
    if os.path.exists(applied):
        age_h = (time.time() - os.path.getmtime(applied)) / 3600
        return _ok("live_update", CAT_OS, "Live Updater",
                   f"Last update applied {age_h:.1f}h ago")
    return _ok("live_update", CAT_OS, "Live Updater", "Up-to-date (no pending updates)")

async def check_network() -> dict:
    rc, _, _ = await _cmd(["ping", "-c", "1", "-W", "3", "8.8.8.8"])
    if rc == 0:
        return _ok("network", CAT_OS, "Internet Connectivity",
                   "Online — Reachable (ping 8.8.8.8 OK)")
    loop = asyncio.get_event_loop()
    try:
        await asyncio.wait_for(loop.getaddrinfo("github.com", 443), timeout=5)
        return _ok("network", CAT_OS, "Internet Connectivity",
                   "Online — DNS resolving (ICMP may be blocked)")
    except Exception:
        pass
    return _fail("network", CAT_OS, "Internet Connectivity",
                 "No internet — updates, model downloads, and Replit reporting unavailable")


# ════════════════════════════════════════════════════════════════════════════════
# CATEGORY 2 — Voice Forge
# ════════════════════════════════════════════════════════════════════════════════
CAT_VOICE = "voice_forge"

async def check_stt() -> dict:
    data = await _json_get(f"{ODYSSEUS}/api/stt/stats")
    if data is None:
        return _fail("stt", CAT_VOICE, "Speech-to-Text Engine",
                     "STT service not responding — voice input unavailable",
                     {"endpoint": f"{ODYSSEUS}/api/stt/stats", "result": "no response"})
    provider = data.get("provider", "unknown")
    enabled  = data.get("enabled", False)
    if not enabled:
        return _warn("stt", CAT_VOICE, "Speech-to-Text Engine",
                     f"STT loaded ({provider}) but disabled — enable in Settings → Voice", data)
    return _ok("stt", CAT_VOICE, "Speech-to-Text Engine",
               f"Active — provider: {provider}", data)

async def check_tts() -> dict:
    data = await _json_get(f"{ODYSSEUS}/api/tts/stats")
    if data is None:
        return _fail("tts", CAT_VOICE, "Text-to-Speech Engine",
                     "TTS service not responding — voice output unavailable",
                     {"endpoint": f"{ODYSSEUS}/api/tts/stats", "result": "no response"})
    provider = data.get("provider", "unknown")
    enabled  = data.get("enabled", False)
    if not enabled:
        return _warn("tts", CAT_VOICE, "Text-to-Speech Engine",
                     f"TTS loaded ({provider}) but disabled — enable in Settings → Voice", data)
    return _ok("tts", CAT_VOICE, "Text-to-Speech Engine",
               f"Active — provider: {provider}", data)

async def check_audio_hw() -> dict:
    # PulseAudio runs as a user-mode daemon. The diagnostic service may not
    # inherit XDG_RUNTIME_DIR or DBUS_SESSION_BUS_ADDRESS from the graphical
    # session, so pactl reports "Connection refused" even when the daemon is up.
    # Derive the uid at runtime and set all three env vars explicitly.
    uid_rc, uid_out, _ = await _cmd(["id", "-u"])
    uid = uid_out.strip() if uid_rc == 0 and uid_out.strip().isdigit() else "1000"
    xdg = f"/run/user/{uid}"
    pactl_env = (
        f"XDG_RUNTIME_DIR={xdg} "
        f"DBUS_SESSION_BUS_ADDRESS=unix:path={xdg}/bus "
        f"PULSE_RUNTIME_PATH={xdg}/pulse "
    )
    rc, pactl_out, _ = await _cmd(["bash", "-c", f"{pactl_env}pactl info 2>&1"])
    if rc == 0 and "Server Name" in pactl_out:
        sink = "unknown"
        for line in pactl_out.splitlines():
            if "Default Sink:" in line:
                sink = line.split(":", 1)[1].strip()
        return _ok("audio_hw", CAT_VOICE, "Audio Hardware (PulseAudio)",
                   f"Running — default sink: {sink}",
                   {"sink": sink, "xdg": xdg, "pactl_snippet": pactl_out[:400]})
    # Socket unreachable — collect rich context for debugging
    _, ps_out, _ = await _cmd(["bash", "-c", "ps aux | grep -i pulse | grep -v grep"])
    _, socket_ls, _ = await _cmd(
        ["bash", "-c", f"ls -la {xdg}/pulse/ 2>/dev/null || echo '(directory missing)'"])
    _, journal, _ = await _cmd(
        ["bash", "-c",
         "journalctl _SYSTEMD_USER_UNIT=pulseaudio.service -n 10 --no-pager 2>&1 | tail -10 || "
         "journalctl -u pulseaudio -n 10 --no-pager 2>&1 | tail -10"])
    return _fail("audio_hw", CAT_VOICE, "Audio Hardware (PulseAudio)",
                 "PulseAudio socket unreachable — microphone and speaker unavailable",
                 {"pactl_rc": rc,
                  "pactl_output": pactl_out[:400] or "no output",
                  "xdg_runtime": xdg,
                  "pulse_socket_dir": socket_ls[:300],
                  "pulse_processes": ps_out[:400] or "none found",
                  "journal": journal[:400] or "unavailable"})


# ════════════════════════════════════════════════════════════════════════════════
# CATEGORY 3 — Llama Llama Studio
# ════════════════════════════════════════════════════════════════════════════════
CAT_LLAMA = "llama_llama"

async def check_ollama() -> dict:
    for host in [f"{ODYSSEUS}/api/ollama/api/tags",
                 "http://127.0.0.1:11434/api/tags",
                 "http://host.docker.internal:11434/api/tags"]:
        data = await _json_get(host, timeout=4)
        if data is not None:
            models = [m.get("name", "?") for m in data.get("models", [])]
            if not models:
                return _warn("ollama", CAT_LLAMA, "Ollama Engine",
                             "Running but no models pulled — pull a model to use Llama Llama")
            return _ok("ollama", CAT_LLAMA, "Ollama Engine",
                       f"{len(models)} model(s): {', '.join(models[:4])}", models)
    return _fail("ollama", CAT_LLAMA, "Ollama Engine",
                 "Ollama not running — start it or install via the Cookbook")

async def check_llama_model() -> dict:
    """Check specifically for a llama-family model."""
    for host in ["http://127.0.0.1:11434/api/tags"]:
        data = await _json_get(host, timeout=4)
        if data is not None:
            models = [m.get("name", "") for m in data.get("models", [])]
            llama_models = [m for m in models
                            if any(k in m.lower() for k in ("llama", "mistral", "qwen", "phi", "gemma", "deepseek"))]
            if llama_models:
                return _ok("llama_model", CAT_LLAMA, "Local AI Model",
                           f"Llama-family model ready: {llama_models[0]}", llama_models)
            if models:
                return _warn("llama_model", CAT_LLAMA, "Local AI Model",
                             f"Models present but none are llama-family: {models[0]}", models)
            return _fail("llama_model", CAT_LLAMA, "Local AI Model",
                         "No models downloaded — run `ollama pull llama3.2` or use the Cookbook")
    return _unk("llama_model", CAT_LLAMA, "Local AI Model", "Ollama not reachable")

async def check_llama_studio_app() -> dict:
    # Correct endpoints: api-server exposes /api/apps, Odysseus exposes /api/foulfox-apps
    data = await _json_get(f"{API}/api/apps", timeout=5)
    if data is None:
        data = await _json_get(f"{ODYSSEUS}/api/foulfox-apps", timeout=5)
    if data is None:
        return _unk("llama_studio", CAT_LLAMA, "Llama Llama Studio App",
                    "App list unavailable",
                    {"tried": [f"{API}/api/apps", f"{ODYSSEUS}/api/foulfox-apps"]})
    apps = data if isinstance(data, list) else data.get("apps", [])
    all_ids = [str(a.get("id", "")) for a in apps]
    for app in apps:
        aid = str(app.get("id", "")).lower()
        if "llama" in aid or "studio" in aid:
            st = app.get("status", "unknown")
            if st == "running":
                return _ok("llama_studio", CAT_LLAMA, "Llama Llama Studio App",
                           f"Running (id={app.get('id')})", app)
            return _warn("llama_studio", CAT_LLAMA, "Llama Llama Studio App",
                         f"Installed but not running (status={st}) — open the Apps tab to launch",
                         {"app": app, "all_app_ids": all_ids})
    return _warn("llama_studio", CAT_LLAMA, "Llama Llama Studio App",
                 "Not installed — install from the App Store in the Apps tab",
                 {"installed_apps": all_ids})


# ════════════════════════════════════════════════════════════════════════════════
# CATEGORY 4 — Windows 11 VM
# ════════════════════════════════════════════════════════════════════════════════
CAT_WIN = "windows_vm"

async def _get_vms() -> Optional[list]:
    data = await _json_get(f"{API}/api/vm/list")
    if data is None:
        return None
    return data if isinstance(data, list) else data.get("vms", [])

async def check_windows_vm_exists() -> dict:
    vms = await _get_vms()
    if vms is None:
        return _fail("win_vm_exists", CAT_WIN, "Windows 11 VM",
                     "VM list unavailable — API server not responding")
    win_vms = [v for v in vms if str(v.get("osKind", "")).lower() == "windows"]
    if not win_vms:
        return _fail("win_vm_exists", CAT_WIN, "Windows 11 VM",
                     "No Windows VM configured — create one from + New VM in the taskbar")
    v = win_vms[0]
    return _ok("win_vm_exists", CAT_WIN, "Windows 11 VM",
               f"'{v.get('name')}' exists (id={v.get('id')})", v)

async def check_windows_vm_running() -> dict:
    vms = await _get_vms()
    if vms is None:
        return _unk("win_vm_running", CAT_WIN, "Windows VM State", "VM list unavailable")
    win_vms = [v for v in vms if str(v.get("osKind", "")).lower() == "windows"]
    if not win_vms:
        return _fail("win_vm_running", CAT_WIN, "Windows VM State",
                     "No Windows VM — create one first")
    v = win_vms[0]
    state = v.get("state", "unknown")
    if state == "running":
        return _ok("win_vm_running", CAT_WIN, "Windows VM State",
                   f"'{v.get('name')}' running — display available via noVNC", state)
    if state == "stopped":
        return _warn("win_vm_running", CAT_WIN, "Windows VM State",
                     f"'{v.get('name')}' stopped — start it from the VM tab", state)
    return _warn("win_vm_running", CAT_WIN, "Windows VM State",
                 f"'{v.get('name')}' state: {state}", state)

async def check_windows_vm_display() -> dict:
    vms = await _get_vms()
    if vms is None:
        return _unk("win_vm_display", CAT_WIN, "Windows VM Display (noVNC)")
    win_vms = [v for v in vms if str(v.get("osKind", "")).lower() == "windows"]
    if not win_vms:
        return _unk("win_vm_display", CAT_WIN, "Windows VM Display (noVNC)",
                    "No Windows VM exists")
    v = win_vms[0]
    if v.get("state") != "running":
        return _warn("win_vm_display", CAT_WIN, "Windows VM Display (noVNC)",
                     "VM not running — start it to get a display")
    vnc_port = v.get("vncPort")
    if vnc_port:
        rc, _, _ = await _cmd(["nc", "-z", "127.0.0.1", str(vnc_port)], timeout=3)
        if rc == 0:
            return _ok("win_vm_display", CAT_WIN, "Windows VM Display (noVNC)",
                       f"VNC port {vnc_port} open — noVNC display available")
        return _warn("win_vm_display", CAT_WIN, "Windows VM Display (noVNC)",
                     f"VNC port {vnc_port} not responding yet (VM still booting?)")
    return _ok("win_vm_display", CAT_WIN, "Windows VM Display (noVNC)",
               "Running — VNC port will be assigned by VM launcher")


# ════════════════════════════════════════════════════════════════════════════════
# CATEGORY 5 — Agent → Windows VM (socket / shell bridge)
# ════════════════════════════════════════════════════════════════════════════════
CAT_AGENT_VM = "agent_vm_socket"

async def check_agent_vm_key() -> dict:
    """Check whether an SSH key is provisioned for the Windows VM.

    Keys are stored per-VM at <vmDiskDir>/<vm_id>/agent_ed25519. When missing,
    this check self-heals by calling POST /api/vm/:id/generate-keys — no manual
    action required from the user.
    """
    vms = await _get_vms()
    vm_dir_root = os.path.join(DATA_DIR, ".odysseus-vms")

    if vms is None:
        _, find_out, _ = await _cmd(
            ["bash", "-c",
             f"find {DATA_DIR} -name 'agent_ed25519' 2>/dev/null | head -10"])
        return _fail("agent_vm_key", CAT_AGENT_VM, "Agent→VM SSH Key",
                     "VM list unavailable — cannot check SSH key status",
                     {"filesystem_scan": find_out[:400] or "none found"})

    keyed_vms, unkeyed_vms = [], []
    for vm in vms:
        vm_id    = vm.get("id", "")
        key_path = vm.get("sshKeyPath")
        auth_mode = vm.get("authMode", "none")
        # Primary: sshKeyPath from API config
        if key_path and os.path.isfile(key_path):
            keyed_vms.append({"id": vm_id, "key_path": key_path, "auth_mode": auth_mode})
            continue
        # Fallback: check the known default filesystem location
        candidate = os.path.join(vm_dir_root, vm_id, "agent_ed25519")
        if os.path.isfile(candidate):
            keyed_vms.append({"id": vm_id, "key_path": candidate,
                              "auth_mode": auth_mode, "source": "fallback_scan"})
            continue
        unkeyed_vms.append({"id": vm_id, "auth_mode": auth_mode,
                             "checked_path": candidate})

    if keyed_vms:
        desc = ", ".join(f"'{v['id']}'" for v in keyed_vms[:3])
        return _ok("agent_vm_key", CAT_AGENT_VM, "Agent→VM SSH Key",
                   f"SSH key provisioned for {desc}",
                   {"keyed_vms": keyed_vms, "unkeyed_vms": unkeyed_vms})

    # ── Self-heal: call the generate-keys endpoint for each VM that lacks a key ──
    healed, heal_errors = [], []
    for info in unkeyed_vms:
        vm_id = info["id"]
        result = await _json_post(f"{API}/api/vm/{vm_id}/generate-keys", timeout=15)
        if result and result.get("sshKeyPath"):
            healed.append({"id": vm_id, "key_path": result["sshKeyPath"]})
        else:
            heal_errors.append({"id": vm_id, "response": result})

    if healed:
        desc = ", ".join(f"'{v['id']}'" for v in healed)
        return _ok("agent_vm_key", CAT_AGENT_VM, "Agent→VM SSH Key",
                   f"SSH key generated automatically for {desc} — agent can now authenticate",
                   {"auto_generated": healed, "errors": heal_errors})

    return _fail("agent_vm_key", CAT_AGENT_VM, "Agent→VM SSH Key",
                 "Could not generate SSH key — ssh-keygen may be missing "
                 "(install openssh-client on FoulFox OS)",
                 {"unkeyed_vms": unkeyed_vms,
                  "generate_errors": heal_errors,
                  "vm_dir_root": vm_dir_root})

async def check_agent_vm_shell() -> dict:
    """Check if the VM shell bridge endpoint is configured and working."""
    data = await _json_get(f"{API}/api/vm/list")
    if data is None:
        return _unk("agent_vm_shell", CAT_AGENT_VM, "Agent→VM Shell Bridge",
                    "VM list unavailable")
    vms = data if isinstance(data, list) else data.get("vms", [])
    win_vms = [v for v in vms if str(v.get("osKind", "")).lower() == "windows"]
    if not win_vms:
        return _fail("agent_vm_shell", CAT_AGENT_VM, "Agent→VM Shell Bridge",
                     "No Windows VM — create one so the agent has a target")
    v = win_vms[0]
    if v.get("state") != "running":
        return _warn("agent_vm_shell", CAT_AGENT_VM, "Agent→VM Shell Bridge",
                     f"Windows VM '{v.get('name')}' not running — start it for agent access")
    # Check the shell exec bridge endpoint exists
    vm_id = v.get("id", "")
    loop = asyncio.get_event_loop()
    try:
        status, _ = await loop.run_in_executor(
            None,
            lambda: _http_get(f"{API}/api/vm/{vm_id}/agent/health", timeout=3)
        )
        if status < 400:
            return _ok("agent_vm_shell", CAT_AGENT_VM, "Agent→VM Shell Bridge",
                       f"Agent health endpoint OK for VM {vm_id}")
        return _warn("agent_vm_shell", CAT_AGENT_VM, "Agent→VM Shell Bridge",
                     f"Bridge endpoint returned HTTP {status} — Windows agent may not be running yet")
    except Exception as exc:
        return _warn("agent_vm_shell", CAT_AGENT_VM, "Agent→VM Shell Bridge",
                     f"Bridge check failed: {exc}")

async def check_agent_vm_workspace_mode() -> dict:
    """Check whether the agent workspace mode is targeting Windows."""
    try:
        from src.vm_target import get_workspace_mode
        mode = get_workspace_mode()
        if mode == "windows":
            return _ok("agent_vm_mode", CAT_AGENT_VM, "Agent Workspace Mode",
                       "Agent is targeting Windows VM by default", {"mode": mode})
        return _warn("agent_vm_mode", CAT_AGENT_VM, "Agent Workspace Mode",
                     f"Agent targeting '{mode}' — toggle to 'Windows VM' in the chat header",
                     {"mode": mode})
    except ImportError as e:
        return _unk("agent_vm_mode", CAT_AGENT_VM, "Agent Workspace Mode",
                    "vm_target module not found — workspace mode unavailable",
                    {"import_error": str(e)})
    except Exception as e:
        return _unk("agent_vm_mode", CAT_AGENT_VM, "Agent Workspace Mode",
                    f"Could not read workspace mode: {e}",
                    {"error": str(e)})


# ════════════════════════════════════════════════════════════════════════════════
# CATEGORY 6 — Agent → FoulFox OS (host capability)
# ════════════════════════════════════════════════════════════════════════════════
CAT_AGENT_HOST = "agent_foulfox"

async def check_agent_bash() -> dict:
    """Verify the agent can actually run host bash commands."""
    rc, out, _ = await _cmd(["bash", "-c", "echo foulfox_diag_ok && whoami"])
    if rc == 0 and "foulfox_diag_ok" in out:
        user = out.splitlines()[-1] if out else "?"
        return _ok("agent_bash", CAT_AGENT_HOST, "Agent Host Shell (bash)",
                   f"Agent can run host commands as {user}")
    return _fail("agent_bash", CAT_AGENT_HOST, "Agent Host Shell (bash)",
                 "bash execution failed — agent cannot control the host")

async def check_agent_file_io() -> dict:
    test_path = "/tmp/foulfox_diag_test"
    try:
        with open(test_path, "w") as f:
            f.write("ok")
        val = open(test_path).read()
        os.unlink(test_path)
        if val == "ok":
            return _ok("agent_fileio", CAT_AGENT_HOST, "Agent File I/O",
                       "Agent can read and write files on the host")
    except Exception as exc:
        return _fail("agent_fileio", CAT_AGENT_HOST, "Agent File I/O",
                     f"File I/O failed: {exc}")
    return _fail("agent_fileio", CAT_AGENT_HOST, "Agent File I/O",
                 "Read/write verification failed")

async def check_agent_web_fetch() -> dict:
    data = await _json_get("https://api.github.com", timeout=6)
    if data is not None:
        return _ok("agent_webfetch", CAT_AGENT_HOST, "Agent Web Fetch",
                   "Agent can reach the internet and fetch web content")
    # Try a simpler check
    rc, _, _ = await _cmd(["curl", "-sf", "-o", "/dev/null", "-w", "%{http_code}",
                            "--max-time", "5", "https://github.com"])
    if rc == 0:
        return _ok("agent_webfetch", CAT_AGENT_HOST, "Agent Web Fetch",
                   "curl can reach github.com")
    return _fail("agent_webfetch", CAT_AGENT_HOST, "Agent Web Fetch",
                 "Cannot fetch web content — research and model downloads will fail")


# ════════════════════════════════════════════════════════════════════════════════
# CATEGORY 7 — Windows VM Backups
# ════════════════════════════════════════════════════════════════════════════════
CAT_BACKUP = "vm_backups"

async def check_backup_dir() -> dict:
    backup_root = os.path.join(DATA_DIR, "vm-backups", "windows")
    if not os.path.isdir(backup_root):
        return _fail("backup_dir", CAT_BACKUP, "VM Backup Directory",
                     f"No backup directory at {backup_root} — Windows VM file backups have never run")
    entries = os.listdir(backup_root)
    if not entries:
        return _warn("backup_dir", CAT_BACKUP, "VM Backup Directory",
                     f"Backup directory exists but is empty — no backups taken yet")
    return _ok("backup_dir", CAT_BACKUP, "VM Backup Directory",
               f"{len(entries)} backup snapshot(s) at {backup_root}", entries[-4:])

async def check_backup_age() -> dict:
    backup_root = os.path.join(DATA_DIR, "vm-backups", "windows")
    if not os.path.isdir(backup_root):
        return _fail("backup_age", CAT_BACKUP, "Last Backup Age",
                     "No backups exist — critical Windows files are not protected")
    # Find most recent file recursively
    newest_ts = 0.0
    for dirpath, _, files in os.walk(backup_root):
        for fname in files:
            try:
                mtime = os.path.getmtime(os.path.join(dirpath, fname))
                if mtime > newest_ts:
                    newest_ts = mtime
            except OSError:
                pass
    if newest_ts == 0:
        return _warn("backup_age", CAT_BACKUP, "Last Backup Age",
                     "Backup directory empty — no files backed up yet")
    age_h = (time.time() - newest_ts) / 3600
    if age_h < 24:
        return _ok("backup_age", CAT_BACKUP, "Last Backup Age",
                   f"Last backup {age_h:.1f}h ago — up to date", age_h)
    if age_h < 168:  # 7 days
        return _warn("backup_age", CAT_BACKUP, "Last Backup Age",
                     f"Last backup {age_h/24:.1f} days ago — consider more frequent backups")
    return _fail("backup_age", CAT_BACKUP, "Last Backup Age",
                 f"Last backup {age_h/24:.0f} days ago — critical files may be stale")


# ════════════════════════════════════════════════════════════════════════════════
# CATEGORY 8 — Voice + Agent Full Integration
# ════════════════════════════════════════════════════════════════════════════════
CAT_VOICE_AGENT = "voice_agent"

async def check_voice_agent_loop() -> dict:
    """STT + TTS both enabled = full voice↔agent loop possible."""
    stt = await _json_get(f"{ODYSSEUS}/api/stt/stats")
    tts = await _json_get(f"{ODYSSEUS}/api/tts/stats")
    stt_ok = stt and stt.get("enabled")
    tts_ok = tts and tts.get("enabled")
    if stt_ok and tts_ok:
        return _ok("voice_loop", CAT_VOICE_AGENT, "Voice ↔ Agent Loop",
                   f"Full loop ready — STT({stt.get('provider')}) → Agent → TTS({tts.get('provider')})",
                   {"stt": stt, "tts": tts})
    missing = []
    if not stt_ok: missing.append("STT")
    if not tts_ok: missing.append("TTS")
    return _warn("voice_loop", CAT_VOICE_AGENT, "Voice ↔ Agent Loop",
                 f"Incomplete — {' and '.join(missing)} not enabled; enable in Settings → Voice",
                 {"stt": stt or "no response", "tts": tts or "no response"})

async def check_voice_model() -> dict:
    """Is there a model configured so the voice agent can actually respond?"""
    data = await _json_get(f"{ODYSSEUS}/api/agent-suite/state")
    if data is None:
        return _unk("voice_model", CAT_VOICE_AGENT, "AI Model for Voice Responses",
                    "Agent suite endpoint unavailable",
                    {"endpoint": f"{ODYSSEUS}/api/agent-suite/state"})
    suite = data.get("suite") or {}
    # Model lives on the CrewMember linked via each member's crew_member_id.
    # The /state response now includes model on each member after the route fix.
    members = suite.get("members", [])
    models_by_role = {m.get("role"): m.get("model") for m in members if m.get("model")}
    if models_by_role:
        desc = ", ".join(f"{r}={m}" for r, m in list(models_by_role.items())[:3])
        return _ok("voice_model", CAT_VOICE_AGENT, "AI Model for Voice Responses",
                   f"Models configured: {desc}", {"models": models_by_role})
    if suite.get("setup_complete"):
        return _ok("voice_model", CAT_VOICE_AGENT, "AI Model for Voice Responses",
                   "Suite setup complete — model provisioned",
                   {"setup_complete": True, "members": len(members)})
    return _fail("voice_model", CAT_VOICE_AGENT, "AI Model for Voice Responses",
                 "Setup wizard not complete — voice agent has no model assigned. "
                 "Open Setup, pick Ollama, select llama3.1:8b-instruct-q4_K_M",
                 {"setup_complete": False, "members": len(members),
                  "hint": "Settings → Setup → pick Local Ollama → llama3.1:8b-instruct-q4_K_M"})

async def check_chromium_cdp() -> dict:
    data = await _json_get("http://127.0.0.1:9222/json/version", timeout=3)
    if data is not None:
        browser = data.get("Browser", "?")
        v8 = data.get("V8-Version", "?")
        return _ok("chromium_cdp", CAT_VOICE_AGENT, "Kiosk Browser CDP",
                   f"CDP available — {browser}",
                   {"browser": browser, "v8": v8, "full": data})
    rc, _, _ = await _cmd(["bash", "-c", "nc -z 127.0.0.1 9222 && echo open || echo closed"])
    _, ps_out, _ = await _cmd(
        ["bash", "-c", "ps aux | grep -E 'chromium|chrome' | grep -v grep | head -3"])
    return _warn("chromium_cdp", CAT_VOICE_AGENT, "Kiosk Browser CDP",
                 "CDP not available on :9222 — browser automation disabled",
                 {"port_9222": "open" if rc == 0 else "closed",
                  "chromium_procs": ps_out[:400] or "none found"})


# ════════════════════════════════════════════════════════════════════════════════
# CATEGORY 9 — Agent Memory & Lessons
# ════════════════════════════════════════════════════════════════════════════════
CAT_MEMORY = "agent_memory"

async def check_agent_lessons() -> dict:
    data = await _json_get(f"{ODYSSEUS}/api/agent-lessons")
    if data is None:
        return _unk("agent_lessons", CAT_MEMORY, "Agent Lessons",
                    "Lessons endpoint unavailable")
    count = data.get("count", 0)
    if count == 0:
        return _warn("agent_lessons", CAT_MEMORY, "Agent Lessons",
                     "No lessons stored yet — agent hasn't learned from tasks; "
                     "complete a few tasks to start building experience")
    # Check recency
    lessons = data.get("lessons", [])
    if lessons:
        newest = max((l.get("created_at", "") or "" for l in lessons), default="")
        return _ok("agent_lessons", CAT_MEMORY, "Agent Lessons",
                   f"{count} lesson(s) stored; latest: {newest[:10] or 'unknown'}", count)
    return _ok("agent_lessons", CAT_MEMORY, "Agent Lessons",
               f"{count} lesson(s) stored", count)

async def check_agent_notes() -> dict:
    data = await _json_get(f"{ODYSSEUS}/api/notes")
    if data is None:
        return _unk("agent_notes", CAT_MEMORY, "Agent Notes",
                    "Notes endpoint unavailable")
    notes = data if isinstance(data, list) else data.get("notes", [])
    count = len(notes)
    if count == 0:
        return _warn("agent_notes", CAT_MEMORY, "Agent Notes",
                     "No notes stored — agent hasn't saved any knowledge yet")
    return _ok("agent_notes", CAT_MEMORY, "Agent Notes",
               f"{count} note(s) stored in the knowledge base", count)

async def check_agent_memory_db() -> dict:
    data = await _json_get(f"{ODYSSEUS}/api/memory")
    if data is None:
        return _unk("agent_memdb", CAT_MEMORY, "Agent Memory (Long-term)",
                    "Memory endpoint unavailable")
    memories = data if isinstance(data, list) else data.get("memories", [])
    count = len(memories)
    if count == 0:
        return _warn("agent_memdb", CAT_MEMORY, "Agent Memory (Long-term)",
                     "No long-term memories — agent forgets context between sessions; "
                     "use the agent regularly to build memory")
    pinned = sum(1 for m in memories if (m.get("pinned") if isinstance(m, dict) else False))
    return _ok("agent_memdb", CAT_MEMORY, "Agent Memory (Long-term)",
               f"{count} memories ({pinned} pinned)", count)

async def check_semantic_search() -> dict:
    """ChromaDB semantic search for knowledge retrieval."""
    try:
        import chromadb  # noqa: F401
        chroma_dir = os.path.join(DATA_DIR, "chroma")
        if os.path.isdir(chroma_dir):
            return _ok("semantic_search", CAT_MEMORY, "Semantic Knowledge Search",
                       f"ChromaDB embedded store ready at {chroma_dir}")
        return _warn("semantic_search", CAT_MEMORY, "Semantic Knowledge Search",
                     "ChromaDB available but no data directory yet — search indexes will build as notes are added")
    except ImportError:
        return _fail("semantic_search", CAT_MEMORY, "Semantic Knowledge Search",
                     "ChromaDB not installed — semantic search unavailable; "
                     "install via: uv pip install chromadb")


# ════════════════════════════════════════════════════════════════════════════════
# CATEGORY 10 — Agent Learning & Improvement
# ════════════════════════════════════════════════════════════════════════════════
CAT_LEARN = "agent_learning"

async def check_skills() -> dict:
    data = await _json_get(f"{ODYSSEUS}/api/skills")
    if data is None:
        return _unk("skills", CAT_LEARN, "Agent Skills Library",
                    "Skills endpoint unavailable")
    skills = data if isinstance(data, list) else data.get("skills", [])
    count = len(skills)
    if count == 0:
        return _warn("skills", CAT_LEARN, "Agent Skills Library",
                     "No skills saved — agent is using defaults only; "
                     "have the agent discover and save skills via the Agents tab")
    audited = sum(1 for s in skills if isinstance(s, dict) and s.get("last_audit"))
    return _ok("skills", CAT_LEARN, "Agent Skills Library",
               f"{count} skill(s) stored, {audited} audited/tested", count)

async def check_skill_audit() -> dict:
    data = await _json_get(f"{ODYSSEUS}/api/skills/audit-all/status")
    if data is None:
        return _unk("skill_audit", CAT_LEARN, "Skill Self-Improvement Audit",
                    "Audit status unavailable")
    state = data.get("state", "idle")
    if state == "running":
        pct  = data.get("progress", 0)
        return _ok("skill_audit", CAT_LEARN, "Skill Self-Improvement Audit",
                   f"Audit running — {pct:.0f}% complete (agent is improving skills)")
    if state == "done":
        ts = data.get("finished_at", "")
        return _ok("skill_audit", CAT_LEARN, "Skill Self-Improvement Audit",
                   f"Last audit completed {ts[:10] if ts else 'recently'}")
    return _warn("skill_audit", CAT_LEARN, "Skill Self-Improvement Audit",
                 "No audit has run yet — trigger from the Agents tab to let the agent self-improve")

async def check_self_repair_enabled() -> dict:
    """Is the agent able to fix its own codebase?"""
    data = await _json_get(f"{ODYSSEUS}/api/prefs/self_repair_enabled")
    if data is None:
        return _unk("self_repair", CAT_LEARN, "Self-Repair Capability",
                    "Could not read self-repair preference")
    enabled = data.get("value") if isinstance(data, dict) else data
    if enabled:
        return _ok("self_repair", CAT_LEARN, "Self-Repair Capability",
                   "Agent can fix its own codebase via the self_repair tool")
    return _warn("self_repair", CAT_LEARN, "Self-Repair Capability",
                 "Self-repair disabled — enable in Settings → Agent to allow autonomous code fixes")


# ════════════════════════════════════════════════════════════════════════════════
# CATEGORY 11 — Agent System Awareness
# ════════════════════════════════════════════════════════════════════════════════
CAT_AWARE = "agent_awareness"

async def check_mtm() -> dict:
    """Multi-Task Memory — shared KV + task registry.
    Routes: /api/mtm/tasks, /api/mtm/memory, /api/mtm/context  (no /state endpoint)."""
    tasks_data = await _json_get(f"{ODYSSEUS}/api/mtm/tasks", timeout=4)
    mem_data   = await _json_get(f"{ODYSSEUS}/api/mtm/memory", timeout=4)
    if tasks_data is None and mem_data is None:
        # Fall back to context endpoint
        ctx = await _json_get(f"{ODYSSEUS}/api/mtm/context", timeout=4)
        if ctx is None:
            return _unk("mtm", CAT_AWARE, "Multi-Task Memory (MTM)",
                        "MTM unavailable — all endpoints returned no response",
                        {"tried": [f"{ODYSSEUS}/api/mtm/tasks",
                                   f"{ODYSSEUS}/api/mtm/memory",
                                   f"{ODYSSEUS}/api/mtm/context"]})
        return _ok("mtm", CAT_AWARE, "Multi-Task Memory (MTM)",
                   "MTM reachable (context endpoint)", {"context": ctx})
    tasks = tasks_data if isinstance(tasks_data, list) else (tasks_data or {}).get("tasks", [])
    mem   = mem_data if isinstance(mem_data, dict) else {}
    active = [t for t in tasks if t.get("status") in ("running", "pending")]
    return _ok("mtm", CAT_AWARE, "Multi-Task Memory (MTM)",
               f"Operational — {len(active)} active task(s), {len(mem)} shared memory key(s)",
               {"active_tasks": len(active), "total_tasks": len(tasks),
                "memory_keys": len(mem)})

async def check_research_library() -> dict:
    data = await _json_get(f"{ODYSSEUS}/api/research/library?sort=recent&limit=5")
    if data is None:
        return _unk("research_lib", CAT_AWARE, "Research Library",
                    "Research library unavailable")
    items = data if isinstance(data, list) else data.get("reports", data.get("items", []))
    count = len(items)
    if count == 0:
        return _warn("research_lib", CAT_AWARE, "Research Library",
                     "No research reports — ask the agent to research topics so it builds knowledge")
    return _ok("research_lib", CAT_AWARE, "Research Library",
               f"{count}+ research report(s) available for agent context", count)

async def check_model_configured() -> dict:
    data = await _json_get(f"{ODYSSEUS}/api/agent-suite/state")
    if data is None:
        return _unk("model_config", CAT_AWARE, "AI Model Configuration",
                    "Agent suite state unavailable",
                    {"endpoint": f"{ODYSSEUS}/api/agent-suite/state"})
    if not isinstance(data, dict):
        return _unk("model_config", CAT_AWARE, "AI Model Configuration",
                    "Unexpected response format from agent suite endpoint",
                    {"response_type": type(data).__name__, "raw": str(data)[:300]})
    suite = data.get("suite") or {}
    # Members array contains {role, crew_member_id, model (if route is enriched)}
    members = suite.get("members", []) if isinstance(suite, dict) else []
    models_by_role = {m.get("role"): m.get("model") for m in members if m.get("model")}
    configured_count = len(models_by_role)
    setup_complete = bool(suite.get("setup_complete")) if isinstance(suite, dict) else False
    if models_by_role:
        desc = ", ".join(f"{r}={m}" for r, m in list(models_by_role.items())[:3])
        extra = f" (+{configured_count - 3} more)" if configured_count > 3 else ""
        return _ok("model_config", CAT_AWARE, "AI Model Configuration",
                   f"{configured_count} role(s) configured{extra}: {desc}", models_by_role)
    if setup_complete:
        return _ok("model_config", CAT_AWARE, "AI Model Configuration",
                   f"Suite setup complete with {len(members)} role(s) — model info requires crew member lookup",
                   {"setup_complete": True, "roles": [m.get("role") for m in members]})
    return _fail("model_config", CAT_AWARE, "AI Model Configuration",
                 "Setup wizard not complete — no model assigned to any role. "
                 "Open Setup and pick Ollama → llama3.1:8b-instruct-q4_K_M",
                 {"setup_complete": False,
                  "member_count": len(members),
                  "roles_present": [m.get("role") for m in members],
                  "hint": "Settings → Setup → Local Ollama → llama3.1:8b-instruct-q4_K_M"})


# ════════════════════════════════════════════════════════════════════════════════
# CATEGORY 12 — Sub-Agents: Task Speed
# ════════════════════════════════════════════════════════════════════════════════
CAT_SA_SPEED = "subagents_speed"

async def check_subagent_tool() -> dict:
    """Is spawn_subagents available in the agent's tool set?"""
    try:
        from src.agent_tools import TOOL_TAGS
        if "spawn_subagents" in TOOL_TAGS:
            return _ok("sa_tool", CAT_SA_SPEED, "Sub-Agent Spawn Tool",
                       "spawn_subagents tool available — agent can fan out parallel tasks")
        return _fail("sa_tool", CAT_SA_SPEED, "Sub-Agent Spawn Tool",
                     "spawn_subagents not in TOOL_TAGS — sub-agents cannot be created")
    except Exception as exc:
        return _unk("sa_tool", CAT_SA_SPEED, "Sub-Agent Spawn Tool", str(exc))

async def check_subagent_usage() -> dict:
    """Has the agent actually used sub-agents? Look at MTM task history."""
    data = await _json_get(f"{ODYSSEUS}/api/mtm/tasks", timeout=4)
    if data is None:
        return _unk("sa_usage", CAT_SA_SPEED, "Sub-Agent Usage History",
                    "MTM tasks endpoint unavailable — cannot read task history",
                    {"tried": f"{ODYSSEUS}/api/mtm/tasks"})
    tasks = data if isinstance(data, list) else data.get("tasks", [])
    sub_tasks = [t for t in tasks
                 if str(t.get("kind", "")).lower() in ("worker", "explorer", "subagent")
                    or t.get("parent_id")]
    if sub_tasks:
        return _ok("sa_usage", CAT_SA_SPEED, "Sub-Agent Usage History",
                   f"{len(sub_tasks)} sub-agent task(s) in history — agent is delegating work",
                   {"count": len(sub_tasks), "total_tasks": len(tasks)})
    return _warn("sa_usage", CAT_SA_SPEED, "Sub-Agent Usage History",
                 "No sub-agent tasks in history yet — ask the agent to break a large task "
                 "into parallel sub-agents to see them here",
                 {"total_tasks": len(tasks)})


# ════════════════════════════════════════════════════════════════════════════════
# CATEGORY 13 — Sub-Agents: Learning & Skills
# ════════════════════════════════════════════════════════════════════════════════
CAT_SA_LEARN = "subagents_learning"

async def check_sa_skill_tools() -> dict:
    """Are the skill-discovery tools available to sub-agents?"""
    try:
        from src.agent_tools import TOOL_TAGS
        needed = {"manage_skills", "trigger_research", "ask_teacher", "pipeline"}
        present = needed & TOOL_TAGS
        missing = needed - TOOL_TAGS
        if not missing:
            return _ok("sa_skill_tools", CAT_SA_LEARN, "Sub-Agent Learning Tools",
                       f"All learning tools available: {', '.join(sorted(present))}")
        return _warn("sa_skill_tools", CAT_SA_LEARN, "Sub-Agent Learning Tools",
                     f"Missing tools: {', '.join(sorted(missing))}; present: {', '.join(sorted(present))}")
    except Exception as exc:
        return _unk("sa_skill_tools", CAT_SA_LEARN, "Sub-Agent Learning Tools", str(exc))

async def check_sa_skill_discovery() -> dict:
    """Has the agent saved any discovered skills (evidence of sub-agent learning)?"""
    data = await _json_get(f"{ODYSSEUS}/api/skills")
    if data is None:
        return _unk("sa_skill_disc", CAT_SA_LEARN, "Sub-Agent Skill Discovery",
                    "Skills endpoint unavailable")
    skills = data if isinstance(data, list) else data.get("skills", [])
    discovered = [s for s in skills
                  if isinstance(s, dict)
                  and (s.get("source") in ("discovered", "sub-agent", "research")
                       or not s.get("source"))]
    if len(skills) > 0:
        return _ok("sa_skill_disc", CAT_SA_LEARN, "Sub-Agent Skill Discovery",
                   f"{len(skills)} skill(s) in library — sub-agents can search and apply these")
    return _warn("sa_skill_disc", CAT_SA_LEARN, "Sub-Agent Skill Discovery",
                 "No skills discovered yet — have a sub-agent research and save domain-specific skills")

async def check_sa_research_tools() -> dict:
    """Research + ask_teacher enable sub-agents to verify and improve their results."""
    try:
        from src.agent_tools import TOOL_TAGS
        has_research  = "trigger_research" in TOOL_TAGS or "manage_research" in TOOL_TAGS
        has_teacher   = "ask_teacher"      in TOOL_TAGS
        has_subagents = "spawn_subagents"  in TOOL_TAGS
        all_three = has_research and has_teacher and has_subagents
        if all_three:
            return _ok("sa_research", CAT_SA_LEARN, "Sub-Agent Verification Chain",
                       "Research + Teacher + Sub-agents all available — "
                       "agent can spawn researchers, verify accuracy, and improve results")
        missing = []
        if not has_research:  missing.append("trigger_research")
        if not has_teacher:   missing.append("ask_teacher")
        if not has_subagents: missing.append("spawn_subagents")
        return _warn("sa_research", CAT_SA_LEARN, "Sub-Agent Verification Chain",
                     f"Missing: {', '.join(missing)} — verification chain incomplete")
    except Exception as exc:
        return _unk("sa_research", CAT_SA_LEARN, "Sub-Agent Verification Chain", str(exc))


# ════════════════════════════════════════════════════════════════════════════════
# CATEGORY 0 — System Hardware (shown first — tells the agent WHAT machine it's on)
# ════════════════════════════════════════════════════════════════════════════════
CAT_SYSINFO = "system_about"

async def check_cpu_info() -> dict:
    """CPU model name and logical core count."""
    model = "unknown"
    cores = 0
    try:
        with open("/proc/cpuinfo") as f:
            content = f.read()
        for line in content.splitlines():
            if line.startswith("model name") and ":" in line:
                model = line.split(":", 1)[1].strip()
                break
        cores = content.count("processor\t:")
        if cores == 0:
            cores = content.count("processor :")
    except Exception:
        pass
    if model == "unknown":
        _, out, _ = await _cmd(["uname", "-m"])
        model = out or "unknown"
    note = ""
    if 0 < cores < 4:
        note = " — low core count; parallel agent tasks will queue"
    elif cores >= 16:
        note = " — high-core machine; sub-agent parallelism benefits fully"
    detail = f"{model} — {cores} logical core(s){note}"
    return _ok("cpu_info", CAT_SYSINFO, "CPU", detail,
               {"model": model, "cores": cores})

async def check_ram_info() -> dict:
    """Total and available RAM."""
    total_kb = avail_kb = 0
    try:
        with open("/proc/meminfo") as f:
            for line in f:
                if line.startswith("MemTotal:"):
                    total_kb = int(line.split()[1])
                elif line.startswith("MemAvailable:"):
                    avail_kb = int(line.split()[1])
    except Exception:
        pass
    total_gb = total_kb / 1048576
    avail_gb = avail_kb / 1048576
    used_gb  = total_gb - avail_gb
    pct_used = (used_gb / total_gb * 100) if total_gb > 0 else 0
    detail = f"{total_gb:.1f} GB total — {avail_gb:.1f} GB free ({pct_used:.0f}% used)"
    if total_gb < 8:
        return _warn("ram_info", CAT_SYSINFO, "RAM",
                     detail + " — under 8 GB; agent + VM may compete for memory",
                     {"total_gb": round(total_gb, 1), "available_gb": round(avail_gb, 1)})
    if pct_used > 85:
        return _warn("ram_info", CAT_SYSINFO, "RAM",
                     detail + " — memory pressure is high",
                     {"total_gb": round(total_gb, 1), "available_gb": round(avail_gb, 1)})
    return _ok("ram_info", CAT_SYSINFO, "RAM", detail,
               {"total_gb": round(total_gb, 1), "available_gb": round(avail_gb, 1)})

async def check_gpu_info() -> dict:
    """GPU / display adapter — important for VM console rendering speed."""
    rc, out, _ = await _cmd(["lspci"], timeout=6)
    if rc == 0 and out:
        gpu_lines = [
            l for l in out.splitlines()
            if any(k in l.lower() for k in
                   ("vga", "3d controller", "display", "nvidia", "radeon",
                    "amd/ati", "intel graphics", "gpu"))
        ]
        if gpu_lines:
            gpus = [l.split(":", 2)[-1].strip() for l in gpu_lines[:3]]
            return _ok("gpu_info", CAT_SYSINFO, "GPU / Display Adapter",
                       "; ".join(gpus), gpus)
    # Fallback checks
    if os.path.isdir("/proc/driver/nvidia"):
        return _ok("gpu_info", CAT_SYSINFO, "GPU / Display Adapter",
                   "NVIDIA driver loaded (/proc/driver/nvidia present)", "nvidia")
    if os.path.isdir("/dev/dri"):
        devices = os.listdir("/dev/dri")
        return _ok("gpu_info", CAT_SYSINFO, "GPU / Display Adapter",
                   f"DRI devices present: {', '.join(devices)}", devices)
    return _warn("gpu_info", CAT_SYSINFO, "GPU / Display Adapter",
                 "No GPU detected (lspci unavailable or no display adapter found) — "
                 "VM console will use software rendering")

async def check_host_identity() -> dict:
    """Hostname, kernel, and architecture."""
    _, hostname, _ = await _cmd(["hostname"])
    _, kernel, _   = await _cmd(["uname", "-r"])
    _, arch, _     = await _cmd(["uname", "-m"])
    parts = []
    if hostname: parts.append(f"host={hostname}")
    if arch:     parts.append(f"arch={arch}")
    if kernel:   parts.append(f"kernel={kernel}")
    detail = "  ·  ".join(parts) if parts else "unavailable"
    return _ok("host_identity", CAT_SYSINFO, "Machine Identity", detail,
               {"hostname": hostname, "kernel": kernel, "arch": arch})

async def check_system_load() -> dict:
    """CPU load average and system uptime."""
    uptime_secs = 0.0
    load1 = load5 = load15 = "?"
    cores = 1
    try:
        with open("/proc/uptime") as f:
            uptime_secs = float(f.read().split()[0])
    except Exception:
        pass
    try:
        with open("/proc/loadavg") as f:
            parts = f.read().split()
        load1, load5, load15 = parts[0], parts[1], parts[2]
    except Exception:
        pass
    try:
        with open("/proc/cpuinfo") as f:
            cnt = f.read().count("processor\t:")
        cores = max(cnt, 1)
    except Exception:
        pass

    if uptime_secs < 3600:
        uptime_str = f"{uptime_secs/60:.0f}m"
    elif uptime_secs < 86400:
        uptime_str = f"{uptime_secs/3600:.1f}h"
    else:
        uptime_str = f"{uptime_secs/86400:.1f}d"

    detail = f"Up {uptime_str}  ·  load: {load1} / {load5} / {load15} (1/5/15 min avg, {cores} cores)"
    try:
        l1 = float(load1)
        if l1 > cores * 0.9:
            return _warn("system_load", CAT_SYSINFO, "System Load",
                         detail + " — CPU saturated; agent responses will be slow",
                         {"uptime_s": uptime_secs, "load1": load1, "cores": cores})
        if l1 > cores * 0.6:
            return _warn("system_load", CAT_SYSINFO, "System Load",
                         detail + " — load is elevated",
                         {"uptime_s": uptime_secs, "load1": load1, "cores": cores})
    except (ValueError, TypeError):
        pass
    return _ok("system_load", CAT_SYSINFO, "System Load", detail,
               {"uptime_s": uptime_secs, "load1": load1, "cores": cores})


# ════════════════════════════════════════════════════════════════════════════════
# CATEGORY 14 — AI Performance (GPU inference, Ollama tuning, swap)
# ════════════════════════════════════════════════════════════════════════════════
CAT_PERF = "ai_performance"

async def check_nvidia_inference() -> dict:
    """Is Ollama using the NVIDIA GPU for inference, or falling back to CPU?"""
    hw_env = "/etc/foulfox/ollama-hw.env"
    gpu_val = None
    if os.path.isfile(hw_env):
        try:
            with open(hw_env) as f:
                for line in f:
                    if "OLLAMA_NUM_GPU" in line and "=" in line:
                        gpu_val = line.split("=", 1)[1].strip().strip('"')
        except Exception:
            pass
    # Check if nvidia-smi shows a GPU
    rc_smi, smi_out, smi_err = await _cmd(
        ["bash", "-c", "nvidia-smi --query-gpu=name,memory.total,memory.free --format=csv,noheader 2>&1 | head -3"])
    gpu_name = smi_out.strip() if rc_smi == 0 and smi_out.strip() else None
    # Check if Ollama process has GPU visible
    _, ollama_ps, _ = await _cmd(
        ["bash", "-c", "ps aux | grep -E 'ollama|llama' | grep -v grep | head -5"])
    if gpu_val == "-1" or (gpu_val and gpu_val != "0"):
        verdict = "GPU mode active" if gpu_name else f"GPU requested (OLLAMA_NUM_GPU={gpu_val}) but nvidia-smi not available"
        return _ok("nvidia_inf", CAT_PERF, "Ollama GPU Inference",
                   verdict,
                   {"OLLAMA_NUM_GPU": gpu_val, "nvidia_smi": gpu_name or smi_err[:200],
                    "hw_env": hw_env})
    if gpu_val == "0":
        return _warn("nvidia_inf", CAT_PERF, "Ollama GPU Inference",
                     f"CPU-only mode (OLLAMA_NUM_GPU=0) — inference will be slow",
                     {"OLLAMA_NUM_GPU": "0", "nvidia_smi": gpu_name or "not detected",
                      "hw_env_exists": os.path.isfile(hw_env)})
    if gpu_val is None:
        msg = (f"ollama-hw.env not found at {hw_env} — first-run GPU detection hasn't run yet"
               if not os.path.isfile(hw_env)
               else f"OLLAMA_NUM_GPU not set in {hw_env}")
        return _warn("nvidia_inf", CAT_PERF, "Ollama GPU Inference",
                     msg,
                     {"hw_env_exists": os.path.isfile(hw_env),
                      "nvidia_smi": gpu_name or smi_err[:200] or "unavailable"})
    return _unk("nvidia_inf", CAT_PERF, "Ollama GPU Inference",
                f"Cannot determine GPU mode (OLLAMA_NUM_GPU={gpu_val!r})",
                {"OLLAMA_NUM_GPU": gpu_val, "nvidia_smi": gpu_name})

async def check_ollama_config() -> dict:
    """Read Ollama tuning variables from foulfox.env, ollama-hw.env, AND os.environ.
    The running environment has vars loaded from foulfox.env at boot, so even if the
    file predates the tuning additions, the live env vars reveal the effective config."""
    env_path = "/etc/foulfox/foulfox.env"
    hw_env   = "/etc/foulfox/ollama-hw.env"
    config = {}
    # 1. Read from env files (static config)
    for path in [env_path, hw_env]:
        if os.path.isfile(path):
            try:
                with open(path) as f:
                    for line in f:
                        line = line.strip()
                        if line.startswith("OLLAMA_") and "=" in line:
                            k, v = line.split("=", 1)
                            config[k] = v.strip().strip('"')
            except Exception:
                pass
    # 2. Overlay with live environment (higher priority — what Ollama actually sees)
    for k, v in os.environ.items():
        if k.startswith("OLLAMA_"):
            config[k] = v
    # 3. Probe the Ollama API for its running config
    ollama_config = await _json_get("http://127.0.0.1:11434/api/version", timeout=3)
    if not config:
        return _warn("ollama_cfg", CAT_PERF, "Ollama Tuning Config",
                     "No OLLAMA_* vars found in config files or environment "
                     "(pre-build-142 OS — update to latest ISO to get GPU/memory tuning)",
                     {"env_file_exists": os.path.isfile(env_path),
                      "hw_env_exists": os.path.isfile(hw_env),
                      "ollama_version": ollama_config or "not reachable"})
    ctx = config.get("OLLAMA_CONTEXT_LENGTH", "default")
    fa  = config.get("OLLAMA_FLASH_ATTENTION", "?")
    kv  = config.get("OLLAMA_KV_CACHE_TYPE", "?")
    gpu = config.get("OLLAMA_NUM_GPU", "auto")
    return _ok("ollama_cfg", CAT_PERF, "Ollama Tuning Config",
               f"ctx={ctx}  flash_attn={fa}  kv_cache={kv}  num_gpu={gpu}",
               config)

async def check_swap() -> dict:
    """Check swap space — critical for running a 7B model + Windows VM on 8 GB RAM."""
    _, swap_out, _ = await _cmd(["bash", "-c", "swapon --show=NAME,SIZE,TYPE,USED --noheadings 2>/dev/null"])
    _, free_out, _ = await _cmd(["bash", "-c", "free -h | grep -i swap"])
    if swap_out.strip():
        lines = swap_out.strip().splitlines()
        return _ok("swap", CAT_PERF, "Swap Space",
                   f"{len(lines)} swap device(s): {swap_out.strip()[:120]}",
                   {"swapon": swap_out.strip(), "free_swap": free_out.strip()})
    # Check for a foulfox swap file specifically
    _, swapfile, _ = await _cmd(["bash", "-c", "ls -lh /swapfile /var/lib/foulfox/swapfile 2>/dev/null"])
    return _warn("swap", CAT_PERF, "Swap Space",
                 "No swap active — risk of OOM with VM + Ollama under load on ≤8GB RAM",
                 {"swapon_output": swap_out or "empty", "swapfile_check": swapfile or "none found",
                  "free": free_out or "unavailable"})

async def check_ollama_running_model() -> dict:
    """What model does Ollama have currently loaded in VRAM/RAM?"""
    data = await _json_get("http://127.0.0.1:11434/api/ps", timeout=4)
    if data is None:
        return _unk("ollama_loaded", CAT_PERF, "Ollama Loaded Model",
                    "Ollama not responding — cannot check loaded model")
    models = data.get("models", [])
    if not models:
        return _warn("ollama_loaded", CAT_PERF, "Ollama Loaded Model",
                     "No model currently loaded — first inference will take ~5s to load",
                     {"models": []})
    m = models[0]
    name = m.get("name", "?")
    size_vram = m.get("size_vram", 0)
    size      = m.get("size", 0)
    vram_mb = size_vram // 1048576
    size_mb = size // 1048576
    return _ok("ollama_loaded", CAT_PERF, "Ollama Loaded Model",
               f"'{name}' loaded — {size_mb}MB total, {vram_mb}MB in VRAM",
               {"model": name, "size_mb": size_mb, "vram_mb": vram_mb})


# ════════════════════════════════════════════════════════════════════════════════
# CATEGORY 15 — Browser Automation (CDP)
# ════════════════════════════════════════════════════════════════════════════════
CAT_BROWSER = "browser_automation"

async def check_firefox_cdp() -> dict:
    """Firefox remote debugger on :9223.

    Firefox ESR uses FRDP (Firefox Remote Debug Protocol) — a WebSocket-only
    protocol. Unlike Chrome/Chromium, it does NOT expose HTTP REST endpoints
    (/json/version, /json/list). Trying those always times out even when Firefox
    is healthy and accepting debugger connections.

    Strategy: check whether the port is listening + confirm the process has
    --remote-debugging-port=9223 in its cmdline. That is sufficient evidence
    the debugger is ready.
    """
    _, ss_out, _ = await _cmd(
        ["bash", "-c", "ss -tlnp 2>/dev/null | grep ':9223'"])
    port_listening = bool(ss_out.strip())
    _, ps_out, _ = await _cmd(
        ["bash", "-c",
         "ps aux | grep -E 'firefox' | grep 'remote-debugging-port' | grep -v grep | head -3"])
    process_found = bool(ps_out.strip())

    if port_listening and process_found:
        # Extract pid from ss output for extra confidence
        pid_hint = ""
        if "pid=" in ss_out:
            pid_hint = ss_out.split("pid=")[-1].split(",")[0].split(")")[0]
        return _ok("firefox_cdp", CAT_BROWSER, "Firefox Browser CDP",
                   "Firefox remote debugger ready on :9223 (FRDP/WebSocket protocol — "
                   "HTTP /json endpoints not applicable to Firefox ESR)",
                   {"port_listening": True, "process_running": True,
                    "pid": pid_hint or "see ps",
                    "note": "Connect via WebSocket ws://127.0.0.1:9223"})

    if port_listening and not process_found:
        return _warn("firefox_cdp", CAT_BROWSER, "Firefox Browser CDP",
                     "Port :9223 is listening but no firefox process with --remote-debugging-port found",
                     {"port_listening": True, "process_found": False,
                      "ss_out": ss_out.strip()[:300]})

    # Port not listening — check if Firefox is even running
    _, all_fx, _ = await _cmd(
        ["bash", "-c", "ps aux | grep -E 'firefox' | grep -v grep | head -3"])
    if all_fx.strip():
        return _warn("firefox_cdp", CAT_BROWSER, "Firefox Browser CDP",
                     "Firefox is running but NOT with --remote-debugging-port=9223 "
                     "— kiosk startup script may need updating",
                     {"port_listening": False, "firefox_running": True,
                      "processes": all_fx.strip()[:400]})
    return _warn("firefox_cdp", CAT_BROWSER, "Firefox Browser CDP",
                 "Firefox not running — remote debugger unavailable",
                 {"port_listening": False, "firefox_running": False})

async def check_app_runtime_ports() -> dict:
    """Check if any FoulFox apps are running on their dedicated port range (27000–27199)."""
    _, ss_out, _ = await _cmd(
        ["bash", "-c",
         "ss -tlnp 2>/dev/null | awk '$4 ~ /:270/ {print}' | head -10"])
    if ss_out.strip():
        lines = ss_out.strip().splitlines()
        return _ok("app_ports", CAT_BROWSER, "App Runtime Ports (27000–27199)",
                   f"{len(lines)} app port(s) listening: {', '.join(l.split()[3] for l in lines[:4] if len(l.split()) > 3)}",
                   {"listening": ss_out.strip()})
    data = await _json_get(f"{API}/api/apps", timeout=4)
    running = []
    if data:
        apps = data if isinstance(data, list) else data.get("apps", [])
        running = [a for a in apps if a.get("status") == "running"]
    if not running:
        return _warn("app_ports", CAT_BROWSER, "App Runtime Ports (27000–27199)",
                     "No apps currently running — open the Apps tab to launch one",
                     {"ss_output": ss_out or "none", "app_count": len(apps) if data else "unknown"})
    return _ok("app_ports", CAT_BROWSER, "App Runtime Ports (27000–27199)",
               f"{len(running)} app(s) running",
               {"running": [a.get("id") for a in running]})

async def check_guest_cdp() -> dict:
    """Guest Chrome CDP on :9224 — bridged from Windows VM via netsh portproxy."""
    data = await _json_get("http://127.0.0.1:9224/json/version", timeout=3)
    if data is not None:
        browser = data.get("Browser", "?")
        return _ok("guest_cdp", CAT_BROWSER, "Windows VM Guest CDP",
                   f"Guest CDP available on :9224 — {browser}",
                   {"browser": browser})
    return _warn("guest_cdp", CAT_BROWSER, "Windows VM Guest CDP",
                 "Guest CDP not available on :9224 — Chrome must be running inside the Windows VM "
                 "with --remote-debugging-port=9222 and netsh portproxy forwarding host:9224→guest:9222",
                 {"port_9224": "closed"})


# ════════════════════════════════════════════════════════════════════════════════
# CATEGORY 16 — OS Services & Boot Health
# ════════════════════════════════════════════════════════════════════════════════
CAT_SERVICES = "os_services"

async def check_foulfox_services() -> dict:
    """Systemd status for the core FoulFox service chain."""
    services = ["foulfox-api", "odysseus-service", "ollama",
                "foulfox-vm-autostart", "foulfox-seed-ollama"]
    results = {}
    failed = []
    inactive = []
    for svc in services:
        rc, out, _ = await _cmd(
            ["bash", "-c",
             f"systemctl is-active {svc} 2>/dev/null || systemctl is-active {svc}.service 2>/dev/null || echo unknown"])
        state = out.strip() or "unknown"
        results[svc] = state
        if state == "failed":
            failed.append(svc)
        elif state in ("inactive", "unknown"):
            inactive.append(svc)
    if failed:
        _, journal, _ = await _cmd(
            ["bash", "-c",
             f"journalctl -u {failed[0]} -n 15 --no-pager 2>&1 | tail -15"])
        return _fail("ff_services", CAT_SERVICES, "FoulFox Service Chain",
                     f"Failed service(s): {', '.join(failed)}",
                     {"services": results, "journal_tail": journal[:600]})
    if inactive:
        return _warn("ff_services", CAT_SERVICES, "FoulFox Service Chain",
                     f"Inactive service(s): {', '.join(inactive)} (expected in dev/non-FoulFox-OS environment)",
                     {"services": results})
    return _ok("ff_services", CAT_SERVICES, "FoulFox Service Chain",
               f"All {len(services)} services active", {"services": results})

async def check_first_run_complete() -> dict:
    """Was foulfox-first-run completed? Check for sentinel files."""
    markers = [
        "/var/lib/foulfox/.first-run-complete",
        "/etc/foulfox/.first-run-complete",
        os.path.join(DATA_DIR, ".first-run-complete"),
    ]
    for marker in markers:
        if os.path.isfile(marker):
            try:
                ts = time.strftime(
                    "%Y-%m-%d", time.localtime(os.path.getmtime(marker)))
            except Exception:
                ts = "unknown"
            return _ok("first_run", CAT_SERVICES, "First-Run Provisioning",
                       f"First-run complete (marker: {marker}, date: {ts})",
                       {"marker": marker, "date": ts})
    # Check if data dirs exist (indicates first-run has run even without marker)
    data_subdirs = []
    if os.path.isdir(DATA_DIR):
        data_subdirs = os.listdir(DATA_DIR)
    if data_subdirs:
        return _warn("first_run", CAT_SERVICES, "First-Run Provisioning",
                     "No first-run sentinel found but data dir has content — "
                     "first-run may have run without writing a marker",
                     {"data_dir": DATA_DIR,
                      "data_contents": data_subdirs[:10]})
    return _warn("first_run", CAT_SERVICES, "First-Run Provisioning",
                 "First-run sentinel not found — provisioning may not have completed "
                 "(expected on fresh install or live USB)",
                 {"checked": markers, "data_dir": DATA_DIR,
                  "data_dir_exists": os.path.isdir(DATA_DIR)})

async def check_kiosk_session() -> dict:
    """Is the FoulFox kiosk session (openbox + Chromium) running?"""
    _, ps_ob, _ = await _cmd(
        ["bash", "-c", "ps aux | grep -E 'openbox|tint2' | grep -v grep | head -3"])
    _, ps_cr, _ = await _cmd(
        ["bash", "-c", "ps aux | grep -E 'chromium|chrome' | grep 'app=' | grep -v grep | head -3"])
    _, ps_ff, _ = await _cmd(
        ["bash", "-c", "ps aux | grep firefox | grep -v grep | head -2"])
    ob_running = bool(ps_ob.strip())
    cr_running = bool(ps_cr.strip())
    ff_running = bool(ps_ff.strip())
    if ob_running and cr_running:
        return _ok("kiosk", CAT_SERVICES, "Kiosk Session",
                   "Openbox + Chromium kiosk running" + (" + Firefox" if ff_running else ""),
                   {"openbox": ob_running, "chromium": cr_running, "firefox": ff_running})
    missing = []
    if not ob_running: missing.append("openbox")
    if not cr_running: missing.append("chromium-kiosk")
    return _warn("kiosk", CAT_SERVICES, "Kiosk Session",
                 f"Not in kiosk session — {', '.join(missing)} not running "
                 "(expected in dev/non-GUI environment)",
                 {"openbox_procs": ps_ob[:200] or "none",
                  "chromium_procs": ps_cr[:200] or "none",
                  "firefox_procs": ps_ff[:200] or "none"})

async def check_foulfox_patcher() -> dict:
    """Live updater (foulfox-patcher) status — is the OTA stack healthy?

    The patcher runs as a one-shot systemd service + timer (no long-running HTTP
    server), so there is no REST endpoint to query. Check via systemctl instead.
    """
    # Primary: check the patcher timer/service via systemctl
    rc_timer, timer_out, _ = await _cmd(
        ["bash", "-c", "systemctl is-active foulfox-patcher.timer 2>&1; "
                       "systemctl status foulfox-patcher.timer 2>&1 | "
                       "grep -E 'Trigger:|Last trigger:|Active:|Result:' | head -5"])
    rc_svc, svc_out, _ = await _cmd(
        ["bash", "-c",
         "systemctl show foulfox-patcher.service "
         "--property=ActiveState,Result,ExecMainStatus 2>&1 | head -5"])
    # Check if the patcher script itself exists
    patcher_exists = os.path.isfile("/usr/local/sbin/foulfox-patcher.sh")
    staging_dir    = os.path.join(DATA_DIR, "update-staging")
    staging_exists = os.path.isdir(staging_dir)
    pending = False
    if staging_exists:
        try:
            pending = bool(os.listdir(staging_dir))
        except Exception:
            pass
    if not patcher_exists:
        return _warn("patcher", CAT_SERVICES, "Live Updater (OTA Patcher)",
                     "Patcher script not found at /usr/local/sbin/foulfox-patcher.sh — "
                     "OTA system not installed (pre-build-138 OS)",
                     {"patcher_script": False, "staging_dir": staging_exists})
    timer_active = "active" in timer_out.lower() or "running" in timer_out.lower()
    if timer_active:
        msg = "OTA patcher timer active"
        if pending:
            return _warn("patcher", CAT_SERVICES, "Live Updater (OTA Patcher)",
                         msg + " — staged update ready (will apply on next boot)",
                         {"timer": timer_out[:300], "pending_in_staging": True})
        return _ok("patcher", CAT_SERVICES, "Live Updater (OTA Patcher)",
                   msg + " — no pending updates",
                   {"timer": timer_out[:300], "staging_dir_empty": not pending,
                    "service_state": svc_out[:200]})
    # Timer not active — patcher installed but not scheduled (normal on disk installs
    # if the timer was not enabled; the patcher still runs at boot via the service unit)
    last_result = "success" if "Result=success" in svc_out or "ExecMainStatus=0" in svc_out else "?"
    return _ok("patcher", CAT_SERVICES, "Live Updater (OTA Patcher)",
               "OTA patcher installed — timer not active (runs at boot via service unit); "
               f"last run: {last_result}",
               {"patcher_script": True, "timer_active": False,
                "service_last_result": svc_out[:200] or "unavailable",
                "pending_updates": pending})


# ════════════════════════════════════════════════════════════════════════════════
# Category registry (ordered — drives both report sections and UI)
# ════════════════════════════════════════════════════════════════════════════════

CATEGORIES: list[dict] = [
    {"id": CAT_SYSINFO,    "label": "System Hardware",               "icon": "⚙️"},
    {"id": CAT_OS,         "label": "FoulFox OS",                    "icon": "🖥️"},
    {"id": CAT_SERVICES,   "label": "OS Services & Boot Health",     "icon": "🔧"},
    {"id": CAT_PERF,       "label": "AI Performance (GPU / Ollama)", "icon": "🚀"},
    {"id": CAT_VOICE,      "label": "Voice Forge",                   "icon": "🎤"},
    {"id": CAT_LLAMA,      "label": "Llama Llama Studio",            "icon": "🦙"},
    {"id": CAT_WIN,        "label": "Windows 11 VM",                 "icon": "🪟"},
    {"id": CAT_AGENT_VM,   "label": "Agent → Windows VM",           "icon": "🔌"},
    {"id": CAT_AGENT_HOST, "label": "Agent → FoulFox OS",           "icon": "🤖"},
    {"id": CAT_BACKUP,     "label": "Windows VM Backups",            "icon": "💾"},
    {"id": CAT_BROWSER,    "label": "Browser Automation (CDP)",      "icon": "🌐"},
    {"id": CAT_VOICE_AGENT,"label": "Voice + Agent Integration",     "icon": "🗣️"},
    {"id": CAT_MEMORY,     "label": "Agent Memory & Lessons",        "icon": "🧠"},
    {"id": CAT_LEARN,      "label": "Agent Learning & Improvement",  "icon": "📈"},
    {"id": CAT_AWARE,      "label": "Agent System Awareness",        "icon": "👁️"},
    {"id": CAT_SA_SPEED,   "label": "Sub-Agents (Task Speed)",       "icon": "⚡"},
    {"id": CAT_SA_LEARN,   "label": "Sub-Agents (Learning & Skills)","icon": "🎓"},
]

# All check functions, grouped by category
ALL_CHECKS: list = [
    # System Hardware (always first — tells us what machine we're on)
    check_cpu_info, check_ram_info, check_gpu_info,
    check_host_identity, check_system_load,
    # FoulFox OS
    check_os_version, check_boot_type, check_kvm,
    check_data_partition, check_root_disk,
    check_api_server, check_odysseus_service,
    check_live_updater, check_network,
    # OS Services & Boot Health
    check_foulfox_services, check_first_run_complete, check_kiosk_session, check_foulfox_patcher,
    # AI Performance (GPU / Ollama)
    check_nvidia_inference, check_ollama_config, check_swap, check_ollama_running_model,
    # Voice Forge
    check_stt, check_tts, check_audio_hw,
    # Llama Llama Studio
    check_ollama, check_llama_model, check_llama_studio_app,
    # Windows 11 VM
    check_windows_vm_exists, check_windows_vm_running, check_windows_vm_display,
    # Agent → Windows VM
    check_agent_vm_key, check_agent_vm_shell, check_agent_vm_workspace_mode,
    # Agent → FoulFox OS
    check_agent_bash, check_agent_file_io, check_agent_web_fetch,
    # VM Backups
    check_backup_dir, check_backup_age,
    # Browser Automation (CDP)
    check_chromium_cdp, check_firefox_cdp, check_app_runtime_ports, check_guest_cdp,
    # Voice + Agent Integration
    check_voice_agent_loop, check_voice_model,
    # Agent Memory & Lessons
    check_agent_lessons, check_agent_notes, check_agent_memory_db, check_semantic_search,
    # Agent Learning & Improvement
    check_skills, check_skill_audit, check_self_repair_enabled,
    # Agent System Awareness
    check_mtm, check_research_library, check_model_configured,
    # Sub-Agents (Speed)
    check_subagent_tool, check_subagent_usage,
    # Sub-Agents (Learning & Skills)
    check_sa_skill_tools, check_sa_skill_discovery, check_sa_research_tools,
]


async def run_all_checks() -> list[dict]:
    """Run all checks concurrently and return results."""
    results = await asyncio.gather(*[c() for c in ALL_CHECKS], return_exceptions=True)
    out = []
    for i, r in enumerate(results):
        if isinstance(r, Exception):
            fn = ALL_CHECKS[i]
            out.append(_fail(fn.__name__, "unknown", fn.__name__, str(r)))
        else:
            out.append(r)
    return out


_SYSTEM_VISION = """
FoulFox OS is a fully operational AI-native computing environment built around a single goal: a
JARVIS-grade intelligent workspace where you and your AI Agent collaborate as equals.

What the completed system delivers:

UNIFIED WORKSPACE — FoulFox OS runs natively on bare metal or USB. Inside it, a Windows 11 VM
lives as an embedded iframe — fully visible, fully controllable. You switch between the host OS and
the Windows VM without leaving the interface. Both desktops are your workspace simultaneously.

AGENT WITH FULL REACH — The AI Agent operates freely across both environments. Inside FoulFox OS
it reads files, writes scripts, edits configs, and restarts services. Inside the Windows VM it
opens applications, writes and runs code, browses the web, and builds software — exactly as a
human developer would, but without needing sleep.

VIBE CODING AT FULL SPEED — The Agent scaffolds projects, writes every file, fixes every bug, runs
every test, and ships the result — all while narrating what it is doing in plain English. It works
across the OS boundary: a Python script on FoulFox calls a Windows tool in the VM, the Agent wires
them together without being asked.

VOICE-FIRST COMMUNICATION — Voice Forge provides a real-time, low-latency TTS/STT loop. You speak
naturally, the Agent hears and understands, then responds in a clear synthetic voice you have
chosen and customised. The conversation continues unbroken whether you are watching a build log or
stepping away from the keyboard.

YOUR AGENT'S VOICE — Voice Forge lets you tune every aspect of the Agent's speech: voice model,
speed, pitch, and personality tone. The Agent sounds like your assistant — not a generic chatbot.
The voice carries context: calm when reporting status, energised when something works, direct when
flagging a problem.

MEMORY THAT COMPOUNDS — Every lesson the Agent learns about your project, preferences, and
patterns is stored and retrieved semantically. The longer the system runs, the more effective the
Agent becomes — past solutions inform future decisions automatically.

SUB-AGENT PARALLELISM — Complex tasks spawn parallel sub-agents. One researches, one codes, one
tests. Results merge back into the main Agent's context. Work that would take hours serially
finishes in minutes.

The system you are building is not a tool. It is a collaborator — always on, always aware, always
improving. Like JARVIS: it knows the workshop, knows the mission, and gets things done.
""".strip()


def _render_system_hardware_block(checks: list[dict]) -> list[str]:
    """Render a compact inline hardware summary for the top of the report."""
    hw = {c["id"]: c for c in checks if c.get("category") == CAT_SYSINFO}
    if not hw:
        return []

    def _val(cid: str, fallback: str = "unknown") -> str:
        c = hw.get(cid)
        if c is None:
            return fallback
        v = c.get("value")
        if isinstance(v, dict):
            # Extract the most useful single field
            if cid == "cpu_info":
                m = v.get("model", "?")
                n = v.get("cores", "?")
                return f"{m} ({n} cores)"
            if cid == "ram_info":
                return f"{v.get('total_gb', '?')} GB total, {v.get('available_gb', '?')} GB free"
            if cid == "host_identity":
                return f"{v.get('hostname', '?')} — {v.get('arch', '?')} — kernel {v.get('kernel', '?')}"
            if cid == "system_load":
                return f"load {v.get('load1', '?')} ({v.get('cores', '?')} cores), up {v.get('uptime_s', 0)/3600:.1f}h"
        if isinstance(v, list):
            return "; ".join(str(x) for x in v[:2])
        return c.get("detail", fallback)

    lines: list[str] = [
        "## ⚙️ This Machine",
        "",
        f"| | |",
        f"|---|---|",
        f"| **CPU** | {_val('cpu_info')} |",
        f"| **RAM** | {_val('ram_info')} |",
        f"| **GPU** | {_val('gpu_info')} |",
        f"| **Identity** | {_val('host_identity')} |",
        f"| **Load** | {_val('system_load')} |",
        "",
    ]
    return lines


def _render_value(val: Any, max_len: int = 800) -> str:
    """Format a check's raw value field for markdown output."""
    if val is None:
        return ""
    if isinstance(val, bool):
        return str(val).lower()
    if isinstance(val, (int, float)):
        return str(val)
    if isinstance(val, str):
        val = val.strip()
        if not val:
            return ""
        if len(val) > max_len:
            val = val[:max_len] + f"\n… ({len(val) - max_len} chars truncated)"
        return val
    if isinstance(val, (dict, list)):
        try:
            s = json.dumps(val, indent=2, default=str)
        except Exception:
            s = str(val)
        if len(s) > max_len:
            s = s[:max_len] + f"\n… ({len(s) - max_len} chars truncated)"
        return s
    return str(val)


def results_to_markdown(checks: list[dict], iteration: int = 1) -> str:
    icons  = {"ok": "✅", "warn": "⚠️", "fail": "❌", "unknown": "❓"}
    now    = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    fail_n = sum(1 for c in checks if c["status"] == "fail")
    warn_n = sum(1 for c in checks if c["status"] == "warn")
    ok_n   = sum(1 for c in checks if c["status"] == "ok")
    all_ok = fail_n == 0 and warn_n == 0

    lines = [
        f"# FoulFox OS — Capability Report (#{iteration})",
        f"**Generated:** {now}",
        f"**Summary:** {ok_n} ✅  ·  {warn_n} ⚠️  ·  {fail_n} ❌",
        "",
    ]

    # Hardware summary — always first so the reader/agent knows what machine this is
    lines += _render_system_hardware_block(checks)
    lines.append("")

    # ── FULLY OPERATIONAL BANNER ──────────────────────────────────────────
    if all_ok:
        lines += [
            "---",
            "## 🟢 SYSTEM FULLY OPERATIONAL — JARVIS ONLINE",
            "",
            _SYSTEM_VISION,
            "",
            "---",
            "",
        ]

    # ── QUICK OVERVIEW: one-liner per check, grouped by category ─────────
    # This section gives a fast pass/warn/fail overview before the full log.
    by_cat: dict[str, list] = {}
    for c in checks:
        by_cat.setdefault(c.get("category", "unknown"), []).append(c)

    for cat in CATEGORIES:
        cat_checks = by_cat.get(cat["id"], [])
        if not cat_checks:
            continue
        cat_fail = any(c["status"] == "fail" for c in cat_checks)
        cat_warn = any(c["status"] == "warn" for c in cat_checks)
        header_icon = "❌" if cat_fail else ("⚠️" if cat_warn else "✅")
        lines.append(f"## {header_icon} {cat['icon']} {cat['label']}")
        lines.append("")
        for c in cat_checks:
            icon = icons.get(c["status"], "❓")
            lines.append(f"- {icon} **{c['name']}**: {c['detail']}")
        lines.append("")

    # ── ACTION REQUIRED: fails only, with raw value for immediate debugging ──
    fails = [c for c in checks if c["status"] == "fail"]
    if fails:
        lines += ["---", "## ❌ Action Required (Failures)", ""]
        for c in fails:
            lines += [
                f"### ❌ {c['name']}",
                f"**Category:** {c.get('category', '?')}",
                f"**Detail:** {c['detail']}",
            ]
            val_str = _render_value(c.get("value"))
            if val_str:
                lines.append(f"**Measured value:**")
                lines.append(f"```")
                lines.append(val_str)
                lines.append(f"```")
            lines.append("")

    # ── FULL DIAGNOSTIC LOG: every check, every value ─────────────────────
    # This is the raw output of every probe so you can see exactly what was
    # measured — not just what failed. All 46 checks, all raw values.
    lines += ["---", "## 📋 Full Diagnostic Log", ""]
    lines.append("Every check that ran, with its raw measured value.")
    lines.append("")

    for cat in CATEGORIES:
        cat_checks = by_cat.get(cat["id"], [])
        if not cat_checks:
            continue
        cat_fail = any(c["status"] == "fail" for c in cat_checks)
        cat_warn = any(c["status"] == "warn" for c in cat_checks)
        header_icon = "❌" if cat_fail else ("⚠️" if cat_warn else "✅")
        lines.append(f"### {header_icon} {cat['icon']} {cat['label']}")
        lines.append("")
        for c in cat_checks:
            icon = icons.get(c["status"], "❓")
            status_upper = c["status"].upper()
            lines.append(f"**{icon} {c['name']}** `[{status_upper}]`")
            lines.append(f"- Detail: {c['detail']}")
            val_str = _render_value(c.get("value"))
            if val_str:
                # Inline values that are short (≤80 chars, no newlines)
                if len(val_str) <= 80 and "\n" not in val_str:
                    lines.append(f"- Value: `{val_str}`")
                else:
                    lines.append(f"- Value:")
                    lines.append(f"  ```")
                    for vline in val_str.splitlines():
                        lines.append(f"  {vline}")
                    lines.append(f"  ```")
            else:
                lines.append(f"- Value: *(none)*")
            lines.append("")
        lines.append("")

    # ── SYSTEM PURPOSE (shown when things still need fixing) ──────────────
    if not all_ok:
        lines += [
            "---",
            "## 🎯 What This System Will Be When Fully Online",
            "",
            _SYSTEM_VISION,
            "",
        ]

    lines += ["---", "*Sent automatically by FoulFox OS self-reporting system.*"]
    return "\n".join(lines)


def build_report(checks: list[dict], iteration: int = 1) -> dict:
    now_ts = time.time()
    fail_n = sum(1 for c in checks if c["status"] == "fail")
    warn_n = sum(1 for c in checks if c["status"] == "warn")
    ok_n   = sum(1 for c in checks if c["status"] == "ok")

    # Build per-category summary
    cat_summary: dict[str, dict] = {}
    for cat in CATEGORIES:
        cat_checks = [c for c in checks if c.get("category") == cat["id"]]
        if not cat_checks:
            continue
        c_fail = sum(1 for c in cat_checks if c["status"] == "fail")
        c_warn = sum(1 for c in cat_checks if c["status"] == "warn")
        c_ok   = sum(1 for c in cat_checks if c["status"] == "ok")
        cat_summary[cat["id"]] = {
            "label": cat["label"],
            "icon":  cat["icon"],
            "ok": c_ok, "warn": c_warn, "fail": c_fail,
            "status": "fail" if c_fail else ("warn" if c_warn else "ok"),
            "checks": cat_checks,
        }

    return {
        "iteration":    iteration,
        "timestamp":    now_ts,
        "generated_at": datetime.fromtimestamp(now_ts, tz=timezone.utc).isoformat(),
        "summary":      {"ok": ok_n, "warn": warn_n, "fail": fail_n,
                         "total": len(checks)},
        "all_passed":   fail_n == 0 and warn_n == 0,
        "checks":       checks,
        "categories":   cat_summary,
        "category_order": [c["id"] for c in CATEGORIES],
        "markdown":     results_to_markdown(checks, iteration),
    }

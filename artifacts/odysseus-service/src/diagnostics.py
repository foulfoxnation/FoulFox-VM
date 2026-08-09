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
def _unk(id, cat, name, detail="check could not run"):
    return _r(id, cat, name, "unknown", detail, None)

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

DATA_DIR = os.environ.get("ODYSSEUS_DATA_DIR", "/var/lib/foulfox")
ODYSSEUS  = "http://127.0.0.1:5001"
API       = "http://127.0.0.1:8080"

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
    data = await _json_get(f"{API}/api/health")
    if data is not None:
        return _ok("api_server", CAT_OS, "API Server", "Responding on :8080", data)
    return _fail("api_server", CAT_OS, "API Server",
                 "Not reachable on :8080 — shell UI cannot function")

async def check_odysseus_service() -> dict:
    data = await _json_get(f"{ODYSSEUS}/api/agent-suite/state")
    if data is not None:
        suite = data.get("suite", {})
        roles = [r for r, v in suite.items() if v.get("model")]
        return _ok("odysseus_svc", CAT_OS, "Odysseus AI Service",
                   f"Running on :5001; {len(roles)} agent role(s) configured" if roles
                   else "Running on :5001 (no model configured yet)")
    return _fail("odysseus_svc", CAT_OS, "Odysseus AI Service",
                 "Not reachable on :5001 — AI features unavailable")

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
                     "STT service not responding — voice input unavailable")
    provider = data.get("provider", "unknown")
    enabled  = data.get("enabled", False)
    if not enabled:
        return _warn("stt", CAT_VOICE, "Speech-to-Text Engine",
                     f"STT loaded ({provider}) but disabled — enable in Settings → Voice")
    return _ok("stt", CAT_VOICE, "Speech-to-Text Engine",
               f"Active — provider: {provider}", data)

async def check_tts() -> dict:
    data = await _json_get(f"{ODYSSEUS}/api/tts/stats")
    if data is None:
        return _fail("tts", CAT_VOICE, "Text-to-Speech Engine",
                     "TTS service not responding — voice output unavailable")
    provider = data.get("provider", "unknown")
    enabled  = data.get("enabled", False)
    if not enabled:
        return _warn("tts", CAT_VOICE, "Text-to-Speech Engine",
                     f"TTS loaded ({provider}) but disabled — enable in Settings → Voice")
    return _ok("tts", CAT_VOICE, "Text-to-Speech Engine",
               f"Active — provider: {provider}", data)

async def check_audio_hw() -> dict:
    rc, out, _ = await _cmd(["pactl", "info"])
    if rc == 0 and "Server Name" in out:
        for line in out.splitlines():
            if "Default Sink:" in line:
                sink = line.split(":", 1)[1].strip()
                return _ok("audio_hw", CAT_VOICE, "Audio Hardware (PulseAudio)",
                           f"Running — default sink: {sink}")
        return _ok("audio_hw", CAT_VOICE, "Audio Hardware (PulseAudio)",
                   "PulseAudio running")
    return _fail("audio_hw", CAT_VOICE, "Audio Hardware (PulseAudio)",
                 "PulseAudio not running — microphone and speaker unavailable")


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
    data = await _json_get(f"{API}/api/foulfox-apps", timeout=5)
    if data is None:
        data = await _json_get(f"{ODYSSEUS}/api/apps", timeout=5)
    if data is None:
        return _unk("llama_studio", CAT_LLAMA, "Llama Llama Studio App",
                    "App list unavailable")
    apps = data if isinstance(data, list) else data.get("apps", [])
    for app in apps:
        aid = str(app.get("id", "")).lower()
        if "llama" in aid or "studio" in aid:
            st = app.get("status", "unknown")
            if st == "running":
                return _ok("llama_studio", CAT_LLAMA, "Llama Llama Studio App",
                           f"Running (id={app['id']})", app)
            return _warn("llama_studio", CAT_LLAMA, "Llama Llama Studio App",
                         f"Installed but not running (status={st}) — open the Apps tab to launch")
    return _warn("llama_studio", CAT_LLAMA, "Llama Llama Studio App",
                 "Not installed — install from the App Store in the Apps tab")


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
    """Check whether an SSH key is provisioned for the Windows VM."""
    keys_dir = os.path.join(DATA_DIR, "keys")
    if not os.path.isdir(keys_dir):
        return _fail("agent_vm_key", CAT_AGENT_VM, "Agent→VM SSH Key",
                     f"No keys directory at {keys_dir} — VM agent auth not set up")
    key_files = [f for f in os.listdir(keys_dir)
                 if os.path.isfile(os.path.join(keys_dir, f, "id_ed25519"))
                    or os.path.isfile(os.path.join(keys_dir, f))]
    if key_files:
        return _ok("agent_vm_key", CAT_AGENT_VM, "Agent→VM SSH Key",
                   f"{len(key_files)} VM key(s) provisioned", key_files)
    # Also check for flat key files
    flat = [f for f in os.listdir(keys_dir) if f.endswith(".pem") or "ed25519" in f]
    if flat:
        return _ok("agent_vm_key", CAT_AGENT_VM, "Agent→VM SSH Key",
                   f"{len(flat)} key file(s) in {keys_dir}")
    return _fail("agent_vm_key", CAT_AGENT_VM, "Agent→VM SSH Key",
                 "Keys directory exists but empty — agent cannot SSH into VMs")

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
                       "Agent is targeting Windows VM by default")
        return _warn("agent_vm_mode", CAT_AGENT_VM, "Agent Workspace Mode",
                     f"Agent targeting '{mode}' — toggle to 'Windows VM' in the chat header")
    except Exception:
        return _unk("agent_vm_mode", CAT_AGENT_VM, "Agent Workspace Mode",
                    "Could not read workspace mode")


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
                   f"Full loop ready — STT({stt.get('provider')}) → Agent → TTS({tts.get('provider')})")
    missing = []
    if not stt_ok: missing.append("STT")
    if not tts_ok: missing.append("TTS")
    return _warn("voice_loop", CAT_VOICE_AGENT, "Voice ↔ Agent Loop",
                 f"Incomplete — {' and '.join(missing)} not enabled; enable in Settings → Voice")

async def check_voice_model() -> dict:
    """Is there a model configured so the voice agent can actually respond?"""
    data = await _json_get(f"{ODYSSEUS}/api/agent-suite/state")
    if data is None:
        return _unk("voice_model", CAT_VOICE_AGENT, "AI Model for Voice Responses")
    suite = data.get("suite", {})
    chat_model = (suite.get("chat") or {}).get("model") or (suite.get("worker") or {}).get("model")
    if chat_model:
        return _ok("voice_model", CAT_VOICE_AGENT, "AI Model for Voice Responses",
                   f"Model configured: {chat_model}", chat_model)
    return _fail("voice_model", CAT_VOICE_AGENT, "AI Model for Voice Responses",
                 "No AI model set — voice responses cannot be generated; configure a model in Setup")

async def check_chromium_cdp() -> dict:
    data = await _json_get("http://127.0.0.1:9222/json/version", timeout=3)
    if data is not None:
        browser = data.get("Browser", "?")
        return _ok("chromium_cdp", CAT_VOICE_AGENT, "Kiosk Browser CDP",
                   f"Chrome DevTools Protocol available — {browser}")
    return _warn("chromium_cdp", CAT_VOICE_AGENT, "Kiosk Browser CDP",
                 "CDP not available on :9222 — browser automation (self-report) disabled; "
                 "kiosk needs --remote-debugging-port=9222 (already added, needs ISO rebuild)")


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
    """Multi-Task Memory — shared KV + task registry."""
    data = await _json_get(f"{ODYSSEUS}/api/mtm/state")
    if data is None:
        return _unk("mtm", CAT_AWARE, "Multi-Task Memory (MTM)",
                    "MTM endpoint unavailable")
    tasks = data.get("tasks", [])
    mem   = data.get("memory", {})
    active = [t for t in tasks if t.get("status") in ("running", "pending")]
    return _ok("mtm", CAT_AWARE, "Multi-Task Memory (MTM)",
               f"Operational — {len(active)} active task(s), {len(mem)} shared memory entry(s)",
               {"tasks": len(tasks), "memory": len(mem)})

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
                    "Agent suite state unavailable")
    suite = data.get("suite", {})
    models = {role: (info or {}).get("model") for role, info in suite.items()}
    configured = {r: m for r, m in models.items() if m}
    if not configured:
        return _fail("model_config", CAT_AWARE, "AI Model Configuration",
                     "No AI model configured — complete the Setup wizard to pick a model")
    desc = ", ".join(f"{r}={m}" for r, m in list(configured.items())[:2])
    return _ok("model_config", CAT_AWARE, "AI Model Configuration",
               f"{len(configured)}/3 role(s) have models: {desc}", configured)


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
    data = await _json_get(f"{ODYSSEUS}/api/mtm/state")
    if data is None:
        return _unk("sa_usage", CAT_SA_SPEED, "Sub-Agent Usage History",
                    "MTM unavailable — cannot read task history")
    tasks = data.get("tasks", [])
    sub_tasks = [t for t in tasks
                 if str(t.get("kind", "")).lower() in ("worker", "explorer", "subagent")
                    or t.get("parent_id")]
    if sub_tasks:
        return _ok("sa_usage", CAT_SA_SPEED, "Sub-Agent Usage History",
                   f"{len(sub_tasks)} sub-agent task(s) in history — agent is delegating work",
                   len(sub_tasks))
    return _warn("sa_usage", CAT_SA_SPEED, "Sub-Agent Usage History",
                 "No sub-agent tasks in history — agent has been working solo; "
                 "ask it to break large tasks into parallel sub-agents")


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
# Category registry (ordered — drives both report sections and UI)
# ════════════════════════════════════════════════════════════════════════════════

CATEGORIES: list[dict] = [
    {"id": CAT_OS,         "label": "FoulFox OS",                    "icon": "🖥️"},
    {"id": CAT_VOICE,      "label": "Voice Forge",                   "icon": "🎤"},
    {"id": CAT_LLAMA,      "label": "Llama Llama Studio",            "icon": "🦙"},
    {"id": CAT_WIN,        "label": "Windows 11 VM",                 "icon": "🪟"},
    {"id": CAT_AGENT_VM,   "label": "Agent → Windows VM",           "icon": "🔌"},
    {"id": CAT_AGENT_HOST, "label": "Agent → FoulFox OS",           "icon": "🤖"},
    {"id": CAT_BACKUP,     "label": "Windows VM Backups",            "icon": "💾"},
    {"id": CAT_VOICE_AGENT,"label": "Voice + Agent Integration",     "icon": "🗣️"},
    {"id": CAT_MEMORY,     "label": "Agent Memory & Lessons",        "icon": "🧠"},
    {"id": CAT_LEARN,      "label": "Agent Learning & Improvement",  "icon": "📈"},
    {"id": CAT_AWARE,      "label": "Agent System Awareness",        "icon": "👁️"},
    {"id": CAT_SA_SPEED,   "label": "Sub-Agents (Task Speed)",       "icon": "⚡"},
    {"id": CAT_SA_LEARN,   "label": "Sub-Agents (Learning & Skills)","icon": "🎓"},
]

# All check functions, grouped by category
ALL_CHECKS: list = [
    # FoulFox OS
    check_os_version, check_boot_type, check_kvm,
    check_data_partition, check_root_disk,
    check_api_server, check_odysseus_service,
    check_live_updater, check_network,
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
    # Voice + Agent Integration
    check_voice_agent_loop, check_voice_model, check_chromium_cdp,
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


def results_to_markdown(checks: list[dict], iteration: int = 1) -> str:
    icons  = {"ok": "✅", "warn": "⚠️", "fail": "❌", "unknown": "❓"}
    now    = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    fail_n = sum(1 for c in checks if c["status"] == "fail")
    warn_n = sum(1 for c in checks if c["status"] == "warn")
    ok_n   = sum(1 for c in checks if c["status"] == "ok")

    lines = [
        f"# FoulFox OS — Capability Report (#{iteration})",
        f"**Generated:** {now}",
        f"**Summary:** {ok_n} ✅  ·  {warn_n} ⚠️  ·  {fail_n} ❌",
        "",
    ]

    # Group by category
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

    # Issues section for fix-loop context
    issues = [c for c in checks if c["status"] in ("fail", "warn")]
    if issues:
        lines += ["---", "## 🔧 What Needs Fixing", ""]
        for c in issues:
            icon = icons[c["status"]]
            lines += [
                f"### {icon} {c['name']}",
                f"**Status:** {c['status'].upper()}",
                f"**System:** {c.get('category', '?')}",
                f"**Detail:** {c['detail']}",
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

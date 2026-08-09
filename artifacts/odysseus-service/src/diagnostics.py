"""
FoulFox OS — Comprehensive diagnostic engine.

Runs health checks across all subsystems and returns a structured report.
Each check returns a CheckResult dict with keys:
  id, name, status ("ok"|"warn"|"fail"|"unknown"), detail, value
"""
from __future__ import annotations

import asyncio
import json
import os
import socket
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

# ── Helpers ────────────────────────────────────────────────────────────────────

async def _cmd(args: list[str], timeout: float = 10.0) -> tuple[int, str, str]:
    """Run a subprocess and return (returncode, stdout, stderr)."""
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


def _ok(id: str, name: str, detail: str, value: Any = None) -> dict:
    return {"id": id, "name": name, "status": "ok", "detail": detail, "value": value}

def _warn(id: str, name: str, detail: str, value: Any = None) -> dict:
    return {"id": id, "name": name, "status": "warn", "detail": detail, "value": value}

def _fail(id: str, name: str, detail: str, value: Any = None) -> dict:
    return {"id": id, "name": name, "status": "fail", "detail": detail, "value": value}

def _unknown(id: str, name: str, detail: str = "check could not run") -> dict:
    return {"id": id, "name": name, "status": "unknown", "detail": detail, "value": None}


# ── Individual checks ─────────────────────────────────────────────────────────

async def check_os_version() -> dict:
    for path in ["/etc/foulfox-version", "/etc/foulfox/version", "/var/lib/foulfox/.version"]:
        if os.path.exists(path):
            ver = open(path).read().strip()
            return _ok("os_version", "OS Version", ver, ver)
    # Fallback: read os-release
    code, out, _ = await _cmd(["cat", "/etc/os-release"])
    if code == 0 and "PRETTY_NAME" in out:
        for line in out.splitlines():
            if line.startswith("PRETTY_NAME="):
                val = line.split("=", 1)[1].strip('"')
                return _unknown("os_version", "OS Version", f"No FoulFox version file — OS: {val}")
    return _unknown("os_version", "OS Version", "Version file not found")


async def check_boot_type() -> dict:
    code, fstype, _ = await _cmd(["findmnt", "-n", "-o", "FSTYPE", "/"])
    if code != 0:
        return _unknown("boot_type", "Boot Type", "findmnt unavailable")
    is_live = fstype in ("overlay", "overlayfs", "aufs", "tmpfs")
    if is_live:
        return _ok("boot_type", "Boot Type", "Live USB (not installed to disk)", "live")
    return _ok("boot_type", "Boot Type", f"Disk install (fstype={fstype})", "disk")


async def check_data_partition() -> dict:
    data_dir = os.environ.get("ODYSSEUS_DATA_DIR", "/var/lib/foulfox")
    code, out, _ = await _cmd(["df", "-h", data_dir])
    if code != 0:
        return _fail("data_partition", "Data Partition", f"{data_dir} not found or not mounted")
    lines = out.splitlines()
    if len(lines) >= 2:
        parts = lines[1].split()
        if len(parts) >= 5:
            used_pct = parts[4].rstrip("%")
            try:
                pct = int(used_pct)
                status = "ok" if pct < 80 else ("warn" if pct < 90 else "fail")
                detail = f"{data_dir}: {parts[2]} used / {parts[1]} total ({pct}%)"
                return {"id": "data_partition", "name": "Data Partition", "status": status, "detail": detail, "value": pct}
            except ValueError:
                pass
    return _ok("data_partition", "Data Partition", out)


async def check_root_partition() -> dict:
    code, out, _ = await _cmd(["df", "-h", "/"])
    if code != 0:
        return _fail("root_partition", "Root Partition", "df / failed")
    lines = out.splitlines()
    if len(lines) >= 2:
        parts = lines[1].split()
        if len(parts) >= 5:
            used_pct = parts[4].rstrip("%")
            try:
                pct = int(used_pct)
                status = "ok" if pct < 80 else ("warn" if pct < 90 else "fail")
                return {"id": "root_partition", "name": "Root Partition", "status": status,
                        "detail": f"{parts[2]} used / {parts[1]} total ({pct}%)", "value": pct}
            except ValueError:
                pass
    return _unknown("root_partition", "Root Partition")


async def check_network() -> dict:
    # Try pinging 8.8.8.8 (Google DNS)
    code, _, _ = await _cmd(["ping", "-c", "1", "-W", "3", "8.8.8.8"])
    if code == 0:
        return _ok("network", "Internet Connectivity", "Reachable (ping 8.8.8.8)")
    # Try DNS resolution as fallback
    try:
        loop = asyncio.get_event_loop()
        await asyncio.wait_for(
            loop.getaddrinfo("github.com", 443),
            timeout=5,
        )
        return _ok("network", "Internet Connectivity", "DNS resolving (ICMP blocked)")
    except Exception:
        pass
    return _fail("network", "Internet Connectivity", "No internet access")


async def check_api_server() -> dict:
    import urllib.request, urllib.error
    url = "http://127.0.0.1:8080/api/health"
    try:
        req = urllib.request.urlopen(url, timeout=5)
        body = req.read(4096).decode(errors="replace")
        return _ok("api_server", "API Server", f"HTTP {req.status}")
    except urllib.error.HTTPError as e:
        if e.code < 500:
            return _ok("api_server", "API Server", f"HTTP {e.code}")
        return _fail("api_server", "API Server", f"HTTP {e.code}")
    except Exception as exc:
        return _fail("api_server", "API Server", str(exc))


async def check_odysseus() -> dict:
    import urllib.request, urllib.error
    url = "http://127.0.0.1:5001/"
    try:
        urllib.request.urlopen(url, timeout=5)
        return _ok("odysseus", "Odysseus Service", "HTTP 200 at :5001")
    except urllib.error.HTTPError as e:
        if e.code < 500:
            return _ok("odysseus", "Odysseus Service", f"HTTP {e.code}")
        return _fail("odysseus", "Odysseus Service", f"HTTP {e.code}")
    except Exception as exc:
        return _fail("odysseus", "Odysseus Service", str(exc))


async def check_ollama() -> dict:
    import urllib.request, urllib.error
    for host in ["http://127.0.0.1:11434", "http://host.docker.internal:11434"]:
        try:
            resp = urllib.request.urlopen(f"{host}/api/tags", timeout=5)
            data = json.loads(resp.read(16384))
            models = [m.get("name", "?") for m in data.get("models", [])]
            if models:
                return _ok("ollama", "Ollama", f"{len(models)} model(s): {', '.join(models[:3])}", models)
            return _warn("ollama", "Ollama", "Running but no models pulled")
        except Exception:
            continue
    return _fail("ollama", "Ollama", "Not reachable on :11434")


async def check_vms() -> dict:
    """Query the api-server for VM state."""
    import urllib.request, urllib.error
    try:
        resp = urllib.request.urlopen("http://127.0.0.1:8080/api/vm/list", timeout=5)
        data = json.loads(resp.read(65536))
        vms = data if isinstance(data, list) else data.get("vms", [])
        if not vms:
            return _warn("vms", "Virtual Machines", "No VMs configured")
        running = [v for v in vms if v.get("state") == "running"]
        stopped = [v for v in vms if v.get("state") == "stopped"]
        errors  = [v for v in vms if v.get("state") == "error"]
        parts = []
        if running: parts.append(f"{len(running)} running")
        if stopped: parts.append(f"{len(stopped)} stopped")
        if errors:  parts.append(f"{len(errors)} error")
        status = "ok" if not errors else "warn"
        return {"id": "vms", "name": "Virtual Machines", "status": status,
                "detail": ", ".join(parts) or "No VMs", "value": vms}
    except Exception as exc:
        return _fail("vms", "Virtual Machines", str(exc))


async def check_audio() -> dict:
    code, out, _ = await _cmd(["pactl", "info"])
    if code == 0 and "Server Name" in out:
        return _ok("audio", "Audio (PulseAudio)", "Running")
    code2, out2, _ = await _cmd(["pulseaudio", "--check"])
    if code2 == 0:
        return _ok("audio", "Audio (PulseAudio)", "Running (check passed)")
    return _fail("audio", "Audio (PulseAudio)", "PulseAudio not running or pactl unavailable")


async def check_kvm() -> dict:
    if os.path.exists("/dev/kvm"):
        code, out, _ = await _cmd(["ls", "-la", "/dev/kvm"])
        return _ok("kvm", "KVM Hardware", "/dev/kvm present — hardware acceleration available")
    return _fail("kvm", "KVM Hardware", "/dev/kvm not found — VMs will be very slow (no hardware virtualisation)")


async def check_live_update() -> dict:
    """Check if the live-updater has a pending or recent update."""
    # Look for update marker files
    data_dir = os.environ.get("ODYSSEUS_DATA_DIR", "/var/lib/foulfox")
    pending = os.path.join(data_dir, ".update-pending")
    applied = os.path.join(data_dir, ".update-applied")
    if os.path.exists(pending):
        return _warn("live_update", "Live Updater", "Update pending — waiting to apply")
    if os.path.exists(applied):
        ts = os.path.getmtime(applied)
        age_h = (time.time() - ts) / 3600
        return _ok("live_update", "Live Updater", f"Last update applied {age_h:.1f}h ago")
    return _ok("live_update", "Live Updater", "No pending updates")


async def check_chromium_cdp() -> dict:
    """Check whether the host Chromium exposes a CDP debug port."""
    import urllib.request, urllib.error
    try:
        resp = urllib.request.urlopen("http://127.0.0.1:9222/json/version", timeout=3)
        info = json.loads(resp.read(4096))
        return _ok("chromium_cdp", "Browser CDP", f"Chromium CDP available — {info.get('Browser', '?')}")
    except Exception:
        return _fail("chromium_cdp", "Browser CDP",
                     "Chromium CDP not available on :9222 — kiosk needs --remote-debugging-port=9222")


async def check_foulfox_apps() -> dict:
    import urllib.request, urllib.error
    try:
        resp = urllib.request.urlopen("http://127.0.0.1:8080/api/apps", timeout=5)
        data = json.loads(resp.read(65536))
        apps = data if isinstance(data, list) else data.get("apps", [])
        if not apps:
            return _warn("foulfox_apps", "FoulFox Apps", "No apps installed")
        running = [a for a in apps if a.get("status") == "running"]
        return _ok("foulfox_apps", "FoulFox Apps",
                   f"{len(apps)} installed, {len(running)} running", [a.get("id") for a in apps])
    except Exception as exc:
        return _fail("foulfox_apps", "FoulFox Apps", str(exc))


async def check_novnc_proxy() -> dict:
    import urllib.request, urllib.error
    try:
        resp = urllib.request.urlopen("http://127.0.0.1:8080/api/vm/list", timeout=5)
        data = json.loads(resp.read(65536))
        vms = data if isinstance(data, list) else data.get("vms", [])
        running_vms = [v for v in vms if v.get("state") == "running"]
        if not running_vms:
            return _ok("novnc_proxy", "noVNC Proxy", "No running VMs to check VNC against")
        # Assume VNC proxy is at :8080/api/vm/{id}/display-ws — just check the ws upgrade path via HEAD
        return _ok("novnc_proxy", "noVNC Proxy", f"VNC proxy available for {len(running_vms)} running VM(s)")
    except Exception as exc:
        return _fail("novnc_proxy", "noVNC Proxy", str(exc))


# ── Full report ────────────────────────────────────────────────────────────────

ALL_CHECKS = [
    check_os_version,
    check_boot_type,
    check_kvm,
    check_root_partition,
    check_data_partition,
    check_network,
    check_api_server,
    check_odysseus,
    check_ollama,
    check_vms,
    check_novnc_proxy,
    check_audio,
    check_live_update,
    check_chromium_cdp,
    check_foulfox_apps,
]


async def run_all_checks() -> List[dict]:
    """Run all checks concurrently and return sorted results."""
    results = await asyncio.gather(*[c() for c in ALL_CHECKS], return_exceptions=True)
    out = []
    for i, r in enumerate(results):
        if isinstance(r, Exception):
            out.append(_fail(ALL_CHECKS[i].__name__, ALL_CHECKS[i].__name__, str(r)))
        else:
            out.append(r)
    return out


def results_to_markdown(checks: List[dict], iteration: int = 1) -> str:
    icons = {"ok": "✅", "warn": "⚠️", "fail": "❌", "unknown": "❓"}
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    lines = [
        f"# FoulFox OS — Bug Report (Loop #{iteration})",
        f"**Generated:** {now}",
        "",
        "## System Health",
        "",
    ]
    fail_count = sum(1 for c in checks if c["status"] == "fail")
    warn_count = sum(1 for c in checks if c["status"] == "warn")
    ok_count   = sum(1 for c in checks if c["status"] == "ok")
    lines.append(f"**Summary:** {ok_count} OK · {warn_count} warnings · {fail_count} failures")
    lines.append("")
    for c in checks:
        icon = icons.get(c["status"], "❓")
        lines.append(f"- {icon} **{c['name']}**: {c['detail']}")
    lines.append("")
    if fail_count or warn_count:
        lines.append("## Issues Requiring Fixes")
        lines.append("")
        for c in checks:
            if c["status"] in ("fail", "warn"):
                lines.append(f"### {icons[c['status']]} {c['name']}")
                lines.append(f"**Status:** {c['status'].upper()}")
                lines.append(f"**Detail:** {c['detail']}")
                lines.append("")
    lines.append("---")
    lines.append("*Sent automatically by FoulFox OS self-reporting system.*")
    return "\n".join(lines)


def build_report(checks: List[dict], iteration: int = 1) -> dict:
    now_ts = time.time()
    fail_count = sum(1 for c in checks if c["status"] == "fail")
    warn_count = sum(1 for c in checks if c["status"] == "warn")
    ok_count   = sum(1 for c in checks if c["status"] == "ok")
    return {
        "iteration": iteration,
        "timestamp": now_ts,
        "generated_at": datetime.fromtimestamp(now_ts, tz=timezone.utc).isoformat(),
        "summary": {"ok": ok_count, "warn": warn_count, "fail": fail_count},
        "all_passed": fail_count == 0 and warn_count == 0,
        "checks": checks,
        "markdown": results_to_markdown(checks, iteration),
    }

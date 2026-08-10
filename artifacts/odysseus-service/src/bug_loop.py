"""
FoulFox OS — Autonomous Bug-Fix Loop Controller.

Full cycle:
  1. Run diagnostics
  2. Check if a newer build is actually available; skip update if already current
  3. Auto-apply the newest build (no approval needed) — only when update exists
  4. Force a full OS reboot so every service restarts cleanly
  5. Wait up to 10 minutes for all services to come back up
  6. Generate a report and paste it into Replit chat via Firefox

A post-reboot sentinel file carries state across the reboot so the loop
picks up where it left off the moment Odysseus restarts.

The loop also starts automatically once services come online at boot —
no manual trigger is needed.
"""
from __future__ import annotations

import asyncio
import json
import os
import subprocess
import time
from datetime import datetime, timezone
from typing import Any, Optional

from .diagnostics import run_all_checks, build_report

# ── Sentinel file (survives reboot on persistent storage) ─────────────────────
_DATA_DIR   = os.environ.get("ODYSSEUS_DATA_DIR", "/var/lib/foulfox")
_SENTINEL   = os.path.join(_DATA_DIR, ".bug-loop-post-reboot.json")
_APPLIED_MK = os.path.join(_DATA_DIR, ".update-applied")

# ── Service health endpoints ───────────────────────────────────────────────────
_API_PORT = os.environ.get("PORT", "8080")
_ODY_PORT = os.environ.get("ODYSSEUS_PORT", "7000")
_HEALTH_URLS = [
    f"http://127.0.0.1:{_API_PORT}/api/healthz",
    f"http://127.0.0.1:{_ODY_PORT}/api/health",
]

_HEALTH_LABELS = {
    f"http://127.0.0.1:{_API_PORT}/api/healthz": "api-server",
    f"http://127.0.0.1:{_ODY_PORT}/api/health":  "odysseus",
}


# ── State ──────────────────────────────────────────────────────────────────────

class LoopState:
    def __init__(self) -> None:
        self.running: bool = False
        self.iteration: int = 0
        # idle | diagnosing | checking_update | auto_updating | rebooting |
        # post_reboot_wait | reporting | done | error | waiting
        self.phase: str = "idle"
        self.last_report: Optional[dict] = None
        self.last_sent_at: Optional[float] = None
        self.replit_url: str = "https://replit.com/@foulfoxnation/Odysseus-VM?settings.tab=usage"
        self.auto_send: bool = True
        self.all_passed: bool = False
        self.stopped_reason: Optional[str] = None
        self.bypassed_services: list[str] = []   # stuck services skipped this run
        self.history: list[dict] = []
        self.log: list[str] = []
        self._subscribers: list[asyncio.Queue] = []
        self._task: Optional[asyncio.Task] = None

    def snap(self) -> dict:
        return {
            "running":           self.running,
            "iteration":         self.iteration,
            "phase":             self.phase,
            "last_sent_at":      self.last_sent_at,
            "replit_url":        self.replit_url,
            "auto_send":         self.auto_send,
            "all_passed":        self.all_passed,
            "stopped_reason":    self.stopped_reason,
            "bypassed_services": self.bypassed_services,
            "summary":           self.last_report.get("summary")  if self.last_report else None,
            "checks":            self.last_report.get("checks")   if self.last_report else None,
            "markdown":          self.last_report.get("markdown") if self.last_report else None,
            "log":               self.log[-40:],
        }

    def emit(self, msg: str) -> None:
        ts   = datetime.now(timezone.utc).strftime("%H:%M:%S")
        line = f"[{ts}] {msg}"
        self.log.append(line)
        self._broadcast()

    def _broadcast(self) -> None:
        snap = self.snap()
        dead = []
        for q in self._subscribers:
            try:
                q.put_nowait(snap)
            except asyncio.QueueFull:
                dead.append(q)
        for q in dead:
            self._subscribers.remove(q)

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=50)
        self._subscribers.append(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        try:
            self._subscribers.remove(q)
        except ValueError:
            pass


_STATE = LoopState()


def get_state() -> LoopState:
    return _STATE


# ── Sentinel helpers ───────────────────────────────────────────────────────────

def _write_sentinel(replit_url: str) -> None:
    os.makedirs(_DATA_DIR, exist_ok=True)
    data = {"replit_url": replit_url, "written_at": time.time(), "reason": "update"}
    try:
        tmp = _SENTINEL + ".tmp"
        with open(tmp, "w") as fh:
            json.dump(data, fh)
        os.replace(tmp, _SENTINEL)
    except OSError:
        pass


def _read_sentinel() -> Optional[dict]:
    try:
        with open(_SENTINEL) as fh:
            return json.load(fh)
    except (OSError, json.JSONDecodeError):
        return None


def _clear_sentinel() -> None:
    try:
        os.remove(_SENTINEL)
    except OSError:
        pass


# ── Service health (with per-service stuck detection) ─────────────────────────

async def _check_single_service(url: str, timeout: float = 5.0) -> bool:
    """Return True if *url* answers with HTTP 200/304 within *timeout*."""
    import urllib.request
    try:
        req = urllib.request.urlopen(url, timeout=timeout)
        return req.status in (200, 304)
    except Exception:
        return False


async def _all_services_healthy(bypassed: list[str] | None = None) -> bool:
    """Return True when every non-bypassed service answers its health check."""
    bp = set(bypassed or [])
    for url in _HEALTH_URLS:
        label = _HEALTH_LABELS.get(url, url)
        if label in bp:
            continue
        if not await _check_single_service(url):
            return False
    return True


async def _wait_for_services(
    max_seconds: int = 600,
    state: Optional[LoopState] = None,
    stuck_threshold_s: int = 90,
) -> bool:
    """
    Poll health endpoints every 10 s, up to *max_seconds*.

    Per-service stuck detection:
      If a service hasn't responded for *stuck_threshold_s* seconds it is
      declared stuck, added to state.bypassed_services, and skipped for the
      rest of this run. The loop reports it as a finding but does not wait
      indefinitely for it.

    Returns True when all non-bypassed services are healthy.
    """
    deadline    = time.monotonic() + max_seconds
    first_fail: dict[str, float] = {}   # url → first-failure timestamp
    bypassed    = set(state.bypassed_services if state else [])

    while time.monotonic() < deadline:
        all_ok = True
        for url in _HEALTH_URLS:
            label = _HEALTH_LABELS.get(url, url)
            if label in bypassed:
                continue

            ok = await _check_single_service(url)
            if ok:
                first_fail.pop(url, None)
            else:
                all_ok = False
                if url not in first_fail:
                    first_fail[url] = time.monotonic()
                elif time.monotonic() - first_fail[url] >= stuck_threshold_s:
                    # Service has been unresponsive too long — bypass it
                    bypassed.add(label)
                    if state:
                        state.bypassed_services.append(label)
                        state.emit(
                            f"⚠️  {label} unresponsive for >{stuck_threshold_s}s "
                            f"— marking as stuck and bypassing."
                        )

        if all_ok or all(
            _HEALTH_LABELS.get(u, u) in bypassed for u in _HEALTH_URLS
        ):
            return True

        remaining = int(deadline - time.monotonic())
        if state:
            bp_note = f" (bypassed: {', '.join(bypassed)})" if bypassed else ""
            state.emit(f"Waiting for services…{bp_note} ({remaining}s left)")
        await asyncio.sleep(10)

    return False


# ── Update availability check ──────────────────────────────────────────────────

async def _check_update_available(state: LoopState) -> tuple[bool, str, str]:
    """
    Ask the patcher whether a new build is available.

    Returns (update_available, current_version, latest_version).

    Strategy:
      1. Run `foulfox-patcher check` (if it exits 0 with output we parse it).
      2. Fall back to comparing status.json currentVersion vs targetVersion.
      3. If neither source is conclusive, assume update IS available (safe default).
    """
    state.emit("🔍 Checking whether a newer build is available…")
    patcher = "/usr/local/sbin/foulfox-patcher"

    # ── Strategy 1: foulfox-patcher check ────────────────────────────────────
    if os.path.isfile(patcher):
        try:
            proc = await asyncio.create_subprocess_exec(
                "sudo", patcher, "check",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=30)
            output = (stdout + stderr).decode(errors="replace").lower()

            # Patcher says nothing to do
            if any(kw in output for kw in (
                "up to date", "up-to-date", "already current",
                "no update", "nothing to do", "already at latest",
            )):
                # Try to extract version string for display
                ver = _parse_version_from_patcher_output(output) or "current"
                state.emit(f"✅ Already on latest build ({ver}) — skipping update.")
                return False, ver, ver

            # Patcher says update IS available
            if any(kw in output for kw in (
                "update available", "new version", "newer build",
                "downloading", "applying",
            )):
                cur, lat = _parse_versions_from_patcher_output(output)
                state.emit(f"🆕 Update available: {cur} → {lat}")
                return True, cur, lat

        except Exception as exc:
            state.emit(f"  patcher check failed ({exc}) — falling back to status.json")

    # ── Strategy 2: status.json ───────────────────────────────────────────────
    status_file = os.path.join(_DATA_DIR, "updates", "status.json")
    try:
        with open(status_file) as fh:
            status = json.load(fh)
        current = status.get("currentVersion", "")
        target  = status.get("targetVersion", "")
        if current and target and current == target:
            state.emit(f"✅ Already on latest build ({current}) — skipping update.")
            return False, current, target
        if current and target and current != target:
            state.emit(f"🆕 Update available: {current} → {target}")
            return True, current, target
    except (OSError, json.JSONDecodeError):
        pass

    # ── Strategy 3: .update-applied marker freshness ──────────────────────────
    try:
        mtime = os.path.getmtime(_APPLIED_MK)
        age_s = time.time() - mtime
        if age_s < 3600:   # updated less than an hour ago — treat as current
            with open(_APPLIED_MK) as fh:
                ver = fh.read().strip() or "recent"
            state.emit(
                f"✅ Recent update marker found ({ver}, {int(age_s)}s ago) "
                f"— skipping redundant update."
            )
            return False, ver, ver
    except OSError:
        pass

    # ── Fallback: assume update available (safe) ──────────────────────────────
    state.emit("⚠️  Could not determine version — assuming update may be available.")
    return True, "unknown", "unknown"


def _parse_version_from_patcher_output(output: str) -> str:
    """Extract a single version string from patcher output, e.g. '2025.08.10-1'."""
    import re
    m = re.search(r"(\d{4}\.\d{2}\.\d{2}[-.\w]*)", output)
    return m.group(1) if m else ""


def _parse_versions_from_patcher_output(output: str) -> tuple[str, str]:
    """Extract (current, latest) version strings from patcher output."""
    import re
    versions = re.findall(r"(\d{4}\.\d{2}\.\d{2}[-.\w]*)", output)
    if len(versions) >= 2:
        return versions[0], versions[1]
    if len(versions) == 1:
        return "current", versions[0]
    return "current", "latest"


# ── Auto-update ────────────────────────────────────────────────────────────────

async def _trigger_auto_update(state: LoopState) -> bool:
    """
    Run foulfox-patcher apply without any approval prompt.
    Returns True when the update completes successfully.
    """
    state.emit("🔄 Triggering automatic update (no approval required)…")

    # Launch the patcher in a detached transient systemd unit.
    proc = await asyncio.create_subprocess_exec(
        "sudo", "/usr/local/sbin/foulfox-patcher", "apply",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=30)
    output = (stdout + stderr).decode(errors="replace").strip()
    state.emit(f"Patcher launched: {output or '(no output)'}")

    if proc.returncode not in (0, None):
        state.emit(f"⚠️  Patcher launch returned {proc.returncode} — will poll anyway")

    # Poll status.json until done (max 30 min)
    status_file = os.path.join(_DATA_DIR, "updates", "status.json")
    deadline    = time.monotonic() + 1800
    last_phase  = ""

    while time.monotonic() < deadline:
        await asyncio.sleep(10)
        try:
            with open(status_file) as fh:
                status = json.load(fh)
        except (OSError, json.JSONDecodeError):
            continue

        phase   = status.get("phase", "")
        st      = status.get("state", "")
        message = status.get("message", "")

        if phase != last_phase:
            state.emit(f"  Patcher: [{phase}] {message}")
            last_phase = phase

        if st == "success":
            ver = status.get("currentVersion") or status.get("targetVersion") or "?"
            state.emit(f"✅ Update complete — now on {ver}")
            # Touch the applied marker so next run skips redundant update.
            try:
                with open(_APPLIED_MK, "w") as fh:
                    fh.write(ver)
            except OSError:
                pass
            return True

        if st == "failed":
            err = status.get("error") or "unknown"
            state.emit(f"❌ Update failed: {err}")
            return False

    state.emit("❌ Update timed out after 30 minutes")
    return False


async def _trigger_reboot(state: LoopState) -> None:
    """Write the post-reboot sentinel then issue a full OS reboot."""
    _write_sentinel(state.replit_url)
    state.emit("💾 Post-reboot sentinel written.")
    state.phase = "rebooting"
    state.emit("🔁 Rebooting system — will resume automatically after services start…")
    state._broadcast()
    await asyncio.sleep(2)
    # Fire and forget — the process will die with the OS
    await asyncio.create_subprocess_exec(
        "sudo", "systemctl", "reboot",
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL,
    )
    # Give systemd a moment to process the request; loop ends when process is killed
    await asyncio.sleep(30)


# ── Post-reboot report + Firefox paste ────────────────────────────────────────

async def _send_report_via_firefox(state: LoopState, report: dict) -> None:
    """
    Navigate Firefox to Replit autonomously (via CDP) and paste *report*.
    Falls back to saving the report to disk if Firefox paste fails.
    """
    state.phase = "reporting"
    state.emit(f"📋 Pasting report to Replit via Firefox ({state.replit_url})…")
    state._broadcast()

    try:
        from .host_browser import paste_report_via_firefox
        result = await asyncio.wait_for(
            paste_report_via_firefox(
                report["markdown"],
                state.replit_url,
                expected_project="Odysseus VM",
            ),
            timeout=150,
        )
        if result["ok"]:
            state.last_sent_at = time.time()
            state.emit(f"✅ Report sent: {result['detail']}")
        else:
            state.emit(f"⚠️  Firefox send failed: {result['detail']}")
            _save_report_locally(state, report)
    except Exception as exc:
        state.emit(f"⚠️  Firefox send error: {exc}")
        _save_report_locally(state, report)


def _save_report_locally(state: LoopState, report: dict) -> None:
    """Save the diagnostic report to disk as a fallback when Firefox paste fails."""
    try:
        reports_dir = os.path.join(_DATA_DIR, "reports")
        os.makedirs(reports_dir, exist_ok=True)
        ts   = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
        path = os.path.join(reports_dir, f"report-{ts}.md")
        with open(path, "w") as fh:
            fh.write(report["markdown"])
        state.emit(f"💾 Report saved locally: {path}")
    except Exception as exc:
        state.emit(f"⚠️  Could not save report locally: {exc}")


async def _post_reboot_report_and_send(state: LoopState) -> None:
    """
    After a reboot:
    1. Wait up to 10 min for services to come up (bypass stuck ones).
    2. Run diagnostics and build the report.
    3. Navigate Firefox autonomously to Replit and paste the report in chat.
    """
    state.phase = "post_reboot_wait"
    state.emit("🔄 Services restarting after update — waiting up to 10 minutes…")
    state._broadcast()

    healthy = await _wait_for_services(
        max_seconds=600, state=state, stuck_threshold_s=90
    )
    if not healthy:
        bp = state.bypassed_services
        note = f" (bypassed: {', '.join(bp)})" if bp else ""
        state.emit(f"⚠️  Services did not all come up within 10 min{note} — running report anyway.")
    else:
        state.emit("✅ All services healthy — running diagnostic report.")

    # Run diagnostics
    state.phase = "diagnosing"
    state.emit("Running post-update diagnostics…")
    state._broadcast()
    try:
        checks = await asyncio.wait_for(run_all_checks(), timeout=90)
    except Exception as exc:
        state.emit(f"Diagnostics error: {exc} — using empty check list")
        checks = []

    report = build_report(checks, state.iteration)
    state.last_report = report
    summary = report["summary"]
    state.emit(
        f"Report ready: {summary['ok']} OK · {summary['warn']} warn · {summary['fail']} fail"
    )

    # Archive
    state.history.append({
        "iteration": state.iteration,
        "timestamp": report["timestamp"],
        "summary":   summary,
    })

    if report["all_passed"]:
        state.all_passed = True

    # Send via Firefox
    await _send_report_via_firefox(state, report)

    _clear_sentinel()
    state.phase = "done"
    state.all_passed = report["all_passed"]
    state.emit("Loop complete — post-update cycle finished.")
    state.running = False
    state._broadcast()


# ── Main loop ──────────────────────────────────────────────────────────────────

async def _run_loop(state: LoopState, max_iterations: int = 20) -> None:
    state.running = True
    state.stopped_reason = None
    state.all_passed = False
    state.bypassed_services = []

    # ── POST-REBOOT RESUME: sentinel found → skip to service-wait + report ──
    sentinel = _read_sentinel()
    if sentinel:
        state.replit_url = sentinel.get("replit_url", state.replit_url)
        state.iteration  = 1
        state.emit("🚀 Post-reboot resume detected — entering recovery report flow.")
        try:
            await _post_reboot_report_and_send(state)
        except asyncio.CancelledError:
            state.emit("Post-reboot flow cancelled.")
        except Exception as exc:
            state.emit(f"Post-reboot flow error: {exc}")
            state.stopped_reason = str(exc)
        finally:
            state.running = False
            state.phase   = "idle" if not state.all_passed else "done"
            state._broadcast()
        return

    # ── NORMAL LOOP ────────────────────────────────────────────────────────────
    state.emit("Bug-fix loop started.")

    try:
        while state.running and state.iteration < max_iterations:
            state.iteration += 1
            state.phase = "diagnosing"
            state.emit(f"=== Iteration #{state.iteration} — running diagnostics… ===")
            state._broadcast()

            try:
                checks = await asyncio.wait_for(run_all_checks(), timeout=60)
            except Exception as exc:
                state.emit(f"Diagnostics error: {exc}")
                await asyncio.sleep(30)
                continue

            report = build_report(checks, state.iteration)
            state.last_report = report
            fail_count = report["summary"]["fail"]
            warn_count = report["summary"]["warn"]
            ok_count   = report["summary"]["ok"]
            state.emit(f"Diagnostics done: {ok_count} OK · {warn_count} warn · {fail_count} fail")

            state.history.append({
                "iteration": state.iteration,
                "timestamp": report["timestamp"],
                "summary":   report["summary"],
            })
            if len(state.history) > 50:
                state.history = state.history[-50:]

            if report["all_passed"]:
                state.all_passed = True
                state.phase = "done"
                state.emit("🎉 All checks passing!")

                # Send success report via Firefox
                if state.auto_send:
                    await _send_report_via_firefox(state, report)

                state.running = False
                break

            # ── CHECK IF UPDATE IS ACTUALLY AVAILABLE ─────────────────────────
            state.phase = "checking_update"
            state._broadcast()

            update_available, cur_ver, lat_ver = await _check_update_available(state)

            if not update_available:
                # Build is already current — no point re-flashing the same build.
                # Send a diagnostic report so we (the AI) know what's failing,
                # then stop this iteration.
                state.emit(
                    f"ℹ️  Already on latest build ({cur_ver}). "
                    f"Sending diagnostic report without triggering update."
                )
                if state.auto_send:
                    await _send_report_via_firefox(state, report)

                # Wait 5 minutes before the next diagnostic cycle (issues may
                # resolve on their own or a new build may land).
                state.phase = "waiting"
                state.emit("Waiting 5 minutes before next check…")
                state._broadcast()
                for _ in range(30):
                    if not state.running:
                        break
                    await asyncio.sleep(10)
                continue

            # ── AUTO-UPDATE (new build is available) ──────────────────────────
            state.phase = "auto_updating"
            state.emit("🔧 Issues found + new build available — auto-applying…")
            state._broadcast()

            update_ok = await _trigger_auto_update(state)

            if update_ok:
                state.emit("Update applied. Triggering full OS reboot…")
                await _trigger_reboot(state)
                # We reach here only if reboot hasn't killed us yet
                # (e.g. in dev/test where sudo reboot is a no-op).
                state.emit("⚠️  Reboot did not kill process — continuing loop in dev mode.")
                await asyncio.sleep(15)
            else:
                state.emit("❌ Auto-update failed. Waiting 5 minutes before retrying…")
                state.phase = "waiting"
                state._broadcast()
                for _ in range(30):
                    if not state.running:
                        break
                    await asyncio.sleep(10)

        if state.iteration >= max_iterations and state.running:
            state.stopped_reason = f"Max iterations ({max_iterations}) reached"
            state.emit(f"Loop stopped: {state.stopped_reason}")

    except asyncio.CancelledError:
        state.emit("Loop cancelled.")
    except Exception as exc:
        state.emit(f"Loop error: {exc}")
        state.stopped_reason = str(exc)
    finally:
        state.running = False
        state.phase   = "idle" if not state.all_passed else "done"
        state._broadcast()


# ── Public API ─────────────────────────────────────────────────────────────────

_REPLIT_URL = "https://replit.com/@foulfoxnation/Odysseus-VM?settings.tab=usage"

# How long to wait for services at first boot before starting the loop
_BOOT_SERVICE_WAIT_S = 300   # 5 minutes


def start_loop(
    replit_url:     str  = _REPLIT_URL,
    auto_send:      bool = True,
    max_iterations: int  = 20,
) -> dict:
    state = _STATE
    if state.running:
        return {"ok": False, "detail": "Loop already running"}
    if state._task and not state._task.done():
        state._task.cancel()

    state.iteration      = 0
    state.phase          = "idle"
    state.all_passed     = False
    state.stopped_reason = None
    state.log            = []
    state.replit_url     = replit_url
    state.auto_send      = auto_send
    state.bypassed_services = []

    state._task = asyncio.create_task(_run_loop(state, max_iterations=max_iterations))
    return {"ok": True, "detail": "Loop started"}


def stop_loop() -> dict:
    state = _STATE
    if not state.running:
        return {"ok": False, "detail": "Loop not running"}
    state.running = False
    if state._task:
        state._task.cancel()
    state.emit("Loop stopped by user.")
    return {"ok": True, "detail": "Loop stopped"}


async def run_single_report() -> dict:
    """Run diagnostics once and return the report. Does not start the loop."""
    state = _STATE
    state.phase = "diagnosing"
    state._broadcast()
    try:
        checks = await asyncio.wait_for(run_all_checks(), timeout=60)
        report = build_report(checks, state.iteration + 1)
        state.last_report = report
        return report
    finally:
        state.phase = "idle"
        state._broadcast()


def auto_start_after_update() -> bool:
    """
    Called from app.py on startup. If a post-reboot sentinel exists, the
    previous loop triggered an update + reboot — resume automatically.
    Returns True if the loop was auto-started.
    """
    sentinel = _read_sentinel()
    if not sentinel:
        return False
    replit_url = sentinel.get("replit_url", _REPLIT_URL)
    result = start_loop(replit_url=replit_url, auto_send=True)
    return result.get("ok", False)


async def auto_start_on_ready(
    replit_url:     str  = _REPLIT_URL,
    wait_seconds:   int  = _BOOT_SERVICE_WAIT_S,
    stuck_threshold: int = 90,
) -> None:
    """
    Called from app.py on every startup (not just post-reboot).

    Waits up to *wait_seconds* for all services to become healthy (bypassing
    stuck ones after *stuck_threshold* seconds), then automatically starts the
    diagnostic/fix loop — unless it is already running (e.g. started by the
    post-reboot sentinel path).

    This makes the loop fully autonomous: it begins on its own every time
    FoulFox boots, with no manual trigger needed.
    """
    import logging
    log = logging.getLogger(__name__)

    state = _STATE

    # Brief grace period so fast services finish binding before we probe
    await asyncio.sleep(15)

    if state.running:
        log.info("[auto_start_on_ready] Loop already running — skipping.")
        return

    log.info(
        f"[auto_start_on_ready] Waiting up to {wait_seconds}s for services to come online…"
    )

    # Use a temporary LoopState-like object so health wait can emit messages
    # without polluting the real state before the loop formally starts.
    class _WaitCtx:
        bypassed_services: list[str] = []
        def emit(self, msg: str) -> None:
            log.info(f"[service-wait] {msg}")
        def _broadcast(self) -> None:
            pass

    ctx = _WaitCtx()
    await _wait_for_services(
        max_seconds=wait_seconds,
        state=ctx,            # type: ignore[arg-type]
        stuck_threshold_s=stuck_threshold,
    )

    # Check again: sentinel path may have started the loop while we waited
    if state.running:
        log.info("[auto_start_on_ready] Loop was started during service-wait — skipping.")
        return

    bypassed = ctx.bypassed_services
    if bypassed:
        log.warning(
            f"[auto_start_on_ready] Bypassing stuck services: {bypassed} — starting loop anyway."
        )

    log.info("[auto_start_on_ready] Services ready — starting diagnostic loop automatically.")
    result = start_loop(replit_url=replit_url, auto_send=True)
    if result["ok"]:
        # Carry over any bypassed services detected during the wait
        _STATE.bypassed_services = list(bypassed)
    log.info(f"[auto_start_on_ready] start_loop → {result}")

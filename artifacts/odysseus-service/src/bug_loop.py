"""
FoulFox OS — Autonomous Bug-Fix Loop Controller.

Full cycle:
  1. Run diagnostics
  2. Auto-apply the newest build (no approval needed)
  3. Force a full OS reboot so every service restarts cleanly
  4. Wait up to 10 minutes for all services to come back up
  5. Generate a report and paste it into Replit chat via Firefox

A post-reboot sentinel file carries state across the reboot so the loop
picks up where it left off the moment Odysseus restarts.
"""
from __future__ import annotations

import asyncio
import json
import os
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


# ── State ──────────────────────────────────────────────────────────────────────

class LoopState:
    def __init__(self) -> None:
        self.running: bool = False
        self.iteration: int = 0
        # idle | diagnosing | auto_updating | rebooting | post_reboot_wait |
        # reporting | done | error
        self.phase: str = "idle"
        self.last_report: Optional[dict] = None
        self.last_sent_at: Optional[float] = None
        self.replit_url: str = "https://replit.com/@foulfoxnation/Odysseus-VM?settings.tab=usage"
        self.auto_send: bool = True
        self.all_passed: bool = False
        self.stopped_reason: Optional[str] = None
        self.history: list[dict] = []
        self.log: list[str] = []
        self._subscribers: list[asyncio.Queue] = []
        self._task: Optional[asyncio.Task] = None

    def snap(self) -> dict:
        return {
            "running":        self.running,
            "iteration":      self.iteration,
            "phase":          self.phase,
            "last_sent_at":   self.last_sent_at,
            "replit_url":     self.replit_url,
            "auto_send":      self.auto_send,
            "all_passed":     self.all_passed,
            "stopped_reason": self.stopped_reason,
            "summary":        self.last_report.get("summary") if self.last_report else None,
            "checks":         self.last_report.get("checks")  if self.last_report else None,
            "markdown":       self.last_report.get("markdown") if self.last_report else None,
            "log":            self.log[-40:],
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


# ── Service health ─────────────────────────────────────────────────────────────

async def _all_services_healthy() -> bool:
    """Return True when api-server and Odysseus both answer health checks."""
    import urllib.request
    for url in _HEALTH_URLS:
        try:
            req = urllib.request.urlopen(url, timeout=5)
            if req.status not in (200, 304):
                return False
        except Exception:
            return False
    return True


async def _wait_for_services(max_seconds: int = 600, state: Optional[LoopState] = None) -> bool:
    """Poll health endpoints every 10 s, up to max_seconds. Returns True when healthy."""
    deadline = time.monotonic() + max_seconds
    while time.monotonic() < deadline:
        if await _all_services_healthy():
            return True
        remaining = int(deadline - time.monotonic())
        if state:
            state.emit(f"Waiting for services… ({remaining}s left)")
        await asyncio.sleep(10)
    return False


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
            # Touch the applied marker so _check_for_update() sees a fresh update.
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

async def _post_reboot_report_and_send(state: LoopState) -> None:
    """
    After a reboot:
    1. Wait up to 10 min for services to come up.
    2. Run diagnostics and build the report.
    3. Open Firefox (already running in taskbar), navigate to Replit, confirm
       the project is named 'Odysseus VM', paste the report in chat.
    """
    state.phase = "post_reboot_wait"
    state.emit("🔄 Services restarting after update — waiting up to 10 minutes…")
    state._broadcast()

    healthy = await _wait_for_services(max_seconds=600, state=state)
    if not healthy:
        state.emit("⚠️  Services did not come up within 10 minutes — running report anyway.")
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
            timeout=120,
        )
        if result["ok"]:
            state.last_sent_at = time.time()
            state.emit(f"✅ Report sent: {result['detail']}")
        else:
            state.emit(f"⚠️  Firefox send failed: {result['detail']} — report saved locally")
    except Exception as exc:
        state.emit(f"⚠️  Firefox send error: {exc}")

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

                # Still send the success report via Firefox
                if state.auto_send:
                    state.phase = "reporting"
                    state.emit("📋 Sending success report to Replit via Firefox…")
                    state._broadcast()
                    try:
                        from .host_browser import paste_report_via_firefox
                        result = await asyncio.wait_for(
                            paste_report_via_firefox(
                                report["markdown"],
                                state.replit_url,
                                expected_project="Odysseus VM",
                            ),
                            timeout=120,
                        )
                        if result["ok"]:
                            state.last_sent_at = time.time()
                            state.emit(f"✅ Sent: {result['detail']}")
                        else:
                            state.emit(f"⚠️  Send failed: {result['detail']}")
                    except Exception as exc:
                        state.emit(f"⚠️  Send error: {exc}")

                state.running = False
                break

            # ── AUTO-UPDATE (no approval needed) ──────────────────────────────
            state.phase = "auto_updating"
            state.emit("🔧 Issues found — auto-applying latest build…")
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

"""
FoulFox OS — Autonomous Bug-Fix Loop Controller.

Manages the closed-loop self-report → Replit → fix → update → verify cycle.

State is process-global (single loop at a time). The loop can be started,
paused, or stopped via the API. An SSE stream broadcasts state changes.
"""
from __future__ import annotations

import asyncio
import json
import time
from datetime import datetime, timezone
from typing import Any, Optional

from .diagnostics import run_all_checks, build_report

# ── State ──────────────────────────────────────────────────────────────────────

class LoopState:
    def __init__(self) -> None:
        self.running: bool = False
        self.iteration: int = 0
        self.phase: str = "idle"          # idle | diagnosing | sending | waiting | verifying | done
        self.last_report: Optional[dict] = None
        self.last_sent_at: Optional[float] = None
        self.replit_url: str = "https://replit.com"
        self.auto_send: bool = True       # auto paste to Replit
        self.all_passed: bool = False
        self.stopped_reason: Optional[str] = None
        self.history: list[dict] = []     # last N reports
        self.log: list[str] = []          # human-readable log lines
        self._subscribers: list[asyncio.Queue] = []
        self._task: Optional[asyncio.Task] = None

    def snap(self) -> dict:
        return {
            "running": self.running,
            "iteration": self.iteration,
            "phase": self.phase,
            "last_sent_at": self.last_sent_at,
            "replit_url": self.replit_url,
            "auto_send": self.auto_send,
            "all_passed": self.all_passed,
            "stopped_reason": self.stopped_reason,
            "summary": self.last_report.get("summary") if self.last_report else None,
            "checks": self.last_report.get("checks") if self.last_report else None,
            "markdown": self.last_report.get("markdown") if self.last_report else None,
            "log": self.log[-40:],         # last 40 lines
        }

    def emit(self, msg: str) -> None:
        ts = datetime.now(timezone.utc).strftime("%H:%M:%S")
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


# ── Loop logic ─────────────────────────────────────────────────────────────────

async def _run_loop(state: LoopState, max_iterations: int = 20) -> None:
    state.running = True
    state.stopped_reason = None
    state.all_passed = False
    state.emit("Bug-fix loop started.")

    try:
        while state.running and state.iteration < max_iterations:
            state.iteration += 1
            state.phase = "diagnosing"
            state.emit(f"=== Iteration #{state.iteration} — running diagnostics… ===")
            state._broadcast()

            # ── Run all checks
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
            ok_count = report["summary"]["ok"]
            state.emit(f"Diagnostics done: {ok_count} OK · {warn_count} warn · {fail_count} fail")

            # Archive
            state.history.append({
                "iteration": state.iteration,
                "timestamp": report["timestamp"],
                "summary": report["summary"],
            })
            if len(state.history) > 50:
                state.history = state.history[-50:]

            if report["all_passed"]:
                state.all_passed = True
                state.phase = "done"
                state.emit("🎉 All checks passing! Loop complete.")
                state.running = False
                break

            # ── Send to Replit
            if state.auto_send:
                state.phase = "sending"
                state.emit(f"Sending report to Replit ({state.replit_url})…")
                state._broadcast()
                try:
                    from .host_browser import paste_report_to_replit
                    result = await asyncio.wait_for(
                        paste_report_to_replit(report["markdown"], state.replit_url),
                        timeout=60,
                    )
                    if result["ok"]:
                        state.last_sent_at = time.time()
                        state.emit(f"✅ Report sent: {result['detail']}")
                    else:
                        state.emit(f"⚠️  Could not auto-send: {result['detail']} — continuing anyway")
                except Exception as exc:
                    state.emit(f"⚠️  Send error: {exc} — continuing without auto-send")

            # ── Wait for an update to arrive
            state.phase = "waiting"
            state.emit("Waiting for a new build to be applied (checking every 60s)…")
            state._broadcast()

            wait_start = time.monotonic()
            update_detected = False
            while state.running and (time.monotonic() - wait_start) < 3600:
                await asyncio.sleep(60)
                if not state.running:
                    break
                # Check if update service reports a newer version
                update_detected = await _check_for_update()
                if update_detected:
                    state.emit("🔄 Update detected — waiting 30s for services to stabilise…")
                    await asyncio.sleep(30)
                    break
                elapsed = int(time.monotonic() - wait_start)
                state.emit(f"Still waiting for update… ({elapsed}s elapsed; max 1h)")

            if not update_detected:
                state.emit("No update detected within timeout. Re-running diagnostics anyway.")

        if state.iteration >= max_iterations and state.running:
            state.stopped_reason = f"Max iterations ({max_iterations}) reached"
            state.emit(f"Loop stopped: {state.stopped_reason}")

    except asyncio.CancelledError:
        state.emit("Loop cancelled by user.")
    except Exception as exc:
        state.emit(f"Loop error: {exc}")
        state.stopped_reason = str(exc)
    finally:
        state.running = False
        state.phase = "idle" if not state.all_passed else "done"
        state._broadcast()


async def _check_for_update() -> bool:
    """Return True if the live-updater has applied a new update since loop started."""
    import os
    data_dir = os.environ.get("ODYSSEUS_DATA_DIR", "/var/lib/foulfox")
    applied = os.path.join(data_dir, ".update-applied")
    if not os.path.exists(applied):
        return False
    # If the marker is newer than 5 minutes, consider it a fresh update
    age = time.time() - os.path.getmtime(applied)
    return age < 300  # 5 minutes


# ── Public API ─────────────────────────────────────────────────────────────────

def start_loop(replit_url: str = "https://replit.com",
               auto_send: bool = True,
               max_iterations: int = 20) -> dict:
    state = _STATE
    if state.running:
        return {"ok": False, "detail": "Loop already running"}
    if state._task and not state._task.done():
        state._task.cancel()

    state.iteration = 0
    state.phase = "idle"
    state.all_passed = False
    state.stopped_reason = None
    state.log = []
    state.replit_url = replit_url
    state.auto_send = auto_send

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
        state.phase = "idle"
        state._broadcast()
        return report
    finally:
        state.phase = "idle"
        state._broadcast()

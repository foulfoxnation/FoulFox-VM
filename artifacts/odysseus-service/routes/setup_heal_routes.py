"""Self-healing setup routes.

During the first-run setup the shell drives the install steps. When a step
fails, the shell asks FoulFox to autonomously REPAIR its own code/services
(confined to ``BASE_DIR``, via the existing ``self_repair`` worker) and then
retry the step, so the FIRST install succeeds instead of being a throwaway.
Every detected error and every repair attempt/result is recorded in the
``setup_heal_events`` audit table, which the user can view and download.

Security model
--------------
* Every route is gated by ``require_admin``, which on this single-user appliance
  also accepts the in-process internal token (``X-Odysseus-Internal-Token``)
  that the api-server injects on the user's behalf. The browser never holds it.
* The browser/model can only pick a ``check_key`` from a SERVER-SIDE whitelist;
  it can NEVER supply a raw shell ``check_command``. The model therefore can
  never choose what gets executed to "verify" a repair.
* ``self_repair_authorized`` is set True ONLY here, on the trusted server path —
  never from a model tool-arg, so the model cannot self-authorize editing
  FoulFox's own code.
* Repairs are confined to ``BASE_DIR`` by the self_repair worker — FoulFox's own
  tree, never the host kernel/binaries.
"""

from __future__ import annotations

import json
import logging
import re
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import APIRouter, Depends, Form, Query, Request
from fastapi.responses import JSONResponse, Response

from core.database import SessionLocal, SetupHealEvent
from core.middleware import require_admin

logger = logging.getLogger(__name__)

# Server-side whitelist: the shell sends only a ``check_key``; we map it to a
# fixed, trusted verification command the self_repair worker runs (in BASE_DIR)
# AFTER it edits FoulFox's own code. Unknown/missing keys fall back to a cheap
# syntax check, so a repair can never run an attacker/model-chosen command.
_SYNTAX_CHECK = "python -m compileall -q app.py src routes core"
CHECK_COMMANDS = {
    "syntax": _SYNTAX_CHECK,
    "service-import": _SYNTAX_CHECK,
    "subagents": "DATABASE_URL='sqlite:///:memory:' python -m pytest tests/test_subagents.py -q",
    "agent-kb": "DATABASE_URL='sqlite:///:memory:' python -m pytest tests/test_agent_kb.py -q",
    "model-routes": "DATABASE_URL='sqlite:///:memory:' python -m pytest tests/test_model_routes.py -q",
}
DEFAULT_CHECK_KEY = "syntax"

# Event types the shell may record directly (repair_started/finished are written
# by the repair route itself).
_RECORDABLE_EVENTS = {
    "error_detected", "retry_started", "step_success", "step_failed", "info",
}

# Hard cap on repair attempts per correlation id (defense in depth; the shell
# also caps retries client-side).
MAX_ATTEMPTS = 3

_SECRET_PATTERNS = [
    re.compile(r"(?i)(authorization\s*:\s*bearer\s+)[A-Za-z0-9._\-]+"),
    re.compile(r"(?i)(api[_-]?key\"?\s*[:=]\s*\"?)[A-Za-z0-9._\-]{6,}"),
    re.compile(r"(?i)(\"?(?:secret|token|password)\"?\s*[:=]\s*\"?)[A-Za-z0-9._\-]{8,}"),
    re.compile(r"(sk-[A-Za-z0-9]{8,})"),
]


def _redact(text: Optional[str]) -> Optional[str]:
    """Strip bearer tokens / api keys / secrets before persisting any text."""
    if not text:
        return text
    out = str(text)
    for pat in _SECRET_PATTERNS:
        out = pat.sub(lambda m: (m.group(1) if m.lastindex else "") + "[REDACTED]", out)
    return out[:8000]


def _redact_obj(obj: Any) -> Any:
    try:
        return json.loads(_redact(json.dumps(obj)) or "null")
    except Exception:
        return None


def _record(db, **fields) -> SetupHealEvent:
    for k in ("objective", "error_message", "check_tail"):
        if k in fields:
            fields[k] = _redact(fields.get(k))
    for k in ("repair_json", "context_json"):
        if fields.get(k) is not None:
            fields[k] = _redact_obj(fields.get(k))
    row = SetupHealEvent(**fields)
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def setup_setup_heal_routes() -> APIRouter:
    router = APIRouter()

    @router.post("/api/setup-heal/event")
    def record_event(
        request: Request,
        event_type: str = Form(...),
        step: str = Form(""),
        operation: str = Form(""),
        severity: str = Form("info"),
        attempt_no: int = Form(0),
        correlation_id: str = Form(""),
        error_message: str = Form(""),
        context_json: str = Form(""),
        _: None = Depends(require_admin),
    ):
        if event_type not in _RECORDABLE_EVENTS:
            return JSONResponse(
                {"error": f"unsupported event_type '{event_type}'"}, status_code=400
            )
        try:
            ctx = json.loads(context_json) if context_json else None
        except (ValueError, TypeError):
            ctx = {"raw": context_json[:2000]}
        db = SessionLocal()
        try:
            row = _record(
                db,
                event_type=event_type,
                step=step or None,
                operation=operation or None,
                severity=severity or "info",
                attempt_no=attempt_no or 0,
                correlation_id=correlation_id or None,
                error_message=error_message or None,
                context_json=ctx,
                source_service="shell",
            )
            return {"ok": True, "id": row.id}
        finally:
            db.close()

    @router.post("/api/setup-heal/repair")
    async def repair(
        request: Request,
        objective: str = Form(...),
        step: str = Form(""),
        operation: str = Form(""),
        check_key: str = Form(DEFAULT_CHECK_KEY),
        correlation_id: str = Form(""),
        attempt_no: int = Form(1),
        error_message: str = Form(""),
        context_json: str = Form(""),
        _: None = Depends(require_admin),
    ):
        # The browser supplies only a key; the command is resolved server-side.
        check_command = CHECK_COMMANDS.get(check_key) or CHECK_COMMANDS[DEFAULT_CHECK_KEY]
        try:
            ctx_extra = json.loads(context_json) if context_json else {}
        except (ValueError, TypeError):
            ctx_extra = {}

        db = SessionLocal()
        try:
            if correlation_id:
                prior = (
                    db.query(SetupHealEvent)
                    .filter(
                        SetupHealEvent.correlation_id == correlation_id,
                        SetupHealEvent.event_type == "repair_started",
                    )
                    .count()
                )
                if prior >= MAX_ATTEMPTS:
                    _record(
                        db,
                        event_type="repair_finished",
                        step=step or None,
                        operation=operation or None,
                        severity="error",
                        attempt_no=attempt_no or 0,
                        correlation_id=correlation_id or None,
                        objective=objective,
                        check_key=check_key,
                        check_command=check_command,
                        repair_status="skipped",
                        checks_pass=False,
                        error_message=f"attempt cap ({MAX_ATTEMPTS}) reached for this step",
                    )
                    return JSONResponse(
                        {"ok": False, "repair": {"status": "skipped", "reason": "attempt-cap"}},
                        status_code=429,
                    )

            _record(
                db,
                event_type="repair_started",
                step=step or None,
                operation=operation or None,
                severity="warning",
                attempt_no=attempt_no or 1,
                correlation_id=correlation_id or None,
                objective=objective,
                check_key=check_key,
                check_command=check_command,
                error_message=error_message or None,
                context_json=ctx_extra or None,
            )
        finally:
            db.close()

        # TRUSTED self-repair context. ``self_repair_authorized`` is set True
        # only here, on the internal-token-gated server path — never from a model
        # tool-arg. depth=0 lets the worker run; handle_self_repair pins
        # workspace=BASE_DIR itself, and _resolve_endpoint falls back to the
        # configured utility-model chain when no explicit endpoint is in ctx.
        agent_ctx = {"self_repair_authorized": True, "depth": 0}
        content = json.dumps(
            {"objective": objective, "check_command": check_command, "restart": False}
        )

        try:
            from src.subagents import handle_self_repair

            repair_result = await handle_self_repair(content, agent_ctx=agent_ctx)
        except Exception as e:  # honest failure — record it
            logger.exception("setup-heal repair crashed")
            repair_result = {"status": "error", "error": str(e)}

        rj = repair_result if isinstance(repair_result, dict) else {"status": "error", "raw": str(repair_result)}
        inner = rj.get("repair") if isinstance(rj.get("repair"), dict) else rj
        checks_pass = bool(inner.get("checks_pass"))
        status = inner.get("status") or rj.get("status") or "error"
        exit_code = inner.get("check_exit_code")
        check_tail = inner.get("check_tail") or inner.get("output")
        err_msg = inner.get("error") or rj.get("error")

        db = SessionLocal()
        try:
            _record(
                db,
                event_type="repair_finished",
                step=step or None,
                operation=operation or None,
                severity="info" if checks_pass else "error",
                attempt_no=attempt_no or 1,
                correlation_id=correlation_id or None,
                objective=objective,
                check_key=check_key,
                check_command=check_command,
                repair_status=str(status),
                checks_pass=checks_pass,
                check_exit_code=exit_code if isinstance(exit_code, int) else None,
                check_tail=check_tail if isinstance(check_tail, str) else None,
                error_message=err_msg if isinstance(err_msg, str) else None,
                repair_json=rj,
            )
        finally:
            db.close()

        return {
            "ok": checks_pass,
            "repair": {
                "status": status,
                "checks_pass": checks_pass,
                "check_exit_code": exit_code if isinstance(exit_code, int) else None,
                "error": err_msg if isinstance(err_msg, str) else None,
            },
        }

    @router.get("/api/setup-heal/events")
    def list_events(
        request: Request,
        limit: int = Query(200, ge=1, le=2000),
        correlation_id: str = Query(""),
        _: None = Depends(require_admin),
    ):
        db = SessionLocal()
        try:
            q = db.query(SetupHealEvent)
            if correlation_id:
                q = q.filter(SetupHealEvent.correlation_id == correlation_id)
            rows = q.order_by(SetupHealEvent.id.desc()).limit(limit).all()
            return {"events": [r.to_dict() for r in rows], "count": len(rows)}
        finally:
            db.close()

    @router.get("/api/setup-heal/events/download")
    def download_events(request: Request, _: None = Depends(require_admin)):
        db = SessionLocal()
        try:
            rows = db.query(SetupHealEvent).order_by(SetupHealEvent.id.asc()).all()
            payload = {
                "service": "foulfox-setup-heal",
                "generated_at": datetime.now(timezone.utc).isoformat(),
                "count": len(rows),
                "events": [r.to_dict() for r in rows],
            }
            body = json.dumps(payload, indent=2)
            return Response(
                content=body,
                media_type="application/json",
                headers={
                    "Content-Disposition": 'attachment; filename="foulfox-setup-heal-log.json"'
                },
            )
        finally:
            db.close()

    return router

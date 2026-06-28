"""Tests for the self-healing setup routes (routes/setup_heal_routes.py).

Covers the security-critical behaviors: the browser/model can only pick a
``check_key`` from a server-side whitelist (never a raw command),
``self_repair_authorized`` is set on the trusted server path, secrets are
redacted before persistence, every error + repair is recorded, and repairs are
attempt-capped per correlation id.

The heavy ``src.subagents`` module is replaced with a lightweight stub so the
route's autonomous-repair contract can be exercised without a model/KVM.
"""

import sys
import tempfile
import types

# Stub src.subagents BEFORE the router imports it (the route does a lazy
# ``from src.subagents import handle_self_repair`` at call time).
_CALLS: list = []
_RESULT: dict = {
    "value": {
        "output": "ok",
        "exit_code": 0,
        "repair": {
            "status": "ok",
            "checks_pass": True,
            "check_exit_code": 0,
            "check_tail": "1 passed",
        },
    }
}


async def _fake_handle_self_repair(content, *, agent_ctx=None, **_kw):
    import json as _json

    _CALLS.append({"content": _json.loads(content), "ctx": agent_ctx})
    return _RESULT["value"]


_stub = types.ModuleType("src.subagents")
_stub.handle_self_repair = _fake_handle_self_repair  # type: ignore[attr-defined]
sys.modules["src.subagents"] = _stub

import pytest  # noqa: E402
from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import create_engine  # noqa: E402
from sqlalchemy.orm import sessionmaker  # noqa: E402
from sqlalchemy.pool import NullPool  # noqa: E402

import core.database as cdb  # noqa: E402
import routes.setup_heal_routes as heal  # noqa: E402
from core.middleware import require_admin  # noqa: E402
from routes.setup_heal_routes import (  # noqa: E402
    CHECK_COMMANDS,
    DEFAULT_CHECK_KEY,
    MAX_ATTEMPTS,
    _redact,
    setup_setup_heal_routes,
)

# Real temp-file DB with NullPool (in-memory sqlite is per-connection and would
# not survive the route's separate SessionLocal() calls). Mirrors the engine
# pattern in test_agent_kb.py.
_TMPDB = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_ENGINE = create_engine(
    f"sqlite:///{_TMPDB.name}",
    connect_args={"check_same_thread": False},
    poolclass=NullPool,
)
cdb.Base.metadata.create_all(_ENGINE)
_TS = sessionmaker(bind=_ENGINE, autoflush=False, autocommit=False)


@pytest.fixture(autouse=True)
def _isolated_db(monkeypatch):
    # Point the route's SessionLocal at the temp DB and start each test clean.
    monkeypatch.setattr(heal, "SessionLocal", _TS)
    s = _TS()
    try:
        s.query(cdb.SetupHealEvent).delete()
        s.commit()
    finally:
        s.close()
    yield


@pytest.fixture
def client():
    _CALLS.clear()
    _RESULT["value"] = {
        "output": "ok",
        "exit_code": 0,
        "repair": {
            "status": "ok",
            "checks_pass": True,
            "check_exit_code": 0,
            "check_tail": "1 passed",
        },
    }
    app = FastAPI()
    app.include_router(setup_setup_heal_routes())
    # Bypass the admin gate for the authorized-path tests (the gate itself is
    # enforced upstream by the api-server X-Shell-Token + require_admin).
    app.dependency_overrides[require_admin] = lambda: None
    return TestClient(app)


def _events(client, **params):
    r = client.get("/api/setup-heal/events", params=params or None)
    assert r.status_code == 200, r.text
    return r.json()["events"]


def test_record_event_persists_and_lists(client):
    r = client.post(
        "/api/setup-heal/event",
        data={"event_type": "error_detected", "step": "ai-online", "error_message": "boom"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["ok"] is True
    evs = _events(client, correlation_id="")
    assert any(e["event_type"] == "error_detected" and e["step"] == "ai-online" for e in evs)


def test_unsupported_event_type_rejected(client):
    r = client.post("/api/setup-heal/event", data={"event_type": "repair_started"})
    assert r.status_code == 400


def test_unknown_check_key_falls_back_to_syntax(client):
    r = client.post(
        "/api/setup-heal/repair",
        data={"objective": "fix it", "check_key": "totally-bogus", "correlation_id": "c1"},
    )
    assert r.status_code == 200, r.text
    # The resolved command is the safe syntax check, never the model's choosing.
    assert _CALLS[-1]["content"]["check_command"] == CHECK_COMMANDS[DEFAULT_CHECK_KEY]
    started = [e for e in _events(client, correlation_id="c1") if e["event_type"] == "repair_started"]
    assert started and started[0]["check_command"] == CHECK_COMMANDS[DEFAULT_CHECK_KEY]


def test_whitelisted_check_key_maps_command(client):
    r = client.post(
        "/api/setup-heal/repair",
        data={"objective": "fix subagents", "check_key": "subagents", "correlation_id": "c2"},
    )
    assert r.status_code == 200, r.text
    assert _CALLS[-1]["content"]["check_command"] == CHECK_COMMANDS["subagents"]


def test_repair_sets_authorized_and_records_outcome(client):
    r = client.post(
        "/api/setup-heal/repair",
        data={"objective": "repair the service", "check_key": "syntax", "correlation_id": "c3"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True and body["repair"]["checks_pass"] is True
    # self_repair_authorized must be set True ONLY on this trusted server path.
    assert _CALLS[-1]["ctx"]["self_repair_authorized"] is True
    assert _CALLS[-1]["ctx"].get("depth") == 0
    types_seen = [e["event_type"] for e in _events(client, correlation_id="c3")]
    assert "repair_started" in types_seen and "repair_finished" in types_seen
    finished = [e for e in _events(client, correlation_id="c3") if e["event_type"] == "repair_finished"][0]
    assert finished["checks_pass"] is True and finished["repair_status"] == "ok"


def test_repair_records_failure_when_checks_fail(client):
    _RESULT["value"] = {
        "output": "nope",
        "exit_code": 1,
        "repair": {"status": "checks_failed", "checks_pass": False, "check_exit_code": 1, "check_tail": "1 failed"},
    }
    r = client.post(
        "/api/setup-heal/repair",
        data={"objective": "won't fix", "check_key": "syntax", "correlation_id": "c4"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["ok"] is False
    finished = [e for e in _events(client, correlation_id="c4") if e["event_type"] == "repair_finished"][0]
    assert finished["checks_pass"] is False and finished["repair_status"] == "checks_failed"


def test_repair_attempt_capped_per_correlation(client):
    for _ in range(MAX_ATTEMPTS):
        r = client.post(
            "/api/setup-heal/repair",
            data={"objective": "loop", "check_key": "syntax", "correlation_id": "cap"},
        )
        assert r.status_code == 200, r.text
    capped = client.post(
        "/api/setup-heal/repair",
        data={"objective": "loop", "check_key": "syntax", "correlation_id": "cap"},
    )
    assert capped.status_code == 429
    assert capped.json()["repair"]["status"] == "skipped"


def test_secrets_redacted_before_persistence(client):
    secret = "Authorization: Bearer sk-supersecretvalue1234567890"
    r = client.post(
        "/api/setup-heal/event",
        data={"event_type": "error_detected", "step": "ai-online", "error_message": secret},
    )
    assert r.status_code == 200, r.text
    evs = _events(client)
    blob = "".join((e.get("error_message") or "") for e in evs)
    assert "supersecretvalue" not in blob
    assert "[REDACTED]" in blob


def test_redact_helper_strips_common_secret_shapes():
    assert "[REDACTED]" in (_redact("api_key=abcdef123456") or "")
    assert "[REDACTED]" in (_redact("token: aaaaaaaaaaaaaaaa") or "")
    assert _redact("") == ""
    assert _redact(None) is None


def test_download_returns_attachment(client):
    client.post("/api/setup-heal/event", data={"event_type": "step_success", "step": "ai-online"})
    r = client.get("/api/setup-heal/events/download")
    assert r.status_code == 200, r.text
    assert "attachment" in r.headers.get("content-disposition", "")
    payload = r.json()
    assert payload["service"] == "foulfox-setup-heal"
    assert isinstance(payload["events"], list)

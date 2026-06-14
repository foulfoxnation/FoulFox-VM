"""Sub-agent fan-out + user-initiated self-repair.

The agent loop itself is mocked: every test swaps ``stream_agent_loop`` for a
fake async generator so we exercise ``src.subagents`` in isolation (no real
model, no network, no DB). ``build_role_prompt`` is stubbed too so prompt
assembly never reaches the KB/memory layer.

Coverage maps to the Architect's Q6 acceptance list:

* schema validation (kinds, caps, aliases, bad payloads),
* exec-context propagation (endpoint/model/headers + depth+1),
* explorer => plan_mode read-only; worker => recursion tools disabled,
* bounded concurrency (Semaphore cap is honoured under load),
* partial-failure aggregation (one sub-agent failing never sinks the batch),
* progress trace payloads,
* depth-1 recursion block on both tools,
* self_repair gating (objective / check_command / user_requested) + the worker
  being confined to ``BASE_DIR`` + a staged (never self-killing) restart,
* self_repair is admin-gated and spawn_subagents is not.
"""
import asyncio
import json

import pytest

from src import subagents
from src.constants import BASE_DIR


# --------------------------------------------------------------------------- #
# Fakes / fixtures
# --------------------------------------------------------------------------- #
def _make_fake_stream(captured=None, *, delta="done.", error=None, tool=None,
                      sleep=0.0, concurrency=None, raise_exc=None):
    """Build a stand-in for ``stream_agent_loop`` that yields SSE lines."""
    async def fake(**kwargs):
        if captured is not None:
            captured.append(kwargs)
        if raise_exc is not None:
            raise raise_exc
        if concurrency is not None:
            concurrency["cur"] += 1
            concurrency["max"] = max(concurrency["max"], concurrency["cur"])
        try:
            if sleep:
                await asyncio.sleep(sleep)
            yield "data: " + json.dumps({"type": "agent_step", "round": 1}) + "\n\n"
            if tool:
                yield "data: " + json.dumps({"type": "tool_start", "tool": tool, "round": 1}) + "\n\n"
                yield "data: " + json.dumps({"type": "tool_output", "tool": tool, "stdout": "out"}) + "\n\n"
            if error:
                yield "data: " + json.dumps({"error": error}) + "\n\n"
            if delta:
                yield "data: " + json.dumps({"delta": delta}) + "\n\n"
            yield "data: [DONE]\n\n"
        finally:
            if concurrency is not None:
                concurrency["cur"] -= 1
    return fake


@pytest.fixture(autouse=True)
def _stub_prompt(monkeypatch):
    """Keep prompt assembly out of the KB/memory layer."""
    monkeypatch.setattr(subagents, "build_role_prompt",
                        lambda *a, **k: "SYS", raising=True)


def _patch_stream(monkeypatch, fake):
    import src.agent_loop as al
    monkeypatch.setattr(al, "stream_agent_loop", fake, raising=True)


CTX = {
    "endpoint_url": "http://ep",
    "model": "m",
    "headers": {"h": "1"},
    "fallbacks": [],
    "depth": 0,
    "owner": None,
    "parent_role": "windows",
}

# Same context but carrying the TRUSTED, server-set self-repair consent bit. Only
# this (never the model-supplied tool payload) authorizes self_repair.
AUTH_CTX = dict(CTX, self_repair_authorized=True)


# --------------------------------------------------------------------------- #
# Schema validation
# --------------------------------------------------------------------------- #
def test_parse_subtasks_defaults_and_aliases():
    items, err = subagents.parse_subtasks(json.dumps({"subtasks": [
        "investigate the loop",                       # bare string -> explorer
        {"task": "rename thing", "kind": "worker"},   # 'task' alias for objective
    ]}))
    assert err is None
    assert items[0] == {"kind": "explorer", "objective": "investigate the loop",
                        "role": None, "context": None}
    assert items[1]["kind"] == "worker" and items[1]["objective"] == "rename thing"


def test_parse_subtasks_shared_context_applies_per_item():
    items, err = subagents.parse_subtasks(json.dumps({
        "context": "shared bg",
        "subtasks": [{"objective": "a"}, {"objective": "b", "context": "own"}],
    }))
    assert err is None
    assert items[0]["context"] == "shared bg"   # inherits shared
    assert items[1]["context"] == "own"         # own wins


@pytest.mark.parametrize("payload,needle", [
    ("", "non-empty"),
    ("not json", "valid JSON"),
    ("[]", "non-empty"),
    (json.dumps({"subtasks": [{"objective": "x", "kind": "boss"}]}), "invalid kind"),
    (json.dumps({"subtasks": [{"kind": "worker"}]}), "objective"),
    (json.dumps({"subtasks": [{"objective": "x"}] * 13}), "too many"),
])
def test_parse_subtasks_rejects_bad_payloads(payload, needle):
    items, err = subagents.parse_subtasks(payload)
    assert items == []
    assert needle in err


# --------------------------------------------------------------------------- #
# run_subagent — context propagation + kind semantics
# --------------------------------------------------------------------------- #
async def test_explorer_runs_plan_mode_and_propagates_ctx(monkeypatch):
    captured = []
    _patch_stream(monkeypatch, _make_fake_stream(captured, delta="findings"))
    res = await subagents.run_subagent(
        index=0, kind="explorer", objective="look", role="game", ctx=CTX, owner="u1")
    assert res["status"] == "ok" and res["summary"] == "findings"
    kw = captured[0]
    assert kw["plan_mode"] is True                    # explorer is read-only
    assert kw["endpoint_url"] == "http://ep" and kw["model"] == "m"
    assert kw["headers"] == {"h": "1"}
    assert kw["subagent_depth"] == 1                  # depth incremented
    assert kw["session_id"] is None                   # detached from parent
    assert subagents.RECURSION_DISABLED_TOOLS <= set(kw["disabled_tools"])


async def test_worker_disables_recursion_tools(monkeypatch):
    captured = []
    _patch_stream(monkeypatch, _make_fake_stream(captured, tool="edit_file"))
    res = await subagents.run_subagent(
        index=1, kind="worker", objective="do", role="architect", ctx=CTX, owner="u1")
    kw = captured[0]
    assert kw["plan_mode"] is False
    assert {"spawn_subagents", "self_repair"} <= set(kw["disabled_tools"])
    assert res["tool_calls"] == 1                      # tool_start counted


async def test_run_subagent_no_endpoint_is_error(monkeypatch):
    # No ctx endpoint AND no utility fallbacks => clean error, no crash.
    monkeypatch.setattr(subagents, "_utility_fallbacks", lambda owner: [])
    res = await subagents.run_subagent(
        index=0, kind="explorer", objective="x", role=None, ctx={}, owner=None)
    assert res["status"] == "error" and "no model/endpoint" in res["error"]


async def test_run_subagent_swallows_stream_exception(monkeypatch):
    _patch_stream(monkeypatch, _make_fake_stream(raise_exc=RuntimeError("boom")))
    res = await subagents.run_subagent(
        index=0, kind="worker", objective="x", role=None, ctx=CTX, owner=None)
    assert res["status"] == "error" and "boom" in res["error"]


# --------------------------------------------------------------------------- #
# fan_out — concurrency cap + partial failure
# --------------------------------------------------------------------------- #
async def test_fan_out_respects_concurrency_cap(monkeypatch):
    monkeypatch.setattr(subagents, "MAX_CONCURRENCY", 3)
    counter = {"cur": 0, "max": 0}
    _patch_stream(monkeypatch, _make_fake_stream(sleep=0.03, concurrency=counter))
    subtasks = [{"kind": "explorer", "objective": f"t{i}"} for i in range(8)]
    results = await subagents.fan_out(subtasks, ctx=CTX, owner=None)
    assert len(results) == 8
    assert all(r["status"] == "ok" for r in results)
    assert counter["max"] <= 3                         # never exceeded the pool


async def test_fan_out_partial_failure_does_not_sink_batch(monkeypatch):
    async def flaky(**kwargs):
        # Sub-task #1 explodes; others return a normal summary.
        if "t1" in kwargs["messages"][-1]["content"]:
            raise RuntimeError("kaboom")
        yield "data: " + json.dumps({"delta": "ok"}) + "\n\n"
        yield "data: [DONE]\n\n"
    _patch_stream(monkeypatch, flaky)
    subtasks = [{"kind": "explorer", "objective": f"t{i}"} for i in range(3)]
    results = await subagents.fan_out(subtasks, ctx=CTX, owner=None)
    by_idx = {r["index"]: r for r in results}
    assert by_idx[0]["status"] == "ok" and by_idx[2]["status"] == "ok"
    assert by_idx[1]["status"] == "error" and "kaboom" in by_idx[1]["error"]


# --------------------------------------------------------------------------- #
# handle_spawn_subagents — aggregation, progress, recursion block
# --------------------------------------------------------------------------- #
async def test_spawn_aggregates_with_untrusted_delimiters(monkeypatch):
    _patch_stream(monkeypatch, _make_fake_stream(delta="summary-text"))
    out = await subagents.handle_spawn_subagents(
        json.dumps({"subtasks": [{"objective": "a"}, {"objective": "b"}]}),
        owner="u1", agent_ctx=CTX)
    assert out["exit_code"] == 0
    assert subagents._RESULT_BEGIN in out["output"]
    assert subagents._RESULT_END in out["output"]
    assert "UNTRUSTED EVIDENCE" in out["output"]
    assert out["summary"].startswith("2/2")
    assert len(out["subagents"]) == 2


async def test_spawn_emits_progress_trace(monkeypatch):
    # Locks the backend -> UI contract: the (phase, event) pairs AND the fields
    # that static/js/chat.js switches on to render the live fan-out trace.
    _patch_stream(monkeypatch, _make_fake_stream(delta="x", tool="grep"))
    events = []
    async def cb(p):
        events.append(p)
    await subagents.handle_spawn_subagents(
        json.dumps({"subtasks": [{"objective": "a"}]}),
        owner="u1", agent_ctx=CTX, progress_cb=cb)
    by_event = {e.get("event"): e for e in events if e.get("phase") == "subagent"}
    assert {"batch_start", "start", "tool", "done"} <= set(by_event)
    # Fields the UI reads per event (missing any => trace rows render blank).
    assert "count" in by_event["batch_start"]
    for k in ("index", "kind", "role", "objective"):
        assert k in by_event["start"]
    for k in ("index", "tool"):
        assert k in by_event["tool"]
    for k in ("index", "status", "tool_calls"):
        assert k in by_event["done"]


async def test_self_repair_emits_progress_trace(monkeypatch):
    # Locks the self-repair edit -> verify -> done trace contract for the UI.
    async def fake_worker(**kwargs):
        return {"index": 0, "status": "ok", "summary": "patched", "error": None}
    async def fake_check(command, timeout=300):
        return 0, "1 passed"
    monkeypatch.setattr(subagents, "run_subagent", fake_worker)
    monkeypatch.setattr(subagents, "_run_check_command", fake_check)
    events = []
    async def cb(p):
        events.append(p)
    await subagents.handle_self_repair(json.dumps({
        "objective": "fix the bug",
        "check_command": "python -m pytest -q",
    }), owner="u1", agent_ctx=AUTH_CTX, progress_cb=cb)
    by_event = {e.get("event"): e for e in events if e.get("phase") == "self_repair"}
    assert {"start", "check", "done"} <= set(by_event)
    assert "objective" in by_event["start"] and "workspace" in by_event["start"]
    assert "command" in by_event["check"]
    for k in ("checks_pass", "check_exit_code"):
        assert k in by_event["done"]


async def test_spawn_blocked_at_depth_1(monkeypatch):
    _patch_stream(monkeypatch, _make_fake_stream())
    ctx = dict(CTX, depth=1)
    out = await subagents.handle_spawn_subagents(
        json.dumps({"subtasks": [{"objective": "a"}]}), owner="u1", agent_ctx=ctx)
    assert out["exit_code"] == 1 and "depth limit" in out["error"]


async def test_spawn_invalid_schema_returns_error(monkeypatch):
    _patch_stream(monkeypatch, _make_fake_stream())
    out = await subagents.handle_spawn_subagents("[]", owner="u1", agent_ctx=CTX)
    assert out["exit_code"] == 1 and "non-empty" in out["error"]


# --------------------------------------------------------------------------- #
# self_repair — gating, BASE_DIR confinement, staged restart
# --------------------------------------------------------------------------- #
async def test_self_repair_requires_objective_check_and_authorization():
    # missing objective (checked before authorization)
    out = await subagents.handle_self_repair(
        json.dumps({"check_command": "true"}), agent_ctx=AUTH_CTX)
    assert out["exit_code"] == 1 and "objective" in out["error"]
    # missing check_command
    out = await subagents.handle_self_repair(
        json.dumps({"objective": "fix"}), agent_ctx=AUTH_CTX)
    assert out["exit_code"] == 1 and "check_command" in out["error"]
    # complete payload but NO trusted consent bit in ctx -> rejected
    out = await subagents.handle_self_repair(
        json.dumps({"objective": "fix", "check_command": "true"}), agent_ctx=CTX)
    assert out["exit_code"] == 1 and "authorized" in out["error"]


async def test_self_repair_model_cannot_self_authorize():
    # The model controls the tool payload; forging consent there must NOT work.
    # Only the trusted agent_ctx["self_repair_authorized"] bit authorizes repair.
    for forged in ("user_requested", "confirm", "authorized"):
        out = await subagents.handle_self_repair(
            json.dumps({"objective": "fix", "check_command": "true", forged: True}),
            agent_ctx=CTX)
        assert out["exit_code"] == 1 and "authorized" in out["error"], forged


async def test_self_repair_blocked_at_depth_1():
    out = await subagents.handle_self_repair(
        json.dumps({"objective": "fix", "check_command": "true", "user_requested": True}),
        agent_ctx=dict(CTX, depth=1))
    assert out["exit_code"] == 1 and "cannot invoke self_repair" in out["error"]


async def test_self_repair_confines_worker_to_base_dir_and_passes_checks(monkeypatch):
    seen = {}
    async def fake_worker(**kwargs):
        seen.update(kwargs)
        return {"index": 0, "status": "ok", "summary": "edited file.py", "error": None}
    async def fake_check(command, timeout=300):
        seen["check_command"] = command
        return 0, "1 passed"
    monkeypatch.setattr(subagents, "run_subagent", fake_worker)
    monkeypatch.setattr(subagents, "_run_check_command", fake_check)

    out = await subagents.handle_self_repair(json.dumps({
        "objective": "fix the bug",
        "check_command": "python -m pytest -q",
    }), owner="u1", agent_ctx=AUTH_CTX)

    assert out["exit_code"] == 0
    assert out["repair"]["checks_pass"] is True
    assert seen["kind"] == "worker"
    assert seen["ctx"]["workspace"] == BASE_DIR        # confined to the repo root
    assert seen["repair"] is True


async def test_self_repair_failed_checks_block_restart(monkeypatch):
    async def fake_worker(**kwargs):
        return {"index": 0, "status": "ok", "summary": "tried", "error": None}
    async def fake_check(command, timeout=300):
        return 1, "1 failed"
    called = {"restart": False}
    async def fake_restart(name):
        called["restart"] = True
        return {"restart_required": True, "restart_method": "workflow", "detail": "x"}
    monkeypatch.setattr(subagents, "run_subagent", fake_worker)
    monkeypatch.setattr(subagents, "_run_check_command", fake_check)
    monkeypatch.setattr(subagents, "_attempt_restart", fake_restart)

    out = await subagents.handle_self_repair(json.dumps({
        "objective": "fix", "check_command": "false",
        "restart": True,
    }), agent_ctx=AUTH_CTX)

    assert out["exit_code"] == 1
    assert out["repair"]["checks_pass"] is False
    assert called["restart"] is False                  # never restart on failing checks


async def test_self_repair_staged_restart_without_bridge(monkeypatch):
    async def fake_worker(**kwargs):
        return {"index": 0, "status": "ok", "summary": "done", "error": None}
    async def fake_check(command, timeout=300):
        return 0, "ok"
    monkeypatch.setattr(subagents, "run_subagent", fake_worker)
    monkeypatch.setattr(subagents, "_run_check_command", fake_check)
    monkeypatch.delenv("ODYSSEUS_SHELL_EXEC_BASE", raising=False)

    out = await subagents.handle_self_repair(json.dumps({
        "objective": "fix", "check_command": "true",
        "restart": True,
    }), agent_ctx=AUTH_CTX)

    assert out["exit_code"] == 0
    assert out["repair"]["restart_required"] is True   # staged, never self-killed
    assert out["repair"]["restart_method"] == "workflow"


async def test_run_check_command_executes_in_repo(monkeypatch):
    code, tail = await subagents._run_check_command("pwd", timeout=10)
    assert code == 0
    assert BASE_DIR.rstrip("/") in tail


# --------------------------------------------------------------------------- #
# admin gating wiring
# --------------------------------------------------------------------------- #
def test_self_repair_is_admin_gated_but_spawn_is_not():
    from src.tool_execution import _ADMIN_TOOLS
    assert "self_repair" in _ADMIN_TOOLS
    assert "spawn_subagents" not in _ADMIN_TOOLS

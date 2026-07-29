"""MTM (Multi-Task Memory) REST + SSE API.

Endpoints:
  GET  /api/mtm/tasks              — list tasks (query: status, kind, limit, parent_id)
  GET  /api/mtm/tasks/{id}         — get one task with full findings
  DELETE /api/mtm/tasks/{id}       — cancel/remove a task
  GET  /api/mtm/memory             — read shared scratchpad (query: prefix)
  POST /api/mtm/memory             — write a key-value entry to shared memory
  DELETE /api/mtm/memory           — clear all shared memory entries
  GET  /api/mtm/context            — build the agent context summary block
  GET  /api/mtm/stream             — SSE stream (task_created | task_updated | memory_written)
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Optional

from fastapi import APIRouter, Query, Request
from fastapi.responses import JSONResponse, StreamingResponse

from src.mtm import mtm

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/mtm", tags=["mtm"])


def _setup_mtm_routes() -> APIRouter:
    return router


# ── Task endpoints ─────────────────────────────────────────────────────────────

@router.get("/tasks")
async def list_tasks(
    status: Optional[str] = Query(None),
    kind: Optional[str] = Query(None),
    parent_id: Optional[str] = Query(None),
    limit: int = Query(60, ge=1, le=200),
    top_level: bool = Query(False),
):
    tasks = await mtm.list_tasks(
        status=status, kind=kind, parent_id=parent_id,
        limit=limit, include_children=not top_level,
    )
    return JSONResponse({"tasks": [t.to_dict() for t in tasks]})


@router.get("/tasks/{task_id}")
async def get_task(task_id: str):
    task = await mtm.get_task(task_id)
    if not task:
        return JSONResponse({"error": "Task not found"}, status_code=404)
    return JSONResponse(task.to_dict())


@router.delete("/tasks/{task_id}")
async def cancel_task(task_id: str):
    task = await mtm.update_task(task_id, status="cancelled")
    if not task:
        return JSONResponse({"error": "Task not found"}, status_code=404)
    return JSONResponse({"ok": True, "id": task_id})


# ── Shared memory endpoints ────────────────────────────────────────────────────

@router.get("/memory")
async def read_memory(prefix: Optional[str] = Query(None)):
    mem = await mtm.read_memory(prefix=prefix)
    return JSONResponse({"memory": mem})


@router.post("/memory")
async def write_memory(request: Request):
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"error": "Body must be JSON"}, status_code=400)
    key = str(body.get("key") or "").strip()
    if not key:
        return JSONResponse({"error": "key is required"}, status_code=400)
    value = body.get("value", "")
    written_by = str(body.get("written_by") or "api")
    await mtm.write_memory(key, value, written_by=written_by)
    return JSONResponse({"ok": True, "key": key})


@router.delete("/memory")
async def clear_memory():
    await mtm.clear_memory()
    return JSONResponse({"ok": True})


@router.delete("/memory/{key:path}")
async def delete_memory_key(key: str):
    deleted = await mtm.delete_memory(key)
    if not deleted:
        return JSONResponse({"error": "Key not found"}, status_code=404)
    return JSONResponse({"ok": True, "key": key})


# ── Context summary ────────────────────────────────────────────────────────────

@router.get("/context")
async def get_context(max_chars: int = Query(2500, ge=200, le=10000)):
    block = await mtm.build_context_block(max_chars=max_chars)
    return JSONResponse({"context": block})


# ── SSE stream ─────────────────────────────────────────────────────────────────

@router.get("/stream")
async def sse_stream(request: Request):
    """Server-Sent Events stream for real-time MTM updates.
    Each event is a JSON-encoded payload: type, task/key, ts.
    """
    q = await mtm.subscribe()

    async def generate():
        try:
            # Send a heartbeat immediately so the client knows we're alive.
            snapshot = await mtm.list_tasks(limit=30)
            mem = await mtm.read_memory()
            init = json.dumps({
                "type": "snapshot",
                "tasks": [t.to_dict() for t in snapshot],
                "memory": mem,
            }, ensure_ascii=False)
            yield f"data: {init}\n\n"

            while True:
                if await request.is_disconnected():
                    break
                try:
                    event = await asyncio.wait_for(q.get(), timeout=25.0)
                    yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
                except asyncio.TimeoutError:
                    yield "data: {\"type\":\"ping\"}\n\n"
        except asyncio.CancelledError:
            pass
        finally:
            await mtm.unsubscribe(q)

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )

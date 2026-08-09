"""
FoulFox OS — Bug-fix loop API routes.

GET  /api/bug-loop/status          Current loop state
POST /api/bug-loop/start           Start the autonomous loop
POST /api/bug-loop/stop            Stop the loop
POST /api/bug-loop/report          Run a single diagnostic report (no loop)
POST /api/bug-loop/send            (Re)send the last report to Replit via browser
GET  /api/bug-loop/stream          SSE stream of loop state changes
"""
import asyncio
import json
import time
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, StreamingResponse

from src.bug_loop import get_state, start_loop, stop_loop, run_single_report
from src.host_browser import paste_report_to_replit

router = APIRouter()


@router.get("/api/bug-loop/status")
async def loop_status():
    return JSONResponse(get_state().snap())


@router.post("/api/bug-loop/start")
async def loop_start(request: Request):
    try:
        body = await request.json()
    except Exception:
        body = {}
    replit_url  = body.get("replitUrl", "https://replit.com")
    auto_send   = bool(body.get("autoSend", True))
    max_iters   = int(body.get("maxIterations", 20))
    result = start_loop(replit_url=replit_url, auto_send=auto_send, max_iterations=max_iters)
    return JSONResponse(result)


@router.post("/api/bug-loop/stop")
async def loop_stop():
    return JSONResponse(stop_loop())


@router.post("/api/bug-loop/report")
async def one_report():
    report = await run_single_report()
    return JSONResponse({
        "ok": True,
        "report": {k: v for k, v in report.items() if k not in ("checks", "markdown")},
        "checks": report.get("checks", []),
        "markdown": report.get("markdown", ""),
    })


@router.post("/api/bug-loop/send")
async def send_to_replit(request: Request):
    state = get_state()
    if not state.last_report:
        return JSONResponse(
            {"ok": False, "detail": "No report available — run /api/bug-loop/report first"},
            status_code=400,
        )
    try:
        body = await request.json()
    except Exception:
        body = {}
    replit_url = body.get("replitUrl", state.replit_url)
    result = await paste_report_to_replit(state.last_report["markdown"], replit_url)
    if result["ok"]:
        state.last_sent_at = time.time()
        state.emit(f"Report manually sent to Replit: {result['detail']}")
    return JSONResponse({
        "ok": result["ok"],
        "detail": result["detail"],
        "screenshot": result.get("screenshot"),
    })


@router.get("/api/bug-loop/stream")
async def loop_stream(request: Request):
    state = get_state()
    queue = state.subscribe()

    async def generate():
        snap = state.snap()
        yield f"data: {json.dumps(snap)}\n\n"
        try:
            while True:
                if await request.is_disconnected():
                    break
                try:
                    update = await asyncio.wait_for(queue.get(), timeout=25)
                    yield f"data: {json.dumps(update)}\n\n"
                except asyncio.TimeoutError:
                    yield ": ping\n\n"
        finally:
            state.unsubscribe(queue)

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )

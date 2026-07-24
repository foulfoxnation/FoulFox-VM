"""FoulFox Apps bridge for the sidebar.

The chat UI's sidebar lists installed FoulFox Apps and opens each one as a
full-window overlay. The app registry/runtime lives in the Express api-server,
not in Odysseus — but the frontend's fetch() calls are rewritten by the shell's
proxy shim to land on Odysseus, so Odysseus relays these calls over loopback.

Auth: the api-server's read-only GETs pass with loopback alone; the
state-changing start POST rides the shared cross-service bridge header
(X-Odysseus-Internal-Token), same as the VM bridge.
"""

import os
import re

import httpx
from fastapi import APIRouter, HTTPException

_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")


def _api_base() -> str:
    """Loopback base of the Express api-server (dev and appliance both 8080)."""
    base = (
        os.environ.get("ODYSSEUS_SHELL_EXEC_BASE", "").rstrip("/")
        or os.environ.get("FOULFOX_API_BASE", "").rstrip("/")
    )
    if base:
        return base
    port = os.environ.get("FOULFOX_API_PORT", "8080")
    return f"http://127.0.0.1:{port}"


def _bridge_headers() -> dict:
    from core.middleware import INTERNAL_TOOL_HEADER, INTERNAL_TOOL_TOKEN

    return {INTERNAL_TOOL_HEADER: INTERNAL_TOOL_TOKEN}


def setup_foulfox_app_routes():
    router = APIRouter(prefix="/api/foulfox-apps", tags=["foulfox-apps"])

    @router.get("")
    async def list_apps():
        base = _api_base()
        async with httpx.AsyncClient(timeout=10) as client:
            try:
                r = await client.get(f"{base}/api/apps")
                r.raise_for_status()
                apps = r.json().get("apps", [])
            except Exception as exc:
                raise HTTPException(status_code=502, detail=f"App service unreachable: {exc}")
            ui_base = None
            try:
                rb = await client.get(f"{base}/api/apps/ui-base")
                if rb.status_code == 200:
                    ui_base = rb.json().get("base")
            except Exception:
                ui_base = None
        slim = [
            {
                "id": a.get("id"),
                "name": a.get("name"),
                "description": a.get("description"),
                "icon": a.get("icon"),
                "status": a.get("status"),
                "run": (a.get("run") or None),
                "window": (a.get("manifest") or {}).get("window") or a.get("window"),
            }
            for a in apps
            if isinstance(a, dict)
        ]
        return {"apps": slim, "uiBase": ui_base}

    @router.post("/{app_id}/start")
    async def start_app(app_id: str):
        if not _ID_RE.match(app_id):
            raise HTTPException(status_code=400, detail="Invalid app id.")
        base = _api_base()
        async with httpx.AsyncClient(timeout=30) as client:
            try:
                r = await client.post(
                    f"{base}/api/apps/{app_id}/start", headers=_bridge_headers()
                )
            except Exception as exc:
                raise HTTPException(status_code=502, detail=f"App service unreachable: {exc}")
        if r.status_code >= 400:
            try:
                detail = r.json().get("error") or r.text
            except Exception:
                detail = r.text
            raise HTTPException(status_code=r.status_code, detail=detail)
        return r.json()

    return router

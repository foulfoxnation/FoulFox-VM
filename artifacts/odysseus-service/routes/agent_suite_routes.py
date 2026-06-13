"""Routes for the Odysseus 3-agent suite (Windows / Game / Architect)."""
import logging

from fastapi import APIRouter, Request, Body, HTTPException
from pydantic import BaseModel

from src.auth_helpers import effective_user
from src import agent_suite, agent_suite_orchestrator, project_memory

logger = logging.getLogger(__name__)


class MemoryCreate(BaseModel):
    """Body for POST /api/agent-suite/memory — typed so bad JSON 422s, not 500s."""
    title: str = ""
    content: str = ""
    source: str = "user"
    pinned: bool = False


def setup_agent_suite_routes() -> APIRouter:
    router = APIRouter(prefix="/api/agent-suite", tags=["agent-suite"])

    @router.get("/state")
    def get_state(request: Request):
        """Return the caller's active suite (or null) plus the role catalog."""
        owner = effective_user(request)
        return {
            "suite": agent_suite.get_suite(owner),
            "roles": agent_suite.role_catalog(),
        }

    @router.get("/roles")
    def list_roles(request: Request):
        return {"roles": agent_suite.role_catalog()}

    @router.post("/provision")
    def provision(request: Request, payload: dict = Body(default_factory=dict)):
        """Create or update the 3-agent suite.

        Body: {name?, role_models?: {role: {endpoint_id, model}}, setup_complete?}
        """
        owner = effective_user(request)
        name = (payload.get("name") or "FoulFox VM Suite").strip() or "FoulFox VM Suite"
        role_models = payload.get("role_models") or {}
        mark = bool(payload.get("setup_complete", False))
        suite = agent_suite.provision_suite(
            owner=owner, name=name, role_models=role_models,
            mark_setup_complete=mark,
        )
        return {"suite": suite}

    @router.post("/run")
    async def run_review(request: Request, payload: dict = Body(default_factory=dict)):
        """Run one Architect-gated review loop (P5).

        Body: {objective: str, role: "windows"|"game", max_iterations?: int}.
        Awaited — may be long-running. Role/endpoint/model are resolved
        server-side from the caller's suite; never accepted from the body.
        """
        owner = effective_user(request)
        objective = (payload.get("objective") or "").strip()
        role = (payload.get("role") or "").strip()
        max_iterations = payload.get("max_iterations", 4)
        if not objective:
            raise HTTPException(status_code=400, detail="objective is required")
        if role not in ("windows", "game"):
            raise HTTPException(status_code=400, detail="role must be 'windows' or 'game'")
        try:
            run = await agent_suite_orchestrator.run_review_loop(
                objective, role, owner=owner, max_iterations=max_iterations)
            return {"run": run}
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
        except Exception as e:
            logger.exception("run_review failed")
            raise HTTPException(status_code=500, detail=str(e))

    @router.get("/runs")
    def list_runs(request: Request):
        owner = effective_user(request)
        return {"runs": agent_suite_orchestrator.list_runs(owner)}

    @router.get("/runs/{run_id}")
    def get_run(request: Request, run_id: str):
        owner = effective_user(request)
        run = agent_suite_orchestrator.get_run(run_id, owner)
        if not run:
            raise HTTPException(status_code=404, detail="run not found")
        return {"run": run}

    # ----- Project memory (P8) — persistent, agent-readable/writable notes ----
    @router.get("/memory")
    def list_memory(request: Request, limit: int = 50):
        """List the caller's project-memory entries (pinned first, newest next)."""
        owner = effective_user(request)
        limit = max(1, min(500, limit))
        return {"items": project_memory.list_memory(owner, limit=limit)}

    @router.post("/memory")
    def add_memory(request: Request, payload: MemoryCreate):
        """Create a project-memory entry. Requires title or content."""
        owner = effective_user(request)
        title = (payload.title or "").strip()
        content = (payload.content or "").strip()
        if not title and not content:
            raise HTTPException(status_code=400, detail="title or content is required")
        source = (payload.source or "user").strip() or "user"
        note = project_memory.add_memory(
            owner, title, content, source=source, pinned=bool(payload.pinned))
        return {"note": note}

    @router.delete("/memory/{note_id}")
    def delete_memory(request: Request, note_id: str):
        owner = effective_user(request)
        if not project_memory.delete_memory(owner, note_id):
            raise HTTPException(status_code=404, detail="memory note not found")
        return {"ok": True}

    return router

"""Routes for the agent lessons / guide rails knowledge base."""
import logging

from fastapi import APIRouter, Request, Body, HTTPException

from src.auth_helpers import effective_user
from src import agent_lessons

logger = logging.getLogger(__name__)


def setup_agent_lessons_routes() -> APIRouter:
    router = APIRouter(prefix="/api/agent-lessons", tags=["agent-lessons"])

    @router.get("")
    def list_lessons(request: Request, role: str = "", include_inactive: bool = False):
        owner = effective_user(request)
        return {
            "lessons": agent_lessons.list_lessons(
                role=role or None, owner=owner,
                include_inactive=include_inactive),
            "count": agent_lessons.count_lessons(owner),
        }

    @router.get("/retrieve")
    def retrieve(request: Request, role: str, q: str = "", limit: int = 5):
        owner = effective_user(request)
        if role not in agent_lessons.ROLES:
            raise HTTPException(400, f"invalid role: {role}")
        return {
            "lessons": agent_lessons.retrieve_lessons(
                q, role, owner=owner, limit=max(1, min(limit, 25))),
        }

    @router.post("")
    def add(request: Request, payload: dict = Body(default_factory=dict)):
        owner = effective_user(request)
        role = (payload.get("role") or "").strip()
        text = (payload.get("text") or "").strip()
        if role not in agent_lessons.ROLES:
            raise HTTPException(400, f"invalid role: {role}")
        if not text:
            raise HTTPException(400, "text is required")
        return {"lesson": agent_lessons.add_lesson(
            role=role, text=text, title=(payload.get("title") or "").strip(),
            tags=payload.get("tags") or [],
            source=(payload.get("source") or "manual"), owner=owner)}

    @router.patch("/{lesson_id}")
    def update(request: Request, lesson_id: str,
               payload: dict = Body(default_factory=dict)):
        owner = effective_user(request)
        updated = agent_lessons.update_lesson(lesson_id, owner=owner, **payload)
        if updated is None:
            raise HTTPException(404, "lesson not found")
        return {"lesson": updated}

    @router.delete("/{lesson_id}")
    def delete(request: Request, lesson_id: str):
        owner = effective_user(request)
        if not agent_lessons.delete_lesson(lesson_id, owner=owner):
            raise HTTPException(404, "lesson not found")
        return {"ok": True}

    @router.post("/seed")
    def seed(request: Request, payload: dict = Body(default_factory=dict)):
        owner = effective_user(request)
        created = agent_lessons.seed_lessons(
            owner=owner, force=bool(payload.get("force", False)))
        return {"created": created, "count": agent_lessons.count_lessons(owner)}

    return router

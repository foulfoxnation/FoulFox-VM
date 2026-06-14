"""Shared, role-scoped prompt + endpoint helpers.

Extracted from ``agent_suite_orchestrator`` so both the Architect-gated review
loop AND ad-hoc sub-agents (``src.subagents``) build prompts the same way:
persona (guide rails) + the role's KB lessons + shared project memory. The KB
is consumed only here — lessons/memory internals live in ``agent_lessons`` /
``project_memory``.

Every function is best-effort: a missing crew member, an unprovisioned suite,
or an unavailable KB degrades to a sane default rather than raising into the
caller's request path.
"""
from __future__ import annotations

import logging
from typing import Dict, List, Optional

from src import agent_lessons

logger = logging.getLogger(__name__)

_GENERIC_WORKER_DEFAULT = (
    "You are an autonomous worker agent. Complete the objective using available tools."
)


def role_persona(crew, role: str) -> str:
    """The role's guide-rail persona: the crew member's text when provisioned,
    else the static ``ROLE_DEFS`` default. Empty string for unknown roles."""
    persona = (crew.personality if crew and getattr(crew, "personality", None) else "").strip()
    if not persona:
        try:
            from src.agent_suite import ROLE_DEFS
            rd = ROLE_DEFS.get(role)
            persona = (rd["personality"] if rd else "").strip()
        except Exception as e:  # pragma: no cover - defensive
            logger.debug("role_persona default lookup failed for %s: %s", role, e)
            persona = ""
    return persona


def lessons_block(role: str, owner: Optional[str], objective: str) -> str:
    """Top-N relevant KB lessons for the role, formatted for prompt injection."""
    try:
        lessons = agent_lessons.retrieve_lessons(objective, role, owner=owner, limit=5)
        return agent_lessons.format_lessons_block(lessons) or ""
    except Exception as e:
        logger.debug("lessons block for %s failed: %s", role, e)
        return ""


def memory_block(owner: Optional[str], limit: int = 50, max_chars: int = 4000) -> str:
    """Shared project-memory context, trusted + best-effort. Defaults match the
    Architect's full view; workers/sub-agents pass smaller bounds."""
    try:
        from src import project_memory
        return project_memory.memory_context_block(
            owner, limit=limit, max_chars=max_chars) or ""
    except Exception as e:
        logger.debug("memory block failed: %s", e)
        return ""


def build_role_prompt(
    role: str,
    owner: Optional[str],
    objective: str,
    crew=None,
    mem_limit: int = 12,
    mem_max_chars: int = 1500,
    extra: Optional[str] = None,
    default: str = _GENERIC_WORKER_DEFAULT,
) -> str:
    """Assemble a worker-style system prompt: persona + role lessons + shared
    memory (+ optional extra framing). Each piece is best-effort; an empty
    result falls back to ``default``."""
    parts: List[str] = []
    persona = role_persona(crew, role)
    if persona:
        parts.append(persona)
    block = lessons_block(role, owner, objective)
    if block:
        parts.append(block)
    mem = memory_block(owner, limit=mem_limit, max_chars=mem_max_chars)
    if mem:
        parts.append(mem)
    if extra:
        parts.append(extra.strip())
    return "\n\n".join(p for p in parts if p) or default


def resolve_headers(db, owner: Optional[str], endpoint_url: str) -> Dict:
    """Auth headers for ``endpoint_url`` resolved from the owner's enabled
    endpoints. Empty dict when nothing matches (best-effort)."""
    headers: Dict = {}
    if not endpoint_url:
        return headers
    try:
        from core.database import ModelEndpoint
        from src.endpoint_resolver import normalize_base, build_headers
        from src.auth_helpers import owner_filter
        ep_q = db.query(ModelEndpoint).filter(ModelEndpoint.is_enabled == True)  # noqa: E712
        ep_q = owner_filter(ep_q, ModelEndpoint, owner or None)
        for ep in ep_q.all():
            nb = normalize_base(ep.base_url)
            if nb and (nb in endpoint_url or endpoint_url in nb):
                headers = build_headers(ep.api_key, nb)
                break
    except Exception as e:
        logger.debug("header resolve failed: %s", e)
    return headers


def fallbacks(owner: Optional[str]) -> List:
    """Utility-model fallback chain as ``[(url, model, headers), ...]``."""
    try:
        from src.endpoint_resolver import resolve_utility_fallback_candidates
        return resolve_utility_fallback_candidates(owner=owner or None)
    except Exception:
        return []

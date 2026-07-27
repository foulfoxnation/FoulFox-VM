"""FoulFox OS local-AI bootstrap.

On the appliance the ISO bakes Ollama + a default Llama model
(``FOULFOX_LOCAL_MODEL``, served by ollama.service on loopback :11434).
This startup task makes that model actually *used* out of the box:

1. Waits for the local Ollama server to come up and confirms the baked
   model is present.
2. Registers a ``ModelEndpoint`` for it (idempotent — matched by base_url).
3. Assigns it to all 3 agent-suite roles, but ONLY when no role has a model
   configured yet. A user's explicit model choice is never overridden
   (creating an endpoint != using it — the suite must be provisioned too).

Gated on ``FOULFOX_LOCAL_OLLAMA=1`` (set in /etc/foulfox/foulfox.env), so it
is a no-op in the Replit dev workspace and on non-appliance installs.
"""

import asyncio
import logging
import os
import uuid

logger = logging.getLogger(__name__)

OLLAMA_NATIVE = "http://127.0.0.1:11434"
OLLAMA_OPENAI_BASE = "http://127.0.0.1:11434/v1"
ENDPOINT_NAME = "FoulFox Local AI"

# How long to keep polling for ollama.service. On the appliance the ~5 GB baked
# model is seeded by foulfox-seed-ollama.service AFTER the user-facing stack is
# up (deferred, idle-priority, up to 45 min on slow USB storage), and
# ollama.service only starts once that finishes — so this async poll must
# outlast the whole seed window. It runs in the background and never blocks
# startup, so a long window costs nothing.
WAIT_TOTAL_SECONDS = 3600
POLL_INTERVAL_SECONDS = 5


async def _model_present(client, model: str) -> bool:
    try:
        resp = await client.get(f"{OLLAMA_NATIVE}/api/tags")
        if resp.status_code != 200:
            return False
        names = [m.get("name", "") for m in (resp.json().get("models") or [])]
        return any(n == model or n.split(":")[0] == model.split(":")[0] for n in names)
    except Exception:
        return False


def _ensure_endpoint(model: str) -> str:
    """Create (or find) the local Ollama ModelEndpoint. Returns its id."""
    from core.database import SessionLocal, ModelEndpoint

    db = SessionLocal()
    try:
        ep = (
            db.query(ModelEndpoint)
            .filter(ModelEndpoint.base_url.in_((OLLAMA_OPENAI_BASE, OLLAMA_NATIVE)))
            .first()
        )
        if ep is None:
            ep = ModelEndpoint(
                id=str(uuid.uuid4())[:8],
                name=ENDPOINT_NAME,
                base_url=OLLAMA_OPENAI_BASE,
                model_type="llm",
                endpoint_kind="local",
                is_enabled=True,
            )
            db.add(ep)
            db.commit()
            logger.info("local-ollama: registered endpoint %s -> %s", ep.id, OLLAMA_OPENAI_BASE)
        else:
            if not ep.is_enabled:
                ep.is_enabled = True
                db.commit()
        # Pin the baked model so it is offered even before a live /v1/models probe.
        try:
            import json as _json
            pinned = set(_json.loads(ep.pinned_models) if ep.pinned_models else [])
            if model not in pinned:
                pinned.add(model)
                ep.pinned_models = _json.dumps(sorted(pinned))
                db.commit()
        except Exception:
            logger.debug("local-ollama: pinning model failed (non-critical)", exc_info=True)
        return ep.id
    finally:
        db.close()


def _suite_needs_provisioning() -> bool:
    """True when no suite exists yet, or when NO role has a model configured.

    If even one role has an endpoint configured, the user (or a previous
    bootstrap) has made a choice — leave everything alone.
    """
    from core.database import SessionLocal, AgentSuite, AgentSuiteMember, CrewMember

    db = SessionLocal()
    try:
        suite = (
            db.query(AgentSuite)
            .filter(AgentSuite.owner.is_(None), AgentSuite.is_active == True)  # noqa: E712
            .order_by(AgentSuite.created_at.desc())
            .first()
        )
        if suite is None:
            return True
        members = db.query(AgentSuiteMember).filter(AgentSuiteMember.suite_id == suite.id).all()
        for m in members:
            if not m.crew_member_id:
                continue
            crew = db.query(CrewMember).filter(CrewMember.id == m.crew_member_id).first()
            if crew and (crew.endpoint_url or "").strip():
                return False
        return True
    finally:
        db.close()


async def ensure_local_ollama() -> None:
    if os.environ.get("FOULFOX_LOCAL_OLLAMA") != "1":
        return
    model = os.environ.get("FOULFOX_LOCAL_MODEL", "llama3.1:8b-instruct-q4_K_M")

    import httpx

    deadline = asyncio.get_event_loop().time() + WAIT_TOTAL_SECONDS
    async with httpx.AsyncClient(timeout=5.0) as client:
        while True:
            if await _model_present(client, model):
                break
            if asyncio.get_event_loop().time() > deadline:
                logger.warning(
                    "local-ollama: %s not available on %s after %ss; skipping auto-setup",
                    model, OLLAMA_NATIVE, WAIT_TOTAL_SECONDS,
                )
                return
            await asyncio.sleep(POLL_INTERVAL_SECONDS)

    try:
        endpoint_id = await asyncio.to_thread(_ensure_endpoint, model)
        if await asyncio.to_thread(_suite_needs_provisioning):
            from src import agent_suite

            role_models = {
                role: {"endpoint_id": endpoint_id, "model": model}
                for role in agent_suite.ROLES
            }
            await asyncio.to_thread(
                agent_suite.provision_suite,
                None,  # owner
                "FoulFox VM Suite",
                role_models,
            )
            logger.info("local-ollama: provisioned all agent roles onto %s (%s)", ENDPOINT_NAME, model)
        else:
            logger.info("local-ollama: suite already configured; endpoint registered but roles untouched")
    except Exception:
        logger.exception("local-ollama: bootstrap failed (non-critical)")

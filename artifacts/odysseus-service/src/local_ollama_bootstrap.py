"""FoulFox OS local-AI bootstrap.

On the appliance the ISO bakes Ollama + a default Llama model
(``FOULFOX_LOCAL_MODEL``, served by ollama.service on loopback :11434).
This startup task makes that model actually *used* out of the box:

1. Waits for the local Ollama server to come up and confirms the baked
   model is present.
2. Registers a ``ModelEndpoint`` for it (idempotent — matched by base_url).
3. Provisions all 3 agent-suite roles onto local Ollama when:
   a) no suite / no roles have a model set yet, OR
   b) the currently-configured endpoint is unreachable (cloud endpoint
      that can't be reached off-platform, or Replit proxy set by start.sh
      that doesn't work on the appliance).  In that case local Ollama is
      preferred automatically — the user can always reconfigure later.

Local Ollama is always the free default; the user's cloud Ollama proxy is
an explicit opt-in.  We never override a working cloud configuration.
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

# Hosts/URLs that are known-dead on the appliance (off-platform cloud).
# Any configured endpoint whose base URL contains one of these strings is
# treated as unreachable without a live network probe (saves 5-second timeout
# per host on every boot).
_KNOWN_OFFPLATFORM = (
    "openai-proxy.replit.com",   # Replit AI proxy — only reachable in dev
    "openai.com",
    "anthropic.com",
    "api.groq.com",
    "openrouter.ai",
)


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


def _get_current_suite_endpoint_urls() -> list[str]:
    """Return all endpoint base_urls configured in the active suite's roles."""
    from core.database import SessionLocal, AgentSuite, AgentSuiteMember, ModelEndpoint

    db = SessionLocal()
    try:
        suite = (
            db.query(AgentSuite)
            .filter(AgentSuite.owner.is_(None), AgentSuite.is_active == True)  # noqa: E712
            .order_by(AgentSuite.created_at.desc())
            .first()
        )
        if suite is None:
            return []
        members = db.query(AgentSuiteMember).filter(AgentSuiteMember.suite_id == suite.id).all()
        urls: list[str] = []
        for m in members:
            if not m.endpoint_id:
                continue
            ep = db.query(ModelEndpoint).filter(ModelEndpoint.id == m.endpoint_id).first()
            if ep and ep.base_url:
                urls.append(ep.base_url)
        return urls
    except Exception as exc:
        logger.debug("local-ollama: could not read suite endpoint URLs: %s", exc)
        return []
    finally:
        db.close()


async def _suite_endpoint_reachable(client, urls: list[str]) -> bool:
    """Return True if at least one configured endpoint is actually responding."""
    if not urls:
        return False
    for url in urls:
        # Fast-fail known off-platform cloud hosts without a network probe.
        if any(bad in url for bad in _KNOWN_OFFPLATFORM):
            logger.debug("local-ollama: endpoint %s is known-offplatform — treating as unreachable", url)
            continue
        # Probe: try /models (OpenAI-compat) then /api/tags (Ollama native).
        base = url.rstrip("/")
        for probe_path in ("/models", "/api/tags", "/v1/models"):
            try:
                resp = await client.get(base + probe_path, timeout=4.0)
                if resp.status_code < 400:
                    logger.debug("local-ollama: endpoint %s is reachable (%s)", url, probe_path)
                    return True
            except Exception:
                continue
    return False


def _suite_needs_provisioning() -> bool:
    """True when no suite exists or NO role has an endpoint configured."""
    from core.database import SessionLocal, AgentSuite, AgentSuiteMember

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
        return not any(m.endpoint_id for m in members)
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

    logger.info("local-ollama: model %s confirmed present on %s", model, OLLAMA_NATIVE)

    try:
        endpoint_id = await asyncio.to_thread(_ensure_endpoint, model)

        needs_provision = await asyncio.to_thread(_suite_needs_provisioning)

        if not needs_provision:
            # Suite is configured — but is the endpoint it points at actually alive?
            current_urls = await asyncio.to_thread(_get_current_suite_endpoint_urls)
            reachable    = await _suite_endpoint_reachable(client, current_urls)

            if reachable:
                logger.info(
                    "local-ollama: suite already configured and endpoint is reachable — "
                    "local endpoint registered but roles untouched"
                )
                return

            # Endpoint is unreachable (off-platform cloud, dead proxy, etc.).
            # Switch all roles to local Ollama — the user can reconfigure later.
            logger.warning(
                "local-ollama: suite is configured but endpoint(s) %s are unreachable — "
                "switching all roles to local Ollama (%s)",
                current_urls, model,
            )
            needs_provision = True

        if needs_provision:
            from src import agent_suite

            role_models = {
                role: {"endpoint_id": endpoint_id, "model": model}
                for role in agent_suite.ROLES
            }
            await asyncio.to_thread(
                agent_suite.provision_suite,
                None,   # owner
                "FoulFox VM Suite",
                role_models,
            )
            logger.info(
                "local-ollama: provisioned all agent roles onto %s (%s)",
                ENDPOINT_NAME, model,
            )

    except Exception:
        logger.exception("local-ollama: bootstrap failed (non-critical)")

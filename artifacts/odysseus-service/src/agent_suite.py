"""Odysseus 3-agent suite: Windows Agent, Game Agent, Odysseus Architect.

This builds ON TOP of the existing CrewMember + Session model. Each role is
realized as a CrewMember with its own pinned Session, so the existing chat /
agent loop drives them unchanged. Per-agent model/endpoint live on the
CrewMember, so a suite can be all-Claude today and any model later — the suite
is model-agnostic by construction.

Provisioning is idempotent: re-running updates the existing crew + sessions in
place (e.g. when the user repoints an agent at a different model) rather than
spawning duplicates.
"""
import json
import logging
import uuid

from core.database import (
    SessionLocal,
    AgentSuite,
    AgentSuiteMember,
    CrewMember,
    Session as DbSession,
    utcnow_naive,
)

logger = logging.getLogger(__name__)

ROLES = ("windows", "game", "architect")

# Shared guide-rail preamble appended to every role. The lessons framework
# (retrieval of domain lessons) layers on top of this at execution time.
_COMMON_RAILS = (
    "\n\nGUIDE RAILS (apply to every task):\n"
    "- Act, don't narrate: use your tools to do the work, then report concrete, "
    "verifiable results. Never say what you 'would' do — do it.\n"
    "- Work in small, checkpointed steps so your output can be reviewed.\n"
    "- Verify each step's outcome before moving on; if a step fails, diagnose "
    "and adapt instead of repeating the same action.\n"
    "- Never take destructive or irreversible actions without explicit "
    "instruction.\n"
    "- Be honest about uncertainty; never fabricate command output or results.\n"
)

WINDOWS_TOOLS = [
    "web_search", "web_fetch", "read_file",
    "create_document", "update_document", "edit_document",
    "manage_notes", "manage_memory", "manage_tasks",
    "search_chats", "trigger_research",
]
GAME_TOOLS = list(WINDOWS_TOOLS)
ARCHITECT_TOOLS = [
    "read_file", "web_search", "web_fetch", "search_chats",
    "manage_notes", "manage_memory", "create_document", "update_document",
]

ROLE_DEFS = {
    "windows": {
        "name": "Windows Agent",
        "folder": "Agent Suite",
        "sort": 1,
        "tools": WINDOWS_TOOLS,
        "description": (
            "Operates a Windows environment: installing/configuring software, "
            "navigating the OS, automation, file management, troubleshooting, "
            "and scripting (PowerShell / batch)."
        ),
        "personality": (
            "You are the Windows Agent in the FoulFox VM suite. Your domain is "
            "operating a Windows environment: installing and configuring "
            "software, navigating the OS, automating tasks, managing files, "
            "troubleshooting, and scripting with PowerShell and batch.\n"
            "Produce output a reviewer can verify: the commands you ran, the "
            "results you observed, and the files or state you changed. Your work "
            "is reviewed by the FoulFox VM Architect before it is considered done."
            + _COMMON_RAILS
        ),
    },
    "game": {
        "name": "Game Agent",
        "folder": "Agent Suite",
        "sort": 2,
        "tools": GAME_TOOLS,
        "description": (
            "Plays, automates, tests, and builds games: game logic, input "
            "automation, strategy, and game development where relevant."
        ),
        "personality": (
            "You are the Game Agent in the FoulFox VM suite. Your domain is "
            "games: playing, automating, testing, and building them — game "
            "logic, input automation, strategy, and (where relevant) game "
            "development.\n"
            "State your objective and plan, then execute step by step and "
            "report verifiable results. Your work is reviewed by the FoulFox VM "
            "Architect before it is considered done."
            + _COMMON_RAILS
        ),
    },
    "architect": {
        "name": "FoulFox VM Architect",
        "folder": "Agent Suite",
        "sort": 3,
        "tools": ARCHITECT_TOOLS,
        "description": (
            "Reviews the Windows and Game agents' output (PASS/FAIL with exact "
            "required fixes), and periodically reviews the whole project and its "
            "memory to set direction and dispatch work."
        ),
        "personality": (
            "You are the FoulFox VM Architect — the reviewer and planner of the "
            "suite. You review the output of the Windows Agent and the Game "
            "Agent, decide PASS or FAIL, and when work fails you specify the "
            "exact fixes required. You also periodically review the whole "
            "project and its memory to set direction.\n"
            "Be rigorous and specific. A PASS means the work genuinely meets the "
            "stated objective and is verifiable. A FAIL must list concrete "
            "issues and the exact required fixes — judge against the objective "
            "and the role's guide rails/lessons, not vibes. Prefer minimal, "
            "targeted fixes; do not expand scope. When asked for a verdict, "
            "respond in the exact structured format requested."
            + _COMMON_RAILS
        ),
    },
}


def role_catalog():
    """Role metadata for the setup wizard / UI (no DB access)."""
    return [
        {
            "role": role,
            "name": ROLE_DEFS[role]["name"],
            "description": ROLE_DEFS[role]["description"],
            "default_tools": ROLE_DEFS[role]["tools"],
        }
        for role in ROLES
    ]


def _resolve_role_endpoint(db, owner, endpoint_id=None, model=None):
    """Resolve (endpoint_url, model) for one role.

    Priority: an explicitly chosen endpoint_id+model -> the user's default-chat
    resolution -> the most recent existing session's endpoint. Returns
    ("", "") only when nothing is configured yet (first run before any model
    exists), which is fine: the agent is created and becomes usable once a model
    is configured.
    """
    from src.endpoint_resolver import resolve_endpoint, resolve_endpoint_by_id

    if endpoint_id:
        try:
            resolved = resolve_endpoint_by_id(endpoint_id, model or "", owner=owner)
            if resolved:
                url, m, _headers = resolved
                if url and m:
                    return url, m
        except Exception as e:
            logger.debug("resolve_endpoint_by_id(%s) failed: %s", endpoint_id, e)

    try:
        url, m, _headers = resolve_endpoint("default", owner=owner)
        if url and m:
            return url, m
    except Exception as e:
        logger.debug("resolve_endpoint('default') failed: %s", e)

    try:
        recent = db.query(DbSession).filter(
            DbSession.endpoint_url.isnot(None),
            DbSession.model.isnot(None),
            *([DbSession.owner == owner] if owner else []),
        ).order_by(DbSession.created_at.desc()).first()
        if recent and recent.endpoint_url and recent.model:
            return recent.endpoint_url, recent.model
    except Exception:
        pass

    return (model and "" or ""), (model or "")


def get_suite(owner=None):
    """Return the active suite for an owner as a dict, or None."""
    owner = owner or None
    db = SessionLocal()
    try:
        suite = db.query(AgentSuite).filter(
            AgentSuite.owner == owner,
            AgentSuite.is_active == True,  # noqa: E712
        ).order_by(AgentSuite.created_at.desc()).first()
        return suite.to_dict() if suite else None
    finally:
        db.close()


def get_session_role_context(session_id):
    """For a chat/agent session that belongs to a 3-agent-suite member, return
    ``{"role": <windows|game|architect>, "personality": <crew persona>}``;
    return ``None`` for ordinary (non-suite) sessions.

    The session id is globally unique, so a single lookup by ``session_id`` is
    enough to identify the role (no owner join needed). This runs on every chat
    turn at execution time (P4), so it is intentionally lightweight and never
    raises into the chat path — a missing/empty suite simply yields ``None``.
    """
    if not session_id:
        return None
    db = SessionLocal()
    try:
        member = db.query(AgentSuiteMember).filter(
            AgentSuiteMember.session_id == session_id
        ).first()
        if not member:
            return None
        personality = ""
        if member.crew_member_id:
            crew = db.query(CrewMember).filter(
                CrewMember.id == member.crew_member_id
            ).first()
            if crew and crew.personality:
                personality = crew.personality.strip()
        if not personality:
            rd = ROLE_DEFS.get(member.role)
            personality = (rd["personality"] if rd else "").strip()
        return {"role": member.role, "personality": personality}
    except Exception as e:
        logger.debug("get_session_role_context(%s) failed: %s", session_id, e)
        return None
    finally:
        db.close()


def provision_suite(owner=None, name="FoulFox VM Suite", role_models=None,
                    mark_setup_complete=False):
    """Create or update the 3-agent suite for an owner (idempotent).

    Args:
        owner: row owner (None in single-user / auth-disabled mode).
        name: suite display name.
        role_models: optional {role: {"endpoint_id": str, "model": str}} to pick
            a model per agent. Missing roles fall back to default resolution.
        mark_setup_complete: set the suite's setup_complete flag when True.

    Returns the suite dict.
    """
    owner = owner or None
    role_models = role_models or {}
    db = SessionLocal()
    try:
        suite = db.query(AgentSuite).filter(
            AgentSuite.owner == owner,
            AgentSuite.is_active == True,  # noqa: E712
        ).order_by(AgentSuite.created_at.desc()).first()
        if not suite:
            suite = AgentSuite(
                id=str(uuid.uuid4()), owner=owner, name=name or "FoulFox VM Suite",
                is_active=True, setup_complete=False,
            )
            db.add(suite)
            db.flush()
        elif name:
            suite.name = name

        existing = {
            m.role: m
            for m in db.query(AgentSuiteMember).filter(
                AgentSuiteMember.suite_id == suite.id
            ).all()
        }

        for role in ROLES:
            rd = ROLE_DEFS[role]
            cfg = role_models.get(role) or {}
            endpoint_url, model = _resolve_role_endpoint(
                db, owner, cfg.get("endpoint_id"), cfg.get("model"))
            tools_json = json.dumps(rd["tools"])

            member = existing.get(role)
            crew = None
            if member and member.crew_member_id:
                crew = db.query(CrewMember).filter(
                    CrewMember.id == member.crew_member_id).first()

            if crew is None:
                # Fresh crew + pinned session for this role.
                sid = str(uuid.uuid4())
                sess = DbSession(
                    id=sid, name=rd["name"], endpoint_url=endpoint_url or "",
                    model=model or "", owner=owner, is_important=True,
                    mode="agent", folder=rd["folder"],
                    created_at=utcnow_naive(), updated_at=utcnow_naive(),
                )
                db.add(sess)
                db.flush()
                crew_id = str(uuid.uuid4())
                crew = CrewMember(
                    id=crew_id, owner=owner, name=rd["name"], avatar=None,
                    user_name=None, personality=rd["personality"], model=model,
                    endpoint_url=endpoint_url, greeting=None,
                    enabled_tools=tools_json, session_id=sid, is_active=True,
                    sort_order=rd["sort"], is_default_assistant=False,
                    timezone=None,
                )
                db.add(crew)
                db.flush()  # crew must exist before the member FK references it
                sess.crew_member_id = crew_id
                if member is None:
                    member = AgentSuiteMember(
                        id=str(uuid.uuid4()), suite_id=suite.id, role=role,
                        crew_member_id=crew_id, session_id=sid,
                    )
                    db.add(member)
                else:
                    member.crew_member_id = crew_id
                    member.session_id = sid
                db.flush()
            else:
                # Update existing crew in place (e.g. repoint model).
                crew.name = rd["name"]
                crew.personality = rd["personality"]
                crew.enabled_tools = tools_json
                crew.model = model
                crew.endpoint_url = endpoint_url
                crew.is_active = True
                sess = None
                if crew.session_id:
                    sess = db.query(DbSession).filter(
                        DbSession.id == crew.session_id).first()
                if sess is None:
                    sid = str(uuid.uuid4())
                    sess = DbSession(
                        id=sid, name=rd["name"], endpoint_url=endpoint_url or "",
                        model=model or "", owner=owner, is_important=True,
                        mode="agent", folder=rd["folder"],
                        created_at=utcnow_naive(), updated_at=utcnow_naive(),
                    )
                    db.add(sess)
                    db.flush()
                    sess.crew_member_id = crew.id
                    crew.session_id = sid
                else:
                    sess.endpoint_url = endpoint_url or ""
                    sess.model = model or ""
                member.session_id = crew.session_id

        if mark_setup_complete:
            suite.setup_complete = True

        suite_id = suite.id
        db.commit()

        # Seed the starter lesson packs so a freshly provisioned suite has its
        # baseline guide-rail knowledge. Idempotent + non-fatal.
        try:
            from src import agent_lessons
            agent_lessons.seed_lessons(owner=owner)
        except Exception as e:
            logger.warning("seed_lessons failed (non-fatal): %s", e)

        result = db.query(AgentSuite).filter(AgentSuite.id == suite_id).first()
        return result.to_dict() if result else None
    except Exception as e:
        db.rollback()
        logger.exception("provision_suite(owner=%s) failed: %s", owner, e)
        raise
    finally:
        db.close()

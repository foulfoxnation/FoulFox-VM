"""Agent lessons / guide rails knowledge base.

SQLite-backed keyword retrieval, so it works with no vector store (Chroma /
fastembed) installed. Each lesson is scoped to a role
(windows|game|architect|shared). Guide rails proper live in the CrewMember
personality (see src/agent_suite.py); these lessons are the *growable*
knowledge layer: seeded starter packs plus lessons the Architect writes from
reviews. The top-N relevant lessons are injected per turn at execution time.
"""
import json
import logging
import re
import uuid

from core.database import SessionLocal, AgentLesson

logger = logging.getLogger(__name__)

ROLES = ("windows", "game", "architect", "shared")

_WORD_RE = re.compile(r"[a-z0-9]+")
_STOP = {
    "the", "and", "for", "with", "that", "this", "you", "your", "are", "use",
    "using", "from", "into", "out", "not", "but", "any", "all", "can", "will",
    "has", "have", "had", "was", "were", "its", "it's", "they", "them", "then",
    "than", "when", "what", "which", "who", "how", "why", "where", "a", "an",
    "to", "of", "in", "on", "is", "be", "by", "or", "as", "at", "do", "does",
}


def _tokenize(text):
    return [
        w for w in _WORD_RE.findall((text or "").lower())
        if len(w) > 2 and w not in _STOP
    ]


# --------------------------------------------------------------------------
# Seed packs — starter "lessons" per role. Concise, practical, growable.
# --------------------------------------------------------------------------
SEED_LESSONS = {
    "windows": [
        ("Preview destructive actions",
         "Before any delete/format/registry change, confirm the exact target. "
         "In PowerShell use -WhatIf to preview, then run for real. Never wipe a "
         "path or key you have not verified.",
         ["delete", "registry", "powershell", "safety", "whatif"]),
        ("Prefer scripts over the GUI",
         "Automate with PowerShell or batch instead of clicking through the GUI: "
         "scripted steps are repeatable, reviewable, and verifiable.",
         ["powershell", "automation", "scripting", "batch"]),
        ("Least privilege; elevate only when required",
         "Run elevated (UAC/admin) only for genuine system changes. Default to a "
         "normal user context for everything else.",
         ["uac", "admin", "permissions", "elevation"]),
        ("Check exit codes after every command",
         "After each command inspect $LASTEXITCODE / $? and surface failures "
         "explicitly. Do not assume a command succeeded.",
         ["errors", "exit-code", "verify", "powershell"]),
        ("Install via package managers",
         "Prefer winget or Chocolatey for installing software — reproducible and "
         "scriptable — over downloading and running manual installers.",
         ["install", "winget", "chocolatey", "software"]),
    ],
    "game": [
        ("State the objective and win condition first",
         "Before acting, define the goal and how success is measured (score, "
         "level, survival). Plan to the win condition, not to vibes.",
         ["planning", "objective", "goal"]),
        ("Observe before acting",
         "Read the current game state / screen before issuing inputs. Do not "
         "blind-spam buttons; act on what you actually observe.",
         ["observe", "input", "state", "perception"]),
        ("Throttle inputs to game timing",
         "Insert small realistic delays between automated inputs so they match "
         "the game's frame/animation timing instead of firing instantly.",
         ["input", "timing", "automation", "delay"]),
        ("Save at checkpoints before risk",
         "Use in-game saves before risky maneuvers so a failure is recoverable "
         "and you can retry a strategy cheaply.",
         ["save", "checkpoint", "recovery"]),
        ("Measure, don't guess",
         "Track score, health, and resources numerically each step to evaluate "
         "whether a strategy is working before committing further.",
         ["metrics", "strategy", "evaluation"]),
    ],
    "architect": [
        ("PASS only when verifiable",
         "Return PASS only when the objective is demonstrably met with concrete "
         "evidence (commands run, outputs, files changed). No evidence, no PASS.",
         ["review", "verdict", "evidence", "pass"]),
        ("FAIL must be actionable",
         "A FAIL lists concrete issues and the exact required fixes. Vague "
         "critique is not a useful verdict — say precisely what to change.",
         ["review", "fail", "fixes", "actionable"]),
        ("Judge against objective and lessons",
         "Evaluate the work against the stated objective and the role's guide "
         "rails / lessons — not personal style preferences.",
         ["review", "criteria", "objective"]),
        ("Keep required fixes minimal",
         "Request the smallest change that meets the objective. Do not expand "
         "scope or gold-plate during review.",
         ["scope", "fixes", "minimal"]),
        ("Turn recurring failures into lessons",
         "When the same mistake repeats across runs, write a new lesson for that "
         "role so the knowledge base grows and the mistake stops recurring.",
         ["lessons", "learning", "memory", "growth"]),
    ],
    "shared": [
        ("Act, don't narrate",
         "Use your tools to do the work and report concrete results. Never "
         "describe what you 'would' do — do it and show the outcome.",
         ["tools", "action", "execution"]),
        ("Be honest about uncertainty",
         "Never fabricate command output or results. State plainly what you "
         "could not verify and what evidence is missing.",
         ["honesty", "uncertainty", "verify"]),
        ("Work in reviewable checkpoints",
         "Break work into small, verifiable steps so progress can be reviewed "
         "and a failure is easy to localize and fix.",
         ["process", "checkpoints", "steps"]),
    ],
}


# --------------------------------------------------------------------------
# CRUD
# --------------------------------------------------------------------------
def add_lesson(role, text, title="", tags=None, source="manual",
               owner=None, is_active=True):
    if role not in ROLES:
        raise ValueError(f"invalid role: {role}")
    owner = owner or None
    db = SessionLocal()
    try:
        lesson = AgentLesson(
            id=str(uuid.uuid4()), owner=owner, role=role,
            title=(title or "").strip(), text=(text or "").strip(),
            tags=json.dumps(list(tags or [])), source=source,
            is_active=is_active,
        )
        db.add(lesson)
        db.commit()
        db.refresh(lesson)
        result = lesson.to_dict()
    finally:
        db.close()
    _index_lesson_safe(result)
    return result


def list_lessons(role=None, owner=None, include_inactive=False):
    owner = owner or None
    db = SessionLocal()
    try:
        q = db.query(AgentLesson).filter(AgentLesson.owner == owner)
        if role:
            q = q.filter(AgentLesson.role == role)
        if not include_inactive:
            q = q.filter(AgentLesson.is_active == True)  # noqa: E712
        rows = q.order_by(AgentLesson.role, AgentLesson.created_at).all()
        return [r.to_dict() for r in rows]
    finally:
        db.close()


def update_lesson(lesson_id, owner=None, **fields):
    owner = owner or None
    db = SessionLocal()
    try:
        row = db.query(AgentLesson).filter(
            AgentLesson.id == lesson_id, AgentLesson.owner == owner).first()
        if not row:
            return None
        if "title" in fields:
            row.title = (fields["title"] or "").strip()
        if "text" in fields:
            row.text = (fields["text"] or "").strip()
        if "tags" in fields:
            row.tags = json.dumps(list(fields["tags"] or []))
        if "role" in fields and fields["role"] in ROLES:
            row.role = fields["role"]
        if "is_active" in fields:
            row.is_active = bool(fields["is_active"])
        if "source" in fields:
            row.source = fields["source"]
        db.commit()
        db.refresh(row)
        result = row.to_dict()
    finally:
        db.close()
    _index_lesson_safe(result)
    return result


def delete_lesson(lesson_id, owner=None):
    owner = owner or None
    db = SessionLocal()
    try:
        row = db.query(AgentLesson).filter(
            AgentLesson.id == lesson_id, AgentLesson.owner == owner).first()
        if not row:
            return False
        db.delete(row)
        db.commit()
    finally:
        db.close()
    _unindex_lesson_safe(lesson_id, owner)
    return True


def count_lessons(owner=None):
    owner = owner or None
    db = SessionLocal()
    try:
        return db.query(AgentLesson).filter(AgentLesson.owner == owner).count()
    finally:
        db.close()


# --------------------------------------------------------------------------
# Retrieval — semantic when an embedder/vector store is available, else keyword
# --------------------------------------------------------------------------
def retrieve_lessons(query, role, owner=None, limit=5):
    """Return up to `limit` active lessons for `role` (+ shared), ranked by
    SEMANTIC similarity to `query` when an embedder / vector store is available,
    falling back to keyword overlap otherwise.

    Isolation is guaranteed structurally by the SQL filter below: an agent only
    ever sees its own role plus the shared scope. The ranking layer
    (:mod:`src.agent_kb`) only orders that already-isolated candidate set, so a
    windows agent can never surface another agent's private lessons regardless
    of which ranking tier is active.
    """
    owner = owner or None
    roles = ["shared"] if role == "shared" else [role, "shared"]
    db = SessionLocal()
    try:
        rows = db.query(AgentLesson).filter(
            AgentLesson.role.in_(roles),
            AgentLesson.is_active == True,  # noqa: E712
            AgentLesson.owner == owner,
        ).all()
    finally:
        db.close()

    candidates = [r.to_dict() for r in rows]
    # Semantic ranking over the role-isolated candidates. Returns None when no
    # embedder / vector store is available, in which case we keyword-rank.
    try:
        from src import agent_kb
        ranked = agent_kb.rank_lessons(query, role, owner, candidates, limit)
        if ranked is not None:
            return ranked
    except Exception as e:
        logger.debug(
            "semantic lesson ranking unavailable, keyword fallback: %s", e)
    return _keyword_rank(query, candidates, limit)


def _keyword_rank(query, candidates, limit):
    """Rank candidate lesson dicts by keyword overlap with `query`. Falls back
    to most-recent when nothing overlaps, so core guide-rail lessons are always
    present. This is the no-embedder fallback for :func:`retrieve_lessons`.
    """
    q_tokens = set(_tokenize(query))
    scored = []
    for c in candidates:
        body_tokens = set(_tokenize(
            " ".join([c.get("title") or "", c.get("text") or ""])))
        tag_tokens = set(_tokenize(" ".join(c.get("tags") or [])))
        score = len(q_tokens & body_tokens) + 2 * len(q_tokens & tag_tokens)
        scored.append((score, c))

    scored.sort(key=lambda t: (t[0], t[1].get("created_at") or ""),
                reverse=True)
    top = [c for (s, c) in scored if s > 0][:limit]
    if not top:
        top = [c for (s, c) in scored][:limit]
    return top


def format_lessons_block(lessons):
    """Render retrieved lessons as a compact prompt block (used in P4)."""
    if not lessons:
        return ""
    lines = ["RELEVANT LESSONS (apply these):"]
    for l in lessons:
        title = (l.get("title") or "").strip()
        text = (l.get("text") or "").strip()
        lines.append(f"- {title}: {text}" if title else f"- {text}")
    return "\n".join(lines)


# --------------------------------------------------------------------------
# Seeding — idempotent upsert of starter packs by (owner, role, title, seed)
# --------------------------------------------------------------------------
def seed_lessons(owner=None, force=False):
    """Insert/refresh the starter lesson packs for an owner. Idempotent:
    matches existing seed lessons by (role, title) and updates them in place
    rather than duplicating. Returns the number of lessons created.
    """
    owner = owner or None
    created = 0
    touched = []
    db = SessionLocal()
    try:
        existing = {
            (r.role, r.title): r
            for r in db.query(AgentLesson).filter(
                AgentLesson.owner == owner,
                AgentLesson.source == "seed",
            ).all()
        }
        for role, items in SEED_LESSONS.items():
            for title, text, tags in items:
                row = existing.get((role, title))
                if row is not None:
                    if force:
                        row.text = text
                        row.tags = json.dumps(tags)
                        touched.append(row)
                    continue
                row = AgentLesson(
                    id=str(uuid.uuid4()), owner=owner, role=role, title=title,
                    text=text, tags=json.dumps(tags), source="seed",
                    is_active=True,
                )
                db.add(row)
                touched.append(row)
                created += 1
        db.commit()
        indexable = [r.to_dict() for r in touched]
    except Exception as e:
        db.rollback()
        logger.exception("seed_lessons(owner=%s) failed: %s", owner, e)
        raise
    finally:
        db.close()
    _index_lessons_safe(indexable)
    return created


# --------------------------------------------------------------------------
# Vector-index write routing — best-effort, never raises into callers.
# Routes each lesson to its agent's scope (its role). No-op when the vector
# store (ChromaDB) is unavailable, so the SQLite store stays authoritative.
# --------------------------------------------------------------------------
def _index_lesson_safe(lesson):
    try:
        from src import agent_kb
        agent_kb.index_lesson(lesson)
    except Exception as e:
        logger.debug("agent_kb index_lesson skipped: %s", e)


def _index_lessons_safe(lessons):
    try:
        from src import agent_kb
        agent_kb.index_lessons(lessons)
    except Exception as e:
        logger.debug("agent_kb index_lessons skipped: %s", e)


def _unindex_lesson_safe(lesson_id, owner):
    try:
        from src import agent_kb
        agent_kb.unindex_lesson(lesson_id, owner)
    except Exception as e:
        logger.debug("agent_kb unindex_lesson skipped: %s", e)

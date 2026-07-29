"""Multi-Task Memory (MTM) — shared coordination layer for all Odysseus agents.

Provides:
1. Task registry  — every in-flight and recent agent task, visible to all agents and the UI.
2. Shared scratchpad — a key-value store any agent can read/write (findings, project facts).
3. SSE broadcast bus — asyncio.Queue per subscriber so the shell gets instant live updates.
4. JSON persistence — written to ODYSSEUS_DATA_DIR/mtm.json on change; survives restarts.

All mutations are guarded by a single asyncio.Lock. Reads are lock-free (safe because
we only swap atomic Python references). The singleton ``mtm`` is imported directly:

    from src.mtm import mtm
    task = await mtm.create_task(title="Search docs", kind="discover", agent_role="explorer")
    await mtm.update_task(task.id, status="running", findings_append="Found 3 results")
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Set

logger = logging.getLogger(__name__)

_DATA_DIR = os.environ.get("ODYSSEUS_DATA_DIR", os.path.expanduser("~"))
_PERSIST_PATH = os.path.join(_DATA_DIR, "mtm.json")

TASK_KINDS = frozenset(("discover", "worker", "scheduled", "manual", "plan"))
TASK_STATUSES = frozenset(("pending", "running", "done", "error", "cancelled"))


def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _new_id() -> str:
    return uuid.uuid4().hex[:16]


class MTMTask:
    """One tracked agent task in the MTM."""
    __slots__ = (
        "id", "title", "kind", "status", "agent_role", "parent_id",
        "created_at", "updated_at", "findings", "tool_calls", "rounds",
        "error", "children", "meta",
    )

    def __init__(
        self, *, id: Optional[str] = None, title: str,
        kind: str = "manual", status: str = "pending",
        agent_role: str = "shared", parent_id: Optional[str] = None,
        created_at: Optional[str] = None, updated_at: Optional[str] = None,
        findings: str = "", tool_calls: int = 0, rounds: int = 0,
        error: Optional[str] = None, children: Optional[List[str]] = None,
        meta: Optional[Dict[str, Any]] = None,
    ):
        self.id = id or _new_id()
        self.title = str(title)[:200]
        self.kind = kind if kind in TASK_KINDS else "manual"
        self.status = status if status in TASK_STATUSES else "pending"
        self.agent_role = str(agent_role)[:60]
        self.parent_id = parent_id
        self.created_at = created_at or _utcnow()
        self.updated_at = updated_at or _utcnow()
        self.findings = str(findings)
        self.tool_calls = int(tool_calls)
        self.rounds = int(rounds)
        self.error = error
        self.children: List[str] = list(children or [])
        self.meta: Dict[str, Any] = dict(meta or {})

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id, "title": self.title, "kind": self.kind,
            "status": self.status, "agent_role": self.agent_role,
            "parent_id": self.parent_id, "created_at": self.created_at,
            "updated_at": self.updated_at, "findings": self.findings[:6000],
            "tool_calls": self.tool_calls, "rounds": self.rounds,
            "error": self.error, "children": self.children, "meta": self.meta,
        }

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "MTMTask":
        return cls(
            id=d.get("id"), title=d.get("title", "(untitled)"),
            kind=d.get("kind", "manual"), status=d.get("status", "done"),
            agent_role=d.get("agent_role", "shared"), parent_id=d.get("parent_id"),
            created_at=d.get("created_at"), updated_at=d.get("updated_at"),
            findings=d.get("findings", ""), tool_calls=int(d.get("tool_calls") or 0),
            rounds=int(d.get("rounds") or 0), error=d.get("error"),
            children=list(d.get("children") or []), meta=dict(d.get("meta") or {}),
        )


class MultiTaskMemory:
    """Process-global MTM singleton. Always import the ``mtm`` instance at the bottom."""

    MAX_TASKS = 500
    MAX_MEMORY_KEYS = 300
    PERSIST_DEBOUNCE = 4.0

    def __init__(self) -> None:
        self._lock: Optional[asyncio.Lock] = None
        self._tasks: Dict[str, MTMTask] = {}
        self._memory: Dict[str, Dict[str, Any]] = {}
        self._subscribers: Set[asyncio.Queue] = set()
        self._last_persist: float = 0.0
        self._loaded = False

    def _get_lock(self) -> asyncio.Lock:
        if self._lock is None:
            self._lock = asyncio.Lock()
        return self._lock

    # ── Lifecycle ──────────────────────────────────────────────────────────

    async def load(self) -> None:
        """Load persisted state from disk (idempotent — call once at app startup)."""
        if self._loaded:
            return
        self._loaded = True
        try:
            if not os.path.exists(_PERSIST_PATH):
                return
            with open(_PERSIST_PATH, encoding="utf-8") as f:
                data = json.load(f)
            for td in data.get("tasks") or []:
                t = MTMTask.from_dict(td)
                if t.status in ("running", "pending"):
                    t.status = "error"
                    t.error = "Server restarted while task was in progress"
                    t.updated_at = _utcnow()
                self._tasks[t.id] = t
            mem = data.get("memory") or {}
            if isinstance(mem, dict):
                self._memory = mem
            logger.info(
                "MTM loaded %d tasks, %d memory entries",
                len(self._tasks), len(self._memory),
            )
        except Exception as e:
            logger.debug("MTM load failed (non-fatal): %s", e)

    async def _persist(self) -> None:
        """Debounced write to disk — at most every PERSIST_DEBOUNCE seconds."""
        now = time.monotonic()
        if now - self._last_persist < self.PERSIST_DEBOUNCE:
            return
        self._last_persist = now
        try:
            tasks_list = sorted(self._tasks.values(), key=lambda t: t.created_at)[-self.MAX_TASKS:]
            payload = {
                "tasks": [t.to_dict() for t in tasks_list],
                "memory": self._memory,
            }
            tmp = _PERSIST_PATH + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(payload, f, ensure_ascii=False)
            os.replace(tmp, _PERSIST_PATH)
        except Exception as e:
            logger.debug("MTM persist failed (non-fatal): %s", e)

    # ── Task CRUD ─────────────────────────────────────────────────────────

    async def create_task(
        self, *, title: str, kind: str = "manual",
        agent_role: str = "shared", parent_id: Optional[str] = None,
        meta: Optional[Dict[str, Any]] = None,
    ) -> MTMTask:
        task = MTMTask(
            title=title, kind=kind, status="pending",
            agent_role=agent_role, parent_id=parent_id, meta=meta,
        )
        async with self._get_lock():
            if parent_id and parent_id in self._tasks:
                if task.id not in self._tasks[parent_id].children:
                    self._tasks[parent_id].children.append(task.id)
            self._tasks[task.id] = task
            await self._evict()
            await self._persist()
        await self._broadcast({"type": "task_created", "task": task.to_dict()})
        return task

    async def update_task(
        self, task_id: str, *,
        status: Optional[str] = None,
        findings: Optional[str] = None,
        findings_append: Optional[str] = None,
        tool_calls: Optional[int] = None,
        rounds: Optional[int] = None,
        error: Optional[str] = None,
        meta_update: Optional[Dict[str, Any]] = None,
    ) -> Optional[MTMTask]:
        async with self._get_lock():
            task = self._tasks.get(task_id)
            if not task:
                return None
            if status is not None:
                task.status = status if status in TASK_STATUSES else task.status
            if findings is not None:
                task.findings = str(findings)[:8000]
            if findings_append:
                task.findings = (task.findings + "\n" + str(findings_append).strip())[:8000]
            if tool_calls is not None:
                task.tool_calls = int(tool_calls)
            if rounds is not None:
                task.rounds = int(rounds)
            if error is not None:
                task.error = str(error)
            if meta_update:
                task.meta.update(meta_update)
            task.updated_at = _utcnow()
            await self._persist()
        await self._broadcast({"type": "task_updated", "task": task.to_dict()})
        return task

    async def get_task(self, task_id: str) -> Optional[MTMTask]:
        return self._tasks.get(task_id)

    async def list_tasks(
        self, *, limit: int = 50, kind: Optional[str] = None,
        status: Optional[str] = None, parent_id: Optional[str] = None,
        include_children: bool = True,
    ) -> List[MTMTask]:
        tasks = list(self._tasks.values())
        if kind:
            tasks = [t for t in tasks if t.kind == kind]
        if status:
            tasks = [t for t in tasks if t.status == status]
        if parent_id is not None:
            tasks = [t for t in tasks if t.parent_id == parent_id]
        elif not include_children:
            tasks = [t for t in tasks if t.parent_id is None]
        tasks.sort(key=lambda t: t.updated_at, reverse=True)
        return tasks[:limit]

    async def _evict(self) -> None:
        """Drop oldest completed tasks when over the cap (must hold _lock)."""
        if len(self._tasks) <= self.MAX_TASKS:
            return
        candidates = sorted(
            [t for t in self._tasks.values() if t.status not in ("running", "pending")],
            key=lambda t: t.updated_at,
        )
        for t in candidates[:max(1, len(self._tasks) - self.MAX_TASKS)]:
            del self._tasks[t.id]

    # ── Shared memory ──────────────────────────────────────────────────────

    async def write_memory(
        self, key: str, value: Any, *, written_by: str = "agent"
    ) -> None:
        key = str(key)[:120]
        async with self._get_lock():
            self._memory[key] = {
                "value": value,
                "updated_at": _utcnow(),
                "written_by": str(written_by)[:60],
            }
            if len(self._memory) > self.MAX_MEMORY_KEYS:
                oldest = sorted(self._memory.items(), key=lambda kv: kv[1].get("updated_at", ""))
                for k, _ in oldest[:20]:
                    del self._memory[k]
            await self._persist()
        await self._broadcast({"type": "memory_written", "key": key, "written_by": written_by})

    async def read_memory(self, prefix: Optional[str] = None) -> Dict[str, Any]:
        if prefix:
            return {k: v for k, v in self._memory.items() if k.startswith(str(prefix))}
        return dict(self._memory)

    async def delete_memory(self, key: str) -> bool:
        async with self._get_lock():
            if key in self._memory:
                del self._memory[key]
                await self._persist()
                await self._broadcast({"type": "memory_deleted", "key": key})
                return True
        return False

    async def clear_memory(self) -> None:
        async with self._get_lock():
            self._memory.clear()
            await self._persist()
        await self._broadcast({"type": "memory_cleared"})

    # ── SSE helpers ────────────────────────────────────────────────────────

    async def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=200)
        self._subscribers.add(q)
        return q

    async def unsubscribe(self, q: asyncio.Queue) -> None:
        self._subscribers.discard(q)

    async def _broadcast(self, event: Dict[str, Any]) -> None:
        dead = set()
        event.setdefault("ts", _utcnow())
        for q in set(self._subscribers):
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:
                dead.add(q)
        self._subscribers -= dead

    # ── Agent context summary ──────────────────────────────────────────────

    async def build_context_block(self, max_chars: int = 2500) -> str:
        """Summarize live tasks + recent findings for injection into agent prompts."""
        active = [t for t in self._tasks.values() if t.status in ("running", "pending")]
        recent = sorted(
            [t for t in self._tasks.values() if t.status in ("done", "error")],
            key=lambda t: t.updated_at, reverse=True,
        )[:6]

        lines = ["=== Multi-Task Memory (MTM) ==="]

        if active:
            lines.append(f"\nActive agent tasks ({len(active)}):")
            for t in active[:8]:
                lines.append(f"  [{t.status.upper()}] {t.kind}/{t.agent_role}: {t.title}")
                if t.findings:
                    lines.append(f"    → {t.findings[:150]}")

        if recent:
            lines.append("\nRecently completed tasks:")
            for t in recent:
                icon = "✓" if t.status == "done" else "✗"
                lines.append(f"  {icon} [{t.kind}] {t.title}")
                if t.findings:
                    lines.append(f"    → {t.findings[:150]}")

        mem_items = sorted(self._memory.items(), key=lambda kv: kv[1].get("updated_at", ""), reverse=True)[:8]
        if mem_items:
            lines.append("\nShared memory (recent entries):")
            for k, v in mem_items:
                val = v.get("value", "")
                by = v.get("written_by", "?")
                snippet = str(val)[:180] if not isinstance(val, str) else val[:180]
                lines.append(f"  [{k}] by {by}: {snippet}")

        return "\n".join(lines)[:max_chars]


mtm = MultiTaskMemory()

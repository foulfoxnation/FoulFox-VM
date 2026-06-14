"""Per-agent knowledge base — semantic retrieval + per-agent vector index.

Layers SEMANTIC retrieval and a per-agent vector index on top of the SQLite
``AgentLesson`` store (the durable source of truth) and the shared
``project_memory`` store. Each suite agent has a role
(``windows`` | ``game`` | ``architect``); ``shared`` is the cross-agent team
scope. Isolation is structurally guaranteed by the CALLER's SQL role filter
(``role in {agent, "shared"}``) — this module only RANKS the already-isolated
candidates and INDEXES writes under the producing agent's scope.

ChromaDB and fastembed are OPTIONAL and frequently absent, so retrieval degrades
gracefully across three tiers:

1. **Vector index** — a dedicated, per-agent NAMESPACED Chroma collection
   (:data:`AGENT_KB_COLLECTION`) when ChromaDB is healthy. Writes are routed
   here by scope (the lesson's role, or ``"shared"`` for project memory).
2. **On-the-fly cosine** — when an embedder (HTTP or local fastembed) is
   available but Chroma is not: embed the query + the isolated candidate rows
   and rank by cosine similarity. Embeddings are cached by ``(ref_id, hash)``.
3. **Keyword overlap** — when no embedder/vector store is available at all,
   :func:`rank_lessons` returns ``None`` so the caller applies its existing
   keyword fallback.

Every entry point is best-effort: any failure returns ``None`` / is a no-op so
the chat turn and the review loop never break.
"""
from __future__ import annotations

import hashlib
import logging
import time
from typing import Any, Dict, List, Optional, Sequence

import numpy as np

logger = logging.getLogger(__name__)

# Dedicated logical collection for the agent suite's knowledge base. Per-agent
# isolation is achieved by namespacing rows with a ``scope`` metadata field
# (the role, or "shared"), queried with a ``scope $in [role, "shared"]`` filter.
AGENT_KB_COLLECTION = "odysseus_agent_kb"

# Skip on-the-fly cosine when the candidate set is large, to bound per-turn
# latency; the keyword fallback handles those (rare) cases.
_COSINE_MAX_CANDIDATES = 256

# Re-probe an unavailable embedder / index at most this often (seconds) so a
# missing optional dependency does not cost a connect-timeout every turn.
_RETRY_INTERVAL = 60.0

_ROLES_SHARED = "shared"


def _scopes(role: str) -> List[str]:
    """Scopes an agent of ``role`` may read: its own role plus ``shared``."""
    return [_ROLES_SHARED] if role == _ROLES_SHARED else [role, _ROLES_SHARED]


# --------------------------------------------------------------------------
# Text + embedding helpers
# --------------------------------------------------------------------------
def _doc_text(item: Dict[str, Any]) -> str:
    """The text used to embed/rank a lesson or memory entry."""
    title = (item.get("title") or "").strip()
    # Lessons use "text"; memory entries use "content".
    body = (item.get("text") or item.get("content") or "").strip()
    tags = item.get("tags") or []
    if isinstance(tags, (list, tuple)):
        tag_str = " ".join(str(t) for t in tags)
    else:
        tag_str = str(tags)
    return "\n".join(p for p in (title, body, tag_str) if p)


def _hash(text: str) -> str:
    return hashlib.md5((text or "").encode("utf-8")).hexdigest()


def _to_matrix(vecs: Any) -> np.ndarray:
    """Coerce an encoder's output to a normalized 2-D float32 matrix."""
    arr = np.asarray(vecs, dtype="float32")
    if arr.ndim == 1:
        arr = arr.reshape(1, -1)
    if arr.size == 0:
        return arr
    norms = np.linalg.norm(arr, axis=1, keepdims=True)
    norms = np.where(norms == 0, 1.0, norms)
    return arr / norms


def _encode(embedder: Any, texts: Sequence[str]) -> np.ndarray:
    """Encode ``texts`` with ``embedder``, returning a normalized matrix."""
    if not texts:
        return np.array([], dtype="float32")
    try:
        raw = embedder.encode(list(texts), normalize_embeddings=True)
    except TypeError:
        # Encoders that do not accept the normalize kwarg.
        raw = embedder.encode(list(texts))
    return _to_matrix(raw)


# In-process embedding cache: (ref_id, content_hash) -> 1-D unit vector.
_emb_cache: Dict[tuple, np.ndarray] = {}
_EMB_CACHE_MAX = 2000


def _cache_get(key: tuple) -> Optional[np.ndarray]:
    return _emb_cache.get(key)


def _cache_put(key: tuple, vec: np.ndarray) -> None:
    if len(_emb_cache) >= _EMB_CACHE_MAX:
        _emb_cache.clear()
    _emb_cache[key] = vec


# --------------------------------------------------------------------------
# Embedder accessor (throttled, cached)
# --------------------------------------------------------------------------
_embedder: Any = None
_embedder_checked_at: float = -1e9


def _get_embedder() -> Any:
    """Return a cached embedding client, or ``None`` when unavailable.

    Never raises and never spams logs: a missing embedder is re-probed at most
    once per :data:`_RETRY_INTERVAL`.
    """
    global _embedder, _embedder_checked_at
    if _embedder is not None:
        return _embedder
    now = time.monotonic()
    if now - _embedder_checked_at < _RETRY_INTERVAL:
        return None
    _embedder_checked_at = now
    try:
        from src.embeddings import get_embedding_client
        client = get_embedding_client()
        if client is not None:
            _embedder = client
        return _embedder
    except Exception as e:  # pragma: no cover - defensive
        logger.debug("agent_kb embedder unavailable: %s", e)
        return None


# --------------------------------------------------------------------------
# Per-agent vector index (Chroma-backed, namespaced by scope metadata)
# --------------------------------------------------------------------------
class AgentKBIndex:
    """A namespaced vector store for the suite's lessons + shared memory.

    One logical collection (:data:`AGENT_KB_COLLECTION`) holds every agent's
    knowledge; rows carry ``{owner, scope, kind, ref_id}`` metadata so a query
    can be filtered to a single agent's scope (its role plus ``shared``). This
    is the per-agent "collection" expressed as a metadata namespace, which
    reuses the existing multi-lane embedding infrastructure.
    """

    def __init__(self) -> None:
        from src.embedding_lanes import build_embedding_lanes
        self.lanes = build_embedding_lanes(AGENT_KB_COLLECTION)
        if not self.lanes:
            raise RuntimeError("no embedding lanes available")

    @property
    def healthy(self) -> bool:
        return bool(self.lanes)

    @staticmethod
    def _doc_id(owner: Optional[str], kind: str, ref_id: str) -> str:
        return f"{kind}:{owner or '-'}:{ref_id}"

    def upsert(self, ref_id: str, text: str, owner: Optional[str],
               scope: str, kind: str) -> None:
        meta = {
            "owner": owner or "",
            "scope": scope,
            "kind": kind,
            "ref_id": ref_id,
        }
        doc_id = self._doc_id(owner, kind, ref_id)
        for lane in self.lanes:
            try:
                emb = lane.encode([text])
                lane.collection.upsert(
                    ids=[doc_id], documents=[text],
                    metadatas=[meta], embeddings=emb,
                )
            except Exception as e:  # pragma: no cover - chroma absent in dev
                logger.debug("agent_kb upsert lane failed: %s", e)

    def delete(self, ref_id: str, owner: Optional[str], kind: str) -> None:
        doc_id = self._doc_id(owner, kind, ref_id)
        for lane in self.lanes:
            try:
                lane.collection.delete(ids=[doc_id])
            except Exception as e:  # pragma: no cover - chroma absent in dev
                logger.debug("agent_kb delete lane failed: %s", e)

    def query(self, query: str, owner: Optional[str], scopes: Sequence[str],
              kinds: Sequence[str], n: int) -> List[str]:
        """Return ``ref_id``s most similar to ``query`` within ``scopes``."""
        from src.embedding_lanes import query_lanes, dedupe_results
        where = {"$and": [
            {"owner": owner or ""},
            {"scope": {"$in": list(scopes)}},
        ]}
        if kinds:
            where["$and"].append({"kind": {"$in": list(kinds)}})
        pairs = query_lanes(
            self.lanes, query, n_results=lambda _lane: n,
            include=["metadatas", "distances"], where=where,
        )
        rows: List[Dict[str, Any]] = []
        for _lane, res in pairs:
            metas = (res.get("metadatas") or [[]])[0]
            dists = (res.get("distances") or [[]])[0]
            for i, m in enumerate(metas):
                ref = (m or {}).get("ref_id")
                if not ref:
                    continue
                rows.append({
                    "ref_id": ref,
                    "distance": dists[i] if i < len(dists) else 1.0,
                })
        rows.sort(key=lambda r: r["distance"])
        deduped = dedupe_results(rows, id_key="ref_id", limit=n)
        return [r["ref_id"] for r in deduped if r.get("ref_id")]


_index: Optional[AgentKBIndex] = None
_index_checked_at: float = -1e9


def _get_index() -> Optional[AgentKBIndex]:
    """Return the per-agent vector index, or ``None`` when Chroma is down.

    Throttled like :func:`_get_embedder` so an absent ChromaDB is re-probed at
    most once per :data:`_RETRY_INTERVAL`.
    """
    global _index, _index_checked_at
    if _index is not None:
        return _index
    now = time.monotonic()
    if now - _index_checked_at < _RETRY_INTERVAL:
        return None
    _index_checked_at = now
    try:
        idx = AgentKBIndex()
        if idx.healthy:
            _index = idx
        return _index
    except Exception as e:
        logger.debug("agent_kb vector index unavailable: %s", e)
        return None


# --------------------------------------------------------------------------
# Ranking
# --------------------------------------------------------------------------
def _rank_via_cosine(embedder: Any, query: str,
                     candidates: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Return ALL candidates ordered by cosine similarity to ``query``."""
    qv = _encode(embedder, [query])
    if qv.size == 0:
        return list(candidates)
    qv = qv[0]

    vecs: List[Optional[np.ndarray]] = [None] * len(candidates)
    pending: List[int] = []
    keys: List[tuple] = []
    for i, c in enumerate(candidates):
        text = _doc_text(c)
        key = (c.get("id"), _hash(text))
        keys.append(key)
        cached = _cache_get(key)
        if cached is not None:
            vecs[i] = cached
        else:
            pending.append(i)
    if pending:
        mat = _encode(embedder, [_doc_text(candidates[i]) for i in pending])
        for j, i in enumerate(pending):
            v = mat[j] if j < mat.shape[0] else None
            vecs[i] = v
            if v is not None:
                _cache_put(keys[i], v)

    scored = []
    for i, c in enumerate(candidates):
        v = vecs[i]
        sim = float(np.dot(qv, v)) if v is not None else -1.0
        scored.append((sim, c.get("created_at") or "", c))
    scored.sort(key=lambda t: (t[0], t[1]), reverse=True)
    return [c for _s, _ts, c in scored]


def _merge_by_ids(order_ids: Sequence[str], candidates: List[Dict[str, Any]],
                  tail: Optional[List[Dict[str, Any]]]) -> List[Dict[str, Any]]:
    """Front-load candidates named in ``order_ids``; append the rest in ``tail``
    order (or candidate order). Guarantees no candidate is dropped when the
    vector index only covers part of the set."""
    by_id = {c.get("id"): c for c in candidates}
    out: List[Dict[str, Any]] = []
    seen = set()
    for rid in order_ids:
        c = by_id.get(rid)
        if c is not None and rid not in seen:
            out.append(c)
            seen.add(rid)
    for c in (tail if tail is not None else candidates):
        cid = c.get("id")
        if cid not in seen:
            out.append(c)
            seen.add(cid)
    return out


def rank_lessons(query: str, role: str, owner: Optional[str],
                 candidates: List[Dict[str, Any]], limit: int,
                 *, embedder: Any = None,
                 index: Optional[AgentKBIndex] = None
                 ) -> Optional[List[Dict[str, Any]]]:
    """Semantically rank the already role-isolated ``candidates``.

    ``candidates`` MUST already be filtered to the agent's scope by the caller;
    this function only orders them. Returns a list of up to ``limit`` lesson
    dicts, or ``None`` when no semantic backend is available (so the caller can
    fall back to keyword overlap).
    """
    if not candidates:
        return []
    q = (query or "").strip()
    if not q:
        return None  # nothing to rank against -> let caller pick recent/keyword

    emb = embedder if embedder is not None else _get_embedder()
    idx = index if index is not None else _get_index()
    if emb is None and idx is None:
        return None

    cosine_order: Optional[List[Dict[str, Any]]] = None
    if emb is not None and len(candidates) <= _COSINE_MAX_CANDIDATES:
        try:
            cosine_order = _rank_via_cosine(emb, q, candidates)
        except Exception as e:
            logger.debug("agent_kb cosine ranking failed: %s", e)

    if idx is not None:
        try:
            order_ids = idx.query(
                q, owner, _scopes(role), ["lesson"],
                n=max(limit * 4, len(candidates)),
            )
            # Only trust the index when it actually ranked something (or we have
            # a cosine tail to fall back on). An empty index result with no
            # embedder would otherwise return raw DB order — worse than letting
            # the caller keyword-rank.
            if order_ids or cosine_order is not None:
                merged = _merge_by_ids(order_ids, candidates, cosine_order)
                return merged[:limit]
        except Exception as e:
            logger.debug("agent_kb index query failed: %s", e)

    if cosine_order is not None:
        return cosine_order[:limit]
    return None


# --------------------------------------------------------------------------
# Write routing (best-effort; no-op when the vector index is down)
# --------------------------------------------------------------------------
def index_lesson(lesson: Dict[str, Any]) -> None:
    """Upsert a lesson into its agent's scope (its ``role``). Inactive lessons
    are removed instead. No-op when the vector index is unavailable."""
    idx = _get_index()
    if idx is None or not lesson:
        return
    ref_id = lesson.get("id")
    if not ref_id:
        return
    try:
        owner = lesson.get("owner")
        if not lesson.get("is_active", True):
            idx.delete(ref_id, owner, "lesson")
            return
        scope = lesson.get("role") or _ROLES_SHARED
        idx.upsert(ref_id, _doc_text(lesson), owner, scope, "lesson")
    except Exception as e:  # pragma: no cover - defensive
        logger.debug("agent_kb index_lesson failed: %s", e)


def unindex_lesson(lesson_id: str, owner: Optional[str]) -> None:
    idx = _get_index()
    if idx is None or not lesson_id:
        return
    try:
        idx.delete(lesson_id, owner, "lesson")
    except Exception as e:  # pragma: no cover - defensive
        logger.debug("agent_kb unindex_lesson failed: %s", e)


def index_lessons(lessons: Sequence[Dict[str, Any]]) -> None:
    """Best-effort bulk upsert (used after seeding). No-op when index is down."""
    idx = _get_index()
    if idx is None or not lessons:
        return
    for lesson in lessons:
        index_lesson(lesson)


def index_memory(note: Dict[str, Any]) -> None:
    """Upsert a project-memory entry into the SHARED team scope. No-op when the
    vector index is unavailable."""
    idx = _get_index()
    if idx is None or not note:
        return
    ref_id = note.get("id")
    if not ref_id:
        return
    try:
        idx.upsert(ref_id, _doc_text(note), note.get("owner"),
                   _ROLES_SHARED, "memory")
    except Exception as e:  # pragma: no cover - defensive
        logger.debug("agent_kb index_memory failed: %s", e)


def unindex_memory(note_id: str, owner: Optional[str]) -> None:
    idx = _get_index()
    if idx is None or not note_id:
        return
    try:
        idx.delete(note_id, owner, "memory")
    except Exception as e:  # pragma: no cover - defensive
        logger.debug("agent_kb unindex_memory failed: %s", e)

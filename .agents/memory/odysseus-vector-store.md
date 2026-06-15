---
name: Odysseus vector store (Chroma + fastembed)
description: How the Odysseus AI agent's semantic knowledge (RAG, vector memory, tool index, per-agent KB) is wired — embedded ChromaDB by default + local fastembed.
---

# Odysseus semantic knowledge: embedded by default

The agent's vector stack (document RAG, vector memory, tool index, per-agent KB
vector tier) is gated on two optional deps declared in
`artifacts/odysseus-service/requirements.txt`: **`chromadb`** (full, NOT
`chromadb-client`) + **`fastembed`**. If either is missing the agent silently
degrades to keyword search.

## ChromaDB defaults to EMBEDDED, not a server
`get_chroma_client()` (the single chokepoint every store routes through) defaults
to an in-process `chromadb.PersistentClient(path=CHROMA_DIR)` (= `DATA_DIR/chroma`).
It only uses `chromadb.HttpClient` when an external service is explicitly
configured via `CHROMADB_HOST`, `CHROMADB_MODE=http|server|remote`, or a truthy
`CHROMADB_SERVER`. The TCP port-probe + `heartbeat()` live ONLY in the HTTP branch.
**Why:** FoulFox is a self-contained bootable appliance; requiring a sidecar/docker
Chroma server contradicts that and adds a fragile moving part. Embedded persists
under the appliance's `ODYSSEUS_DATA_DIR` partition with zero ops.
**Why full `chromadb`:** `chromadb-client` is HTTP-client-only — it has neither a
server nor `PersistentClient`, so embedded mode needs the full package.

## Constraints / gotchas
- **Single process per data dir.** Embedded Chroma is a local store, not a
  multi-process DB. Keep ONE uvicorn worker (start.sh launches one) per
  `DATA_DIR/chroma`. Multiple workers/processes sharing the path → sqlite lock
  corruption. Use HTTP Chroma if you ever need multi-process.
- **Migration caveat:** a deployment that previously relied on the old implicit
  `localhost:8100` HttpClient default (without setting `CHROMADB_HOST`) will now
  start a fresh empty embedded store — old remote vectors won't appear. Set
  `CHROMADB_HOST`/`CHROMADB_MODE=http` to keep the prior behavior.

## Embedder: fastembed (local ONNX), no server needed
`src/embeddings.get_embedding_client()` tries an HTTP endpoint (`EMBEDDING_URL`)
first, else falls back to local fastembed (`sentence-transformers/all-MiniLM-L6-v2`,
384-dim, ~91MB downloaded once to `FASTEMBED_CACHE_DIR = DATA_DIR/fastembed_cache`).
The per-agent KB's tier-2 cosine ranking (`agent_kb._get_embedder` → cosine) needs
ONLY this embedder, NOT Chroma — so fastembed alone upgrades agent-lesson retrieval
from keyword → semantic even with Chroma absent.

## Verifying after a dep upgrade
Smoke (isolate Chroma to a temp dir by monkeypatching `chroma_client.CHROMA_DIR`
so you don't collide with the running service): `get_embedding_client()` encodes
384-dim, `get_chroma_client()` returns a client, `build_embedding_lanes()` yields a
fastembed lane, `VectorRAG(...).healthy` is True. Live service logs should show
`ChromaDB ready (embedded)` + `FastEmbed loaded`.

---
name: Running odysseus-service pytest
description: How to run the Python test suite for artifacts/odysseus-service in this repl.
---

# Running the odysseus-service test suite

Run from `artifacts/odysseus-service` with an explicit in-memory SQLite URL:
```
cd artifacts/odysseus-service && DATABASE_URL='sqlite:///:memory:' python -m pytest tests/ -q
```

**Why DATABASE_URL must be overridden:** the workspace `DATABASE_URL` points at
the api-server's Postgres, but `psycopg2` is NOT installed for the workspace
`python3`. `core.database` calls `create_engine` at import time, so without the
override pytest dies during collection with `ModuleNotFoundError: psycopg2`.
Odysseus is self-contained SQLite (its `start.sh` unsets `DATABASE_URL` for the
same reason). `conftest.py` only `setdefault`s the in-memory URL, so an inherited
Postgres URL still wins unless you pass it explicitly.

**Test deps:** `pytest` and `pytest-asyncio` are NOT pre-installed. Install with
the `--target` method (see python-deps-install.md). `pyproject.toml` sets
`asyncio_mode`, so the suite has `@pytest.mark.asyncio` async tests that ERROR
("async def not natively supported") if `pytest-asyncio` is missing — that error
is an env gap, not a code regression.

**DB-backed unit tests** use a temp-file SQLite engine + a private `sessionmaker`
and monkeypatch the module's `SessionLocal` (pattern in
`tests/test_archived_sessions_model_filter.py` and `tests/test_agent_kb.py`).

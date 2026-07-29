---
name: Odysseus Multi-Task Memory (MTM)
description: Architecture and integration points for the MTM system — process-global coordination layer for all agents.
---

## What MTM is

`src/mtm.py` — A process-global singleton (`mtm = MultiTaskMemory()`) that acts as:
1. Task registry — all in-flight/recent agent tasks (discover, worker, scheduled, manual)
2. Shared key-value scratchpad — cross-agent findings (any agent reads/writes)
3. SSE broadcast bus — asyncio.Queue per subscriber for real-time shell UI updates
4. JSON persistence — writes to ODYSSEUS_DATA_DIR/mtm.json (survives restarts)

## Integration points

- **Startup**: `app.py` `_startup_event()` calls `await mtm.load()` (non-critical, non-blocking)
- **REST API**: `routes/mtm_routes.py` mounted at `/api/mtm` in app.py
- **SSE stream**: `GET /api/mtm/stream` sends snapshot on connect + events on changes
- **Agent tools**: `discover` (tool_implementations.py `do_discover`) + `read_mtm` (`do_read_mtm`)
- **Tool dispatch**: wired in `tool_execution.py` before `spawn_subagents` branch
- **Always available**: both `discover` and `read_mtm` in `ALWAYS_AVAILABLE` in tool_index.py

## Agent roles

- `planner` (sort=4) — decomposes goals, calls discover, synthesizes via read_mtm
- `discovery` (sort=5) — read-only investigator, writes findings to MTM shared memory

## Shell UI

`AgentTasksPanel.tsx` — SSE-connected "Agents" tab in taskbar:
- Receives snapshot on connect; handles task_created/task_updated/memory_* events
- Shows task tree (parent → children), kind badges, status icons, findings preview
- Memory tab shows key-value scratchpad with expand/collapse
- Reconnects automatically on disconnect (4s backoff)
- URL: `/api/odysseus/api/mtm/stream`

## Task concurrency

TaskScheduler semaphore raised from 1 → 4 (background tasks can now run concurrently).

**Why:** Discovery sub-agents are independent per session; the existing _executing set + lock prevent double-dispatch regardless of concurrency.

**How to apply:** If you need to lower concurrency for any reason, change `_run_semaphore = asyncio.Semaphore(4)` and `_concurrency_cap = 4` in task_scheduler.py.

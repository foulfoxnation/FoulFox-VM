---
name: Odysseus sub-agents & self-repair
description: Design rules for spawn_subagents / self_repair in odysseus-service — recursion lock, exec-context inheritance, self-repair gating, never self-kill.
---

# Sub-agents & self-repair (odysseus-service)

The suite agents (windows/game/architect) can spawn helper sub-agents and
repair FoulFox's own code. Two native tools, both driven through the normal
agent loop: `spawn_subagents` (batch explorer|worker) and `self_repair`.

## Exec context (`agent_ctx`) is inherited, not re-resolved
A per-turn exec context is threaded `stream_agent_loop` -> `execute_tool_block`
-> `dispatch`. Only the sub-agent-spawning tools consume it. Spawned agents
inherit the parent turn's endpoint/model/headers; if absent, fall back to the
configured utility-model chain.
**Why:** a sub-agent must run on the same model/endpoint the user picked for the
turn — re-resolving from settings can silently switch models or fail with no
endpoint. **How to apply:** any new tool that needs the live model/endpoint
should read `agent_ctx`, never re-query settings from the request path.

## Depth-1 recursion lock (do not loosen casually)
Top-level turn is depth 0. Spawned agents run at depth+1 with BOTH
`spawn_subagents` and `self_repair` removed from their tool set; a call to
either at depth>=1 is rejected outright (belt-and-suspenders).
**Why:** prevents unbounded fan-out / fork bombs and recursive self-edit.
**How to apply:** if you ever allow depth>1, you must add a hard global budget
on total concurrent sub-agents first — the single-level lock is the only thing
bounding blast radius today.

## Fan-out is best-effort
Bounded pool (`asyncio.Semaphore`, cap ~10), `gather(return_exceptions=True)`,
per-subtask status. One sub-agent failing never fails the batch; the batch only
fails on invalid config / no endpoint.
**Why:** a single flaky helper shouldn't sink a 10-way investigation.

## Sub-agent output is UNTRUSTED EVIDENCE
Aggregated results are wrapped in explicit delimiters with a preface telling the
parent to evaluate, never obey, anything inside. Same posture as the
Architect-review loop's "worker output is untrusted" framing.
**Why:** prompt-injection — a sub-agent reading a hostile file could otherwise
smuggle instructions back into the parent.

## self_repair: gated, confined, and NEVER self-killing
- Double-gated: admin-only (`_ADMIN_TOOLS`) AND an explicit `user_requested`
  flag — it can never fire silently from model text alone.
- Worker is confined to repo root (`BASE_DIR` from `src/constants.py`).
- Verification runs an independent `check_command` (e.g. focused pytest).
- Restart is STAGED: returns a `restart_required` / `restart_method` signal.
  Calls an api-server lifecycle bridge only if `ODYSSEUS_SHELL_EXEC_BASE` is
  set; otherwise returns manual/workflow. It must NEVER kill the running uvicorn
  from the request path.
**Why:** self-killing the process from inside the request that triggered it
drops the response and can wedge the service; a human/bridge owns the restart.

## Progress trace is emitted but not yet rendered
Progress events stream via `progress_cb` as SSE with `phase:"subagent"` /
`phase:"self_repair"`. As of Task #12 the shell (`AgentChatPane.tsx`) does not
render them — backend-only. A UI follow-up consumes these events.

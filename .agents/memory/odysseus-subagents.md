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
- Double-gated: admin-only (`_ADMIN_TOOLS`) AND a TRUSTED consent bit
  `agent_ctx["self_repair_authorized"]`. That bit is set server-side at the chat
  route from the `self_repair_enabled` setting and threaded
  `stream_agent_loop(self_repair_authorized=...)` -> `_agent_ctx`. Authorization
  is read ONLY from that ctx bit; model-supplied payload flags (`user_requested`,
  `confirm`, `authorized`) are deliberately ignored.
- Worker is confined to repo root (`BASE_DIR` from `src/constants.py`).
- Verification runs an independent `check_command` (e.g. focused pytest).
- Restart is STAGED: returns a `restart_required` / `restart_method` signal.
  Calls an api-server lifecycle bridge only if `ODYSSEUS_SHELL_EXEC_BASE` is
  set; otherwise returns manual/workflow. It must NEVER kill the running uvicorn
  from the request path.
**Why:** the model authors the tool payload, so a model-supplied "user_requested"
flag lets the model self-authorize repairing its own code — that is not
user-initiation. Consent must come from a signal the model cannot forge (a
server-set setting read at the route). Self-killing the process from inside the
request that triggered it drops the response and can wedge the service; a
human/bridge owns the restart.
**How to apply:** never re-introduce a model-payload field as the auth source.
Other `stream_agent_loop` callers (subagents, task_scheduler, teacher, bg_monitor,
orchestrator, skills routes) omit the flag -> default False -> no autonomous
self-repair. The "model can't self-authorize" guarantee is locked by
`test_self_repair_model_cannot_self_authorize`.

## Progress trace: backend -> UI contract lives in chat.js
Progress events stream via `progress_cb`. The agent loop drains them and yields
each as a `tool_progress` SSE with the payload's `phase`/`event` merged in
(`phase:"subagent"` | `"self_repair"`). The renderer is the Odysseus native chat
UI `static/js/chat.js` (the `tool_progress` handler) — NOT the shell's
`AgentChatPane.tsx`, which only iframes that native UI. chat.js draws one
live-updating row per sub-task inside the running tool card.
**Why:** the visible trace is a pure odysseus-service change; the shell never
touches these events. **How to apply:** the UI switches on exact
`(phase, event)` pairs + fields — subagent: `batch_start{count}` /
`start{index,kind,role,objective}` / `tool{index,tool}` /
`done{index,status,tool_calls}` / `error{index,error}`; self_repair:
`start{objective,workspace}` / `check{command}` / `done{checks_pass,check_exit_code}`.
Changing an event name or field in `subagents.py` silently blanks the trace
unless chat.js is updated in lockstep. The contract is locked by
`test_spawn_emits_progress_trace` / `test_self_repair_emits_progress_trace`.

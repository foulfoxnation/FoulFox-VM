---
name: MCP stdio crash containment
description: Why odysseus-service crash-looped (exit 3) on offline appliance boot and the owner-task pattern that contains it
---

**Rule:** every MCP stdio connection must open AND close its `stdio_client`/`ClientSession` inside one dedicated owner task; the owner swallows all post-startup exceptions.

**Why:** `mcp.client.stdio` uses an internal anyio task group. If a server subprocess dies mid-handshake or teardown crosses tasks (stored AsyncExitStack closed elsewhere), anyio raises "Attempted to exit cancel scope in a different task than it was entered in" — this cascades cancellations through the loop and kills uvicorn (systemd exit status 3, crash loop). Observed on FoulFox OS build #60 offline first boot; a failing builtin server took down the whole AI service.

**How to apply:** `_connect_stdio` in `src/mcp_manager.py` spawns an owner task publishing `(session, tools)` via a future and holding contexts until a stop event; `self._stacks[id]` stores `("owner-task", stop, task)` and `disconnect_server` handles both shapes. Never revert to storing a raw AsyncExitStack for stdio. Test containment with `/bin/false` and a nonexistent binary as MCP commands — connect must return False and the loop must survive. The NPX pre-cache check in `builtin_mcp.py` guards the same trap for npx servers.

Also: foulfox user is in `systemd-journal`+`adm` (0010 hook) so on-device `journalctl -u <svc>` works — earlier "no entries" was a permissions illusion.

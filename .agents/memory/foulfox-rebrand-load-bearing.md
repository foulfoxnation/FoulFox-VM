---
name: FoulFox rebrand — load-bearing strings
description: When renaming the FoulFox product name in the UI, which literal strings must NOT be renamed because external systems / existing data match on them.
---

# Rebranding the FoulFox product name

The product display name has been renamed twice (Odysseus → "FoulFox VM" → "FoulFox OS"). A blind global `sed` of the brand name across the whole repo is unsafe.

**Rule:** rename brand strings only in the frontends (odysseus-shell `src` + `index.html`, odysseus-service `static/`) and UI-surfaced backend messages (api-server `odysseus-*` route response strings, served auth/grant HTML page `<title>`s). Do NOT rename the load-bearing literals below.

**Load-bearing — leave as-is:**
- Email reminder subject `Reminder (FoulFox VM):` — used to *search/match existing reminder emails over IMAP*. The code already dual-matches old + `Reminder (Odysseus):`. Renaming the setter without adding the old value to every search filter orphans existing emails.
- TOTP issuer string — baked into already-enrolled authenticator entries.
- MCP `client_name` — an OAuth client identifier registered with MCP servers.
- ntfy / webhook test-ping strings — operational identifiers, not titles.
- DB default suite name (`*_Suite`) — a stored default value, not a visible title; the shell SetupWizard supplies the user-facing default.

**Why:** these strings are matched by external systems or against previously-stored data; changing them silently breaks matching rather than just relabeling.

**How to apply:** treat the brand rename as "frontend titles only" unless the user explicitly asks for a full product-wide rename, in which case the email-subject matching needs backward-compat handling first.

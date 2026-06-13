---
name: FoulFox VM rebrand scope (Odysseus → FoulFox VM)
description: Policy for the product rename — which "Odysseus" strings are brand (rename) vs load-bearing identifiers (never rename).
---

The product was renamed Odysseus → "FoulFox VM". Rebrand rule: change strings the
user actually SEES rendered (pages, emails, push/webhook payloads, API error
messages, OAuth consent screens, agent-suite role identity). Leave everything else.

**Load-bearing — never rename (renaming silently breaks behavior):**
- `X-Odysseus-*` email headers. The send side and the IMAP search/cleanup side must
  stay in sync. **Why:** reminders are matched primarily by `X-Odysseus-Kind: reminder`;
  the email *subject* "Reminder (…):" is only a fallback for providers that strip
  custom headers. If you change the send subject you MUST add the new subject to
  every reminder search/cleanup query while keeping the old one for legacy mail —
  otherwise header-stripped reminders stop being found.
- `ODYSSEUS_*` env vars, routes, directory names, code identifiers, CSS classes,
  event names, log namespace tags like `[odysseus]`.

**Intentionally kept (not the brand):**
- Literary persona: the `odysseus` character preset + Odyssey quotes + test fixtures.
- LLM-facing tool-schema descriptions and system prompts (EXCEPT the agent-suite role
  identity, which is user-visible and was rebranded).
- Pure machine-to-machine telemetry/attribution: `X-OpenRouter-Title`, `User-Agent`.

**Non-obvious data flow:** the agent-suite role display names (in `agent_suite.py`)
feed BOTH the setup wizard AND the persisted DB session/crew names — change the role
name and both surfaces update.

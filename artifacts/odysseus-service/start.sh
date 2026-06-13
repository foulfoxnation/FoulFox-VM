#!/usr/bin/env bash
# Odysseus startup wrapper — exports Replit AI credentials and Express API bridge config
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Map Replit AI Anthropic integration key to OpenAI-compat OPENAI_API_KEY
if [ -n "$AI_INTEGRATIONS_ANTHROPIC_API_KEY" ] && [ -z "$OPENAI_API_KEY" ]; then
  export OPENAI_API_KEY="$AI_INTEGRATIONS_ANTHROPIC_API_KEY"
fi

# Set Replit AI OpenAI-compatible base URL if not already configured.
if [ -z "$OPENAI_BASE_URL" ]; then
  export OPENAI_BASE_URL="https://openai-proxy.replit.com/v1"
fi

# Default model: claude-sonnet-4-5 via the Replit AI proxy
if [ -z "$OPENAI_MODEL" ]; then
  export OPENAI_MODEL="claude-sonnet-4-5"
fi

# ── Odysseus → Express API server shell/exec bridge ───────────────────────────
# IMPORTANT: Do NOT set ODYSSEUS_INTERNAL_BASE here. That variable is used
# by ALL Odysseus internal tool calls (/api/cookbook, /api/model, etc.) and
# must continue to point at Odysseus itself (127.0.0.1:7000).
#
# ODYSSEUS_SHELL_EXEC_BASE is a dedicated override for /api/shell/exec only.
# tool_implementations.py reads it via _SHELL_EXEC_BASE to route shell commands
# to the Express API server while leaving all other internal calls on Odysseus.
#
# ODYSSEUS_SHELL_EXEC_BASE is set by Electron main.cjs (or manually).
# ODYSSEUS_BRIDGE_TOKEN carries the shared CSRF token the Express server accepts
# via X-Odysseus-Internal-Token (the header Odysseus adds to all internal calls
# through ODYSSEUS_INTERNAL_TOKEN).
if [ -n "$ODYSSEUS_BRIDGE_TOKEN" ] && [ -z "$ODYSSEUS_INTERNAL_TOKEN" ]; then
  export ODYSSEUS_INTERNAL_TOKEN="$ODYSSEUS_BRIDGE_TOKEN"
fi

exec python -m uvicorn app:app \
  --host "${HOST:-127.0.0.1}" \
  --port "${PORT:-7000}" \
  --log-level info

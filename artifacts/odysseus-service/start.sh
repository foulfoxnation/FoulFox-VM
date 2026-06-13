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

# ── Odysseus → Express API server bridge ──────────────────────────────────────
# When running alongside the Windows Odysseus Express API server, route Odysseus's
# internal API calls (shell/exec, cookbook, etc.) to the Express server instead of
# looping back to itself. This allows Odysseus tools to execute shell commands via
# the Express shell/exec endpoint which manages VM SSH/serial session routing.
#
# ODYSSEUS_SHELL_BASE is set by Electron main.cjs (or by the user manually).
# If set, use it as ODYSSEUS_INTERNAL_BASE so tool_implementations.py routes
# /api/shell/exec calls to the Express server.
if [ -n "$ODYSSEUS_SHELL_BASE" ] && [ -z "$ODYSSEUS_INTERNAL_BASE" ]; then
  export ODYSSEUS_INTERNAL_BASE="$ODYSSEUS_SHELL_BASE"
fi

# Pass the shared internal token to Odysseus so its _internal_headers() includes
# X-Odysseus-Internal-Token, which the Express server accepts for shell/VM auth.
if [ -n "$ODYSSEUS_BRIDGE_TOKEN" ] && [ -z "$ODYSSEUS_INTERNAL_TOKEN" ]; then
  export ODYSSEUS_INTERNAL_TOKEN="$ODYSSEUS_BRIDGE_TOKEN"
fi

exec python -m uvicorn app:app \
  --host "${HOST:-127.0.0.1}" \
  --port "${PORT:-7000}" \
  --log-level info

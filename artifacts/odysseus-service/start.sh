#!/usr/bin/env bash
# Odysseus startup wrapper — exports Replit AI credentials as OpenAI-compat vars
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Map Replit AI Anthropic integration key to OpenAI-compat OPENAI_API_KEY
if [ -n "$AI_INTEGRATIONS_ANTHROPIC_API_KEY" ] && [ -z "$OPENAI_API_KEY" ]; then
  export OPENAI_API_KEY="$AI_INTEGRATIONS_ANTHROPIC_API_KEY"
fi

# Set Replit AI OpenAI-compatible base URL if not already configured.
# This routes requests through Replit's AI proxy to claude-sonnet-4-5.
if [ -z "$OPENAI_BASE_URL" ]; then
  export OPENAI_BASE_URL="https://openai-proxy.replit.com/v1"
fi

# Default model: claude-sonnet-4-5 via the Replit AI proxy
if [ -z "$OPENAI_MODEL" ]; then
  export OPENAI_MODEL="claude-sonnet-4-5"
fi

exec python -m uvicorn app:app \
  --host "${HOST:-127.0.0.1}" \
  --port "${PORT:-7000}" \
  --log-level info

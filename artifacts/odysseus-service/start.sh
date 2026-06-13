#!/usr/bin/env bash
# Odysseus startup wrapper — exports Replit AI credentials as OpenAI-compat vars
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# In Replit dev: map Replit AI Anthropic integration to OpenAI-compat vars
if [ -n "$AI_INTEGRATIONS_ANTHROPIC_API_KEY" ]; then
  export OPENAI_API_KEY="$AI_INTEGRATIONS_ANTHROPIC_API_KEY"
fi

exec python -m uvicorn app:app \
  --host "${HOST:-127.0.0.1}" \
  --port "${PORT:-7000}" \
  --log-level info

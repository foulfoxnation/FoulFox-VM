#!/usr/bin/env bash
# Odysseus startup wrapper — sets up a local Python venv on first launch,
# exports Replit AI credentials, and configures the Express API bridge.
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ── Python venv bootstrap ─────────────────────────────────────────────────────
# Creates a venv and installs requirements on first run so the packaged Electron
# distributable is self-contained without bundling a pre-built Python environment.
# Requires Python 3.9+ to be available on the host system.
VENV_DIR="$SCRIPT_DIR/.venv"
PY_BIN="${ODYSSEUS_PYTHON:-python3}"

if [ ! -f "$VENV_DIR/bin/activate" ]; then
  echo "[odysseus] Creating Python venv at $VENV_DIR ..."
  "$PY_BIN" -m venv "$VENV_DIR"
fi

# shellcheck disable=SC1091
source "$VENV_DIR/bin/activate"

# Install / upgrade requirements whenever the venv is present but potentially stale.
# --quiet keeps logs clean; pip's own dependency resolver avoids redundant work.
if [ -f "$SCRIPT_DIR/requirements.txt" ]; then
  pip install --quiet --upgrade pip
  pip install --quiet -r "$SCRIPT_DIR/requirements.txt"
fi

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
# ODYSSEUS_SHELL_EXEC_BASE is a dedicated override so only /api/shell/exec calls
# are routed to Express; all other internal Odysseus calls (_INTERNAL_BASE:
# /api/cookbook, /api/model, etc.) continue to resolve to Odysseus itself.
# ODYSSEUS_BRIDGE_TOKEN is the shared CSRF token forwarded as ODYSSEUS_INTERNAL_TOKEN
# so Odysseus's _internal_headers() includes X-Odysseus-Internal-Token for auth.
if [ -n "$ODYSSEUS_BRIDGE_TOKEN" ] && [ -z "$ODYSSEUS_INTERNAL_TOKEN" ]; then
  export ODYSSEUS_INTERNAL_TOKEN="$ODYSSEUS_BRIDGE_TOKEN"
fi

exec python -m uvicorn app:app \
  --host "${HOST:-127.0.0.1}" \
  --port "${PORT:-7000}" \
  --log-level info

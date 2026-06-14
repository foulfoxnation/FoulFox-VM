#!/usr/bin/env bash
# Odysseus startup wrapper — selects a Python interpreter, exports Replit AI
# credentials, and configures the Express API bridge.
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ── Python interpreter selection ──────────────────────────────────────────────
# Replit workspace (dev): use the system `python3`; its dependencies are managed
#   in the workspace .pythonlibs. Creating a venv here would hide those packages.
# Packaged / standalone build: create a self-contained venv on first launch and
#   install requirements into it so the distributable needs no pre-built env.
PY="python3"
if [ -n "$REPL_ID" ] || [ -n "$REPLIT_DEV_DOMAIN" ]; then
  # Replit workspace: bind to 0.0.0.0 so the workflow port detector sees the
  # service. Port 7000 is not a registered artifact, so it stays internal to the
  # container and is only reached through the Express API server proxy.
  export HOST="${HOST:-0.0.0.0}"
else
  VENV_DIR="$SCRIPT_DIR/.venv"
  PY_BOOT="${ODYSSEUS_PYTHON:-python3}"
  if [ ! -f "$VENV_DIR/bin/activate" ]; then
    echo "[odysseus] Creating Python venv at $VENV_DIR ..."
    "$PY_BOOT" -m venv "$VENV_DIR"
  fi
  # shellcheck disable=SC1091
  source "$VENV_DIR/bin/activate"
  if [ -f "$SCRIPT_DIR/requirements.txt" ]; then
    pip install --quiet --upgrade pip
    pip install --quiet -r "$SCRIPT_DIR/requirements.txt"
  fi
  PY="python"
fi

# ── Self-contained local datastore ────────────────────────────────────────────
# Odysseus is a self-contained desktop agent: it keeps all of its state in its
# own local SQLite store (DATA_DIR/app.db). Unset any inherited DATABASE_URL
# (e.g. the workspace Postgres used by the Express API server) so Odysseus does
# not try to share that database or require a Postgres driver.
unset DATABASE_URL

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

# Dev/standalone fallback for the shell-exec bridge. The Electron lifecycle
# always exports ODYSSEUS_SHELL_EXEC_BASE explicitly (pointing at the Express
# API server), so the `-z` guard leaves the packaged app untouched. The Replit
# dev workflow launches this script with no such env, which would otherwise let
# ODYSSEUS_SHELL_EXEC_BASE fall back to Odysseus's own origin — making the agent's
# /api/shell/exec and /api/vm/list calls 404 against Odysseus instead of reaching
# the VM registry. Point them at the API server (default port 8080) so VM-target
# selection and VM-scoped shell tools work in dev exactly as they do when packaged.
if [ -z "$ODYSSEUS_SHELL_EXEC_BASE" ]; then
  export ODYSSEUS_SHELL_EXEC_BASE="http://127.0.0.1:${API_SERVER_PORT:-8080}"
fi

exec "$PY" -m uvicorn app:app \
  --host "${HOST:-127.0.0.1}" \
  --port "${PORT:-7000}" \
  --log-level info

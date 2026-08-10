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
  # Dev fallback: PORT is the workflow-assigned port and is safe to honor here.
  PORT_FALLBACK="${PORT:-7000}"
else
  VENV_DIR="$SCRIPT_DIR/.venv"
  PY_BOOT="${ODYSSEUS_PYTHON:-python3}"
  if [ ! -f "$VENV_DIR/bin/activate" ]; then
    echo "[odysseus] Creating Python venv at $VENV_DIR ..."
    "$PY_BOOT" -m venv "$VENV_DIR"
  fi
  # shellcheck disable=SC1091
  source "$VENV_DIR/bin/activate"
  # Install deps only once. The packaged image's build hook pre-provisions this
  # venv and stamps a sentinel, so we do NOT reinstall on every boot — that would
  # crash an offline first boot (no PyPI) and, with Restart=on-failure, crash-loop
  # the service. `set -e` must not abort here when pip fails offline; the
  # build-provisioned venv is already usable, so the install runs inside an `if`.
  DEPS_STAMP="$VENV_DIR/.foulfox-deps-installed"
  if [ ! -f "$DEPS_STAMP" ] && [ -f "$SCRIPT_DIR/requirements.txt" ]; then
    if pip install --quiet --upgrade pip \
       && pip install --quiet -r "$SCRIPT_DIR/requirements.txt"; then
      touch "$DEPS_STAMP"
    else
      echo "[odysseus] WARNING: dependency install skipped (offline?); using the pre-provisioned venv." >&2
    fi
  fi
  PY="python"

  # ── Appliance: single-user desktop, no login screen ─────────────────────────
  # Odysseus's built-in multi-user login (AUTH_ENABLED) defaults to ON, but on
  # the appliance no user account ever gets created, so every Workspace page
  # request 302-loops to /login and every API call 401s ("Setup required") —
  # the Workspace looks dead even though the service is healthy. Dev already
  # runs with AUTH_ENABLED=false (the api-server lifecycle sets it explicitly);
  # mirror that here for the packaged appliance. The service binds loopback
  # only and is fronted by the api-server's shell-token gate, which is the
  # appliance's actual auth boundary. An explicit AUTH_ENABLED in
  # /etc/foulfox/foulfox.env still wins over this default.
  export AUTH_ENABLED="${AUTH_ENABLED:-false}"

  # ── Shared bridge token (Odysseus → api-server cross-service auth) ───────────
  # Odysseus starts BEFORE the api-server (foulfox-api.service has
  # After=odysseus-service.service). We generate a random token once, write it
  # to a file in ODYSSEUS_DATA_DIR that both services can read, then export it
  # so core/middleware.py picks it up as ODYSSEUS_INTERNAL_TOKEN. The api-server
  # reads the same file at startup so requireStateChangeToken can accept Odysseus
  # bridge calls (e.g. POST /api/apps/:id/start triggered from the Apps panel).
  # Without this, ODYSSEUS_BRIDGE_TOKEN is undefined in the api-server and every
  # Odysseus-initiated state-change is rejected with 401.
  _DATA_DIR="${ODYSSEUS_DATA_DIR:-/var/lib/foulfox}"
  _BRIDGE_TOKEN_FILE="$_DATA_DIR/odysseus-bridge-token"
  if [ ! -s "$_BRIDGE_TOKEN_FILE" ]; then
    mkdir -p "$_DATA_DIR"
    openssl rand -hex 32 > "$_BRIDGE_TOKEN_FILE" 2>/dev/null \
      || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' | head -c 64 > "$_BRIDGE_TOKEN_FILE"
    chmod 600 "$_BRIDGE_TOKEN_FILE" 2>/dev/null || true
  fi
  export ODYSSEUS_INTERNAL_TOKEN="${ODYSSEUS_INTERNAL_TOKEN:-$(cat "$_BRIDGE_TOKEN_FILE" 2>/dev/null)}"
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
#
# IMPORTANT: gate the Replit AI proxy to the Replit dev environment ONLY.
# On the appliance the proxy is unreachable (off-platform), so setting
# OPENAI_BASE_URL to openai-proxy.replit.com means every fallback request
# tries a dead cloud URL instead of the baked local Ollama.  On the
# appliance, prefer local Ollama (FOULFOX_LOCAL_OLLAMA=1); if local Ollama
# is not configured either, leave the var unset so the agent surfaces a
# clean "no model configured" state instead of silently hammering a
# dead endpoint.
if [ -z "$OPENAI_BASE_URL" ]; then
  if [ -n "$REPL_ID" ] || [ -n "$REPLIT_DEV_DOMAIN" ]; then
    # Replit dev workspace: use the Replit AI proxy.
    export OPENAI_BASE_URL="https://openai-proxy.replit.com/v1"
  elif [ "${FOULFOX_LOCAL_OLLAMA:-0}" = "1" ]; then
    # Appliance with baked Ollama: point directly at local Ollama's
    # OpenAI-compatible surface so env-based fallbacks work immediately,
    # even before the bootstrap finishes provisioning the suite.
    export OPENAI_BASE_URL="http://127.0.0.1:11434/v1"
  fi
  # Otherwise leave OPENAI_BASE_URL unset — no cloud fallback on appliance.
fi

# Default model.  Match the env-based AI URL chosen above so the model and
# endpoint stay in sync for any caller that reads both vars directly.
if [ -z "$OPENAI_MODEL" ]; then
  if [ -n "$REPL_ID" ] || [ -n "$REPLIT_DEV_DOMAIN" ]; then
    export OPENAI_MODEL="claude-sonnet-4-5"
  elif [ "${FOULFOX_LOCAL_OLLAMA:-0}" = "1" ]; then
    export OPENAI_MODEL="${FOULFOX_LOCAL_MODEL:-llama3.1:8b-instruct-q4_K_M}"
  fi
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

# Port selection: ODYSSEUS_PORT beats PORT. On the appliance, systemd's
# EnvironmentFile (/etc/foulfox/foulfox.env) sets PORT=8080 for the api-server
# and ALWAYS overrides the unit's Environment=PORT=7000 (systemd reads
# EnvironmentFile after Environment=, regardless of order in the unit file) —
# with PORT alone Odysseus binds 8080, collides with the api-server, and
# crash-loops with "address already in use". Older flashed images don't have
# ODYSSEUS_PORT in foulfox.env at all, so the packaged path must NEVER fall
# back to PORT: it is always the api-server's port there. PORT is honored
# only in the Replit dev branch above (PORT_FALLBACK).
exec "$PY" -m uvicorn app:app \
  --host "${HOST:-127.0.0.1}" \
  --port "${ODYSSEUS_PORT:-${PORT_FALLBACK:-7000}}" \
  --log-level info

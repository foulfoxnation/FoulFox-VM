#!/usr/bin/env bash
# E2E check for the FoulFox App runtime (Task #27 rev2 security hardening).
#
# Installs a tiny dummy Node app via the zip-upload route, then exercises the
# full runtime + security surface:
#   supervised start, /healthz, fixed port range, crash-restart with backoff,
#   tokenless POST through the UI proxy, foreign-Origin write refusal,
#   app-process session-token denial (socket-peer check), CORS refusal,
#   stop, uninstall.
#
# Usage: BASE=http://localhost:80 bash scripts/e2e-dummy-app.sh
# Requires: curl, python3 (zip packing), a running api-server.

set -u
BASE="${BASE:-http://localhost:80}"
PASS=0; FAIL=0; N=0

check() { # check <name> <ok:0|1> [detail]
  N=$((N+1))
  if [ "$2" = "0" ]; then PASS=$((PASS+1)); echo "ok  $N - $1";
  else FAIL=$((FAIL+1)); echo "FAIL $N - $1 ${3:-}"; fi
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# ── Build the dummy app zip ───────────────────────────────────────────────────
mkdir -p "$TMP/app"
cat > "$TMP/app/foxapp.json" <<'EOF'
{
  "schemaVersion": 1,
  "id": "e2e-dummy",
  "name": "E2E Dummy",
  "version": "1.0.0",
  "runtime": "node",
  "start": ["node", "server.js"],
  "healthPath": "/healthz",
  "uiPath": "/",
  "window": { "title": "E2E Dummy" }
}
EOF
cat > "$TMP/app/server.js" <<'EOF'
const http = require("http");
const PORT = Number(process.env.PORT);
const API = process.env.FOULFOX_API_BASE;
http.createServer((req, res) => {
  if (req.url === "/healthz") { res.writeHead(200); return res.end("ok"); }
  if (req.url === "/try-token") {
    // Fetch the shell session token FROM INSIDE the app process: the
    // socket-peer check must refuse this with 403.
    http.get(API + "/api/shell/session-token", (r) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: r.statusCode }));
      r.resume();
    }).on("error", (e) => { res.writeHead(200); res.end(JSON.stringify({ status: 0, error: e.message })); });
    return;
  }
  if (req.method === "POST" && req.url === "/echo") {
    let b = ""; req.on("data", (c) => (b += c));
    req.on("end", () => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ echo: b })); });
    return;
  }
  res.writeHead(200, { "content-type": "text/html" });
  res.end("<html><head></head><body>dummy</body></html>");
}).listen(PORT, "127.0.0.1");
EOF
(cd "$TMP/app" && python3 -c "
import zipfile
z = zipfile.ZipFile('../app.zip', 'w')
z.write('foxapp.json'); z.write('server.js')
z.close()")

# ── 1-2: API + session token from a NON-app process ──────────────────────────
curl -sf "$BASE/api/apps" >/dev/null; check "API reachable (GET /api/apps)" $?
TOKEN="$(curl -sf "$BASE/api/shell/session-token" | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])' 2>/dev/null)"
[ -n "${TOKEN:-}" ]; check "session token issued to shell (non-app) caller" $?
AUTH=(-H "X-Shell-Token: $TOKEN")

# ── 3-4: install via zip upload ───────────────────────────────────────────────
# Clean up any previous run first.
curl -s -X DELETE "${AUTH[@]}" "$BASE/api/apps/e2e-dummy" >/dev/null 2>&1
JOB="$(curl -sf -X POST "${AUTH[@]}" -H 'Content-Type: application/zip' \
  --data-binary @"$TMP/app.zip" "$BASE/api/apps/install-zip?name=e2e-dummy.zip" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["jobId"])' 2>/dev/null)"
[ -n "${JOB:-}" ]; check "zip upload accepted (202 + jobId)" $?

STATUS=""
for _ in $(seq 1 60); do
  STATUS="$(curl -s "$BASE/api/apps/e2e-dummy" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("app",d).get("status",""))' 2>/dev/null)"
  [ "$STATUS" = "installed" ] && break
  [ "$STATUS" = "error" ] && break
  sleep 1
done
[ "$STATUS" = "installed" ]; check "install completed (status=installed)" $? "(status=$STATUS)"

# ── 5-8: start (token-gated), health, port range ──────────────────────────────
CODE="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/apps/e2e-dummy/start")"
[ "$CODE" = "401" ]; check "start without shell token refused (401)" $? "(got $CODE)"

curl -sf -X POST "${AUTH[@]}" "$BASE/api/apps/e2e-dummy/start" >/dev/null; check "start with shell token accepted" $?

PHASE=""
for _ in $(seq 1 30); do
  PHASE="$(curl -s "$BASE/api/apps/e2e-dummy/run" | python3 -c 'import sys,json;d=json.load(sys.stdin);d=d.get("run",d);print(d["phase"])' 2>/dev/null)"
  [ "$PHASE" = "running" ] && break
  sleep 1
done
[ "$PHASE" = "running" ]; check "app reached running (healthz polled OK)" $? "(phase=$PHASE)"

RUN_JSON="$(curl -s "$BASE/api/apps/e2e-dummy/run")"
PORT="$(echo "$RUN_JSON" | python3 -c 'import sys,json;d=json.load(sys.stdin);d=d.get("run",d);print(d["port"])' 2>/dev/null)"
PID="$(echo "$RUN_JSON" | python3 -c 'import sys,json;d=json.load(sys.stdin);d=d.get("run",d);print(d["pid"])' 2>/dev/null)"
[ -n "$PORT" ] && [ "$PORT" -ge 27000 ] && [ "$PORT" -le 27199 ]; check "app port inside fixed range 27000-27199" $? "(port=$PORT)"

# ── 9-12: UI proxy behavior ───────────────────────────────────────────────────
CODE="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/apps/e2e-dummy/ui/healthz")"
[ "$CODE" = "200" ]; check "GET through UI proxy works (healthz)" $? "(got $CODE)"

BODY="$(curl -s -X POST -H 'Content-Type: text/plain' --data 'ping' "$BASE/api/apps/e2e-dummy/ui/echo")"
echo "$BODY" | grep -q '"echo":"ping"'; check "tokenless POST through UI proxy reaches app" $? "($BODY)"

CODE="$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Origin: https://evil.example' --data 'x' "$BASE/api/apps/e2e-dummy/ui/echo")"
[ "$CODE" = "403" ]; check "foreign-Origin POST into app backend refused (403)" $? "(got $CODE)"

CODE="$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Origin: http://127.0.0.1:8081' --data 'x' "$BASE/api/apps/e2e-dummy/ui/echo")"
[ "$CODE" = "200" ]; check "loopback-Origin POST allowed" $? "(got $CODE)"

# ── 13: app process must NOT get the shell session token ─────────────────────
TT="$(curl -s "$BASE/api/apps/e2e-dummy/ui/try-token" | python3 -c 'import sys,json;print(json.load(sys.stdin)["status"])' 2>/dev/null)"
[ "$TT" = "403" ]; check "session-token DENIED to app process (peer check)" $? "(app saw status=$TT)"

# ── 14: crash-restart supervision ─────────────────────────────────────────────
kill -9 "$PID" 2>/dev/null
RESTARTED=1
for _ in $(seq 1 30); do
  R="$(curl -s "$BASE/api/apps/e2e-dummy/run")"
  P2="$(echo "$R" | python3 -c 'import sys,json;d=json.load(sys.stdin);d=d.get("run",d);print(d["phase"])' 2>/dev/null)"
  RC="$(echo "$R" | python3 -c 'import sys,json;d=json.load(sys.stdin);d=d.get("run",d);print(d["restarts"])' 2>/dev/null)"
  if [ "$P2" = "running" ] && [ "${RC:-0}" -ge 1 ]; then RESTARTED=0; break; fi
  sleep 1
done
check "crash-restart: killed pid came back (restarts>=1)" $RESTARTED

# ── 15: CORS refusal on the main API ─────────────────────────────────────────
ACAO="$(curl -s -D - -o /dev/null -H 'Origin: https://evil.example' "$BASE/api/apps" | grep -i '^access-control-allow-origin:' || true)"
[ -z "$ACAO" ]; check "main API sends no CORS allow for foreign origin" $? "($ACAO)"

# ── 16-17: stop + uninstall ───────────────────────────────────────────────────
curl -sf -X POST "${AUTH[@]}" "$BASE/api/apps/e2e-dummy/stop" >/dev/null; check "stop accepted" $?
sleep 1
PHASE="$(curl -s "$BASE/api/apps/e2e-dummy/run" | python3 -c 'import sys,json;d=json.load(sys.stdin);d=d.get("run",d);print(d["phase"])' 2>/dev/null)"
[ "$PHASE" = "stopped" ]; check "app stopped cleanly" $? "(phase=$PHASE)"

curl -sf -X DELETE "${AUTH[@]}" "$BASE/api/apps/e2e-dummy" >/dev/null; check "uninstall accepted" $?

echo
echo "$PASS/$N checks passed"
[ "$FAIL" = "0" ]

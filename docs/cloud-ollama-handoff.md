# Handoff: Cloud-hosted Ollama for FoulFox ("project cloud" AI compute)

**Give this whole file to the agent in the new Repl.** It is self-contained: mission,
architecture, the exact contract it must satisfy, an ordered build plan, working
reference code, deployment steps, and honest caveats.

> **One assumption to confirm first:** "project cloud" here means a **Replit Reserved VM
> Deployment** that runs Ollama and exposes a secured public `/v1` URL. That is the
> simplest always-on option. It is **CPU-only (no GPU on Replit)** — see *Caveats*. If you
> actually want GPU speed, read *Hosting option B* and pick that instead. The build is
> nearly identical either way; only where it runs changes.

---

## 1. Mission

Stand up a **standalone cloud service that runs Ollama** and exposes an
**OpenAI-compatible, bearer-authenticated, HTTPS `/v1` API**. FoulFox then points its
agent suite at that URL so AI runs in the cloud 24/7 instead of depending on the user's
home PC being powered on.

**You do NOT touch the FoulFox app.** FoulFox already knows how to use any external
OpenAI-compatible endpoint (it was built in the main project). Your deliverable is one
new Repl that hosts Ollama. When it's deployed, the user connects it from inside FoulFox
in ~30 seconds (see §6).

---

## 2. The contract you must satisfy (this is what FoulFox calls)

FoulFox treats your service as a "model endpoint". Verified against the FoulFox/Odysseus
code, it will:

- Store a **base URL ending in `/v1`** (e.g. `https://your-deploy.replit.app/v1`).
- Discover models via **`GET {base}/v1/models`** (OpenAI shape: `{ "data": [{ "id": ... }] }`).
- Run chat via **`POST {base}/v1/chat/completions`** (OpenAI shape, **including streaming
  SSE** when `"stream": true`).
- Send **`Authorization: Bearer <secret>`** on every request, where `<secret>` is the
  API key the user types into FoulFox.

Ollama already serves `/v1/models` and `/v1/chat/completions` in the OpenAI shape — **but
it ignores the `Authorization` header**, so a raw public Ollama is an open, abusable
endpoint. Therefore your service is **Ollama (localhost only) + a thin reverse proxy that
enforces the bearer token** and is the only thing exposed publicly.

```
FoulFox  --HTTPS + Bearer-->  [ auth proxy :$PORT ]  --localhost-->  [ ollama :11434 ]
   (cloud agent suite)          (your public surface)                  (never public)
```

**Hard requirements for acceptance:**
1. `GET /v1/models` and `POST /v1/chat/completions` work through the public URL **only with
   the correct bearer token**; a wrong/missing token returns **401**.
2. Streaming (`stream: true`) is passed through unbuffered (SSE).
3. Ollama is **not** reachable from the public internet (bound to `127.0.0.1`).
4. The API key comes from a **secret/env var** and is **never logged**.
5. At least one model is pulled and answers a test completion.

---

## 3. Hosting options (pick one, be honest about the tradeoff)

| Option | Where | Speed | Models | Cost shape | Use when |
|---|---|---|---|---|---|
| **A. Replit Reserved VM** (this doc's default) | "project cloud" | CPU-only, slow | small only (1B–3B) | flat monthly, always-on | you want it inside Replit and accept small/slow |
| **B. External GPU host** (RunPod / Modal / Fly.io GPU / Lambda) | 3rd-party | fast | 7B–70B | usually hourly GPU | you want real model quality/speed |
| **C. Home AMD PC + tunnel** (already done) | user's desk | depends on PC | small | $0 compute, but PC must be on | already set up in main project |

**Recommendation:** if the goal is "always-on so the home PC can sleep" and light usage is
fine, do **A**. If the agents need to do heavy reasoning (the Architect role especially),
**A on CPU will feel sluggish** — steer the user to **B**, where this same proxy + Ollama
runs in a GPU container and FoulFox connects to that URL instead. The code below is
identical; only the deploy target changes.

---

## 4. Build plan (ordered tasks for the new Repl)

1. **Scaffold** a minimal Node service (no framework needed — Node's built-in `http` is
   enough for the proxy). `package.json` with `"type": "module"` and a `start` script.
2. **Install Ollama** in the Repl. Prefer the system-package route via the
   package-management skill (a Nix `ollama` package) so the binary lives on `PATH`. If
   that's unavailable, download the official static binary into a writable dir
   (e.g. `$HOME/.local/bin`) and add it to `PATH` — do **not** rely on `curl | sh` writing
   to `/usr/local` (read-only on Replit).
3. **Write `proxy/server.mjs`** (reference code in §5) — bearer-auth reverse proxy to
   `127.0.0.1:11434`, with a public unauthenticated `GET /healthz` for platform health
   checks, and everything else gated.
4. **Write `start.sh`** (reference code in §5) — start `ollama serve` bound to localhost,
   wait for it, `ollama pull` the configured model, then run the proxy in the foreground
   on `$PORT`.
5. **Add secrets** (environment-secrets skill): `OLLAMA_PROXY_KEY` (the bearer token the
   user will paste into FoulFox — generate a long random string) and `OLLAMA_MODEL`
   (e.g. `llama3.2:1b`). Never print these.
6. **Run it as a workflow** and verify locally with `curl` (see §7).
7. **Deploy** as a **Reserved VM** deployment (deployment skill): run command
   `bash start.sh`, pick a tier with enough RAM for the model (≥ 4 GB for a 1B–3B model).
   Autoscale is a poor fit (cold start + model load on every scale-up, no GPU) — use
   Reserved VM so the model stays warm.
8. **Hand the user**: the deployed `https://….replit.app` URL + the `OLLAMA_PROXY_KEY`
   value, and point them at §6.

---

## 5. Reference code

### `package.json`
```json
{
  "name": "foulfox-cloud-ollama",
  "version": "1.0.0",
  "type": "module",
  "private": true,
  "scripts": {
    "start": "bash start.sh"
  }
}
```

### `proxy/server.mjs`
```js
import http from "node:http";
import crypto from "node:crypto";

const OLLAMA = process.env.OLLAMA_UPSTREAM || "http://127.0.0.1:11434";
const PORT = Number(process.env.PORT) || 8080;
const API_KEY = process.env.OLLAMA_PROXY_KEY;

if (!API_KEY) {
  console.error("FATAL: OLLAMA_PROXY_KEY is not set. Refusing to start an open endpoint.");
  process.exit(1);
}

function timingSafeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const upstream = new URL(OLLAMA);

const server = http.createServer((req, res) => {
  // Public, unauthenticated health check for the platform.
  if (req.method === "GET" && (req.url === "/healthz" || req.url === "/")) {
    return sendJson(res, 200, { ok: true, service: "foulfox-cloud-ollama" });
  }

  // Bearer auth on everything else. Never log the token.
  const auth = req.headers["authorization"] || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token || !timingSafeEqual(token, API_KEY)) {
    return sendJson(res, 401, { error: { message: "unauthorized", type: "auth_error" } });
  }

  // Reverse-proxy to local Ollama, preserving method/path/body and streaming
  // both directions (works for SSE chat streaming).
  const headers = { ...req.headers };
  delete headers["authorization"]; // do not forward our key upstream
  headers["host"] = upstream.host;

  const proxyReq = http.request(
    {
      protocol: upstream.protocol,
      hostname: upstream.hostname,
      port: upstream.port || 80,
      method: req.method,
      path: req.url,
      headers,
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );

  proxyReq.on("error", (err) => {
    sendJson(res, 502, { error: { message: "upstream_unavailable", detail: String(err) } });
  });

  req.pipe(proxyReq);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`FoulFox cloud Ollama auth proxy listening on :${PORT} -> ${OLLAMA}`);
});
```

### `start.sh`
```bash
#!/usr/bin/env bash
set -euo pipefail

# 1. Ensure ollama is on PATH. Prefer a system package (Nix). As a fallback,
#    download the official static binary into a writable dir.
if ! command -v ollama >/dev/null 2>&1; then
  echo "ollama not found on PATH."
  echo "Preferred: add the 'ollama' system dependency via the package-management skill."
  echo "Fallback: download the static binary into \$HOME/.local/bin and re-run."
  exit 1
fi

# 2. Start Ollama bound to localhost ONLY. The auth proxy is the public surface.
export OLLAMA_HOST=127.0.0.1:11434
# Persist models under a writable, ideally persistent dir:
export OLLAMA_MODELS="${OLLAMA_MODELS:-$HOME/.ollama/models}"
ollama serve &

# 3. Wait for Ollama to come up.
echo "Waiting for Ollama..."
until curl -sf http://127.0.0.1:11434/api/version >/dev/null; do sleep 1; done
echo "Ollama is up."

# 4. Pre-pull the model so the first request isn't a multi-minute download.
MODEL="${OLLAMA_MODEL:-llama3.2:1b}"
echo "Pulling model: $MODEL"
ollama pull "$MODEL"

# 5. Run the auth proxy in the foreground; it owns $PORT.
exec node proxy/server.mjs
```

### `.gitignore`
```
node_modules/
.ollama/
```

---

## 6. How the user connects it in FoulFox (no code, ~30s)

1. In FoulFox, click **Connect local model** (top-right of the header).
2. **Local model URL**: paste the deployment URL **with `/v1`** —
   `https://your-deploy.replit.app/v1`.
3. **Secret**: paste the `OLLAMA_PROXY_KEY` value.
4. Click **Test connection** → it should list the pulled model(s).
5. Click **Connect**, choose the model, then **Use this model for all FoulFox agents**.

That assigns the cloud model to all three agent roles (Windows, Game, Architect) and
agent runs immediately start using it.

---

## 7. Verification checklist (the new agent must confirm all)

```bash
# Wrong/missing token must be rejected:
curl -s -o /dev/null -w "%{http_code}\n" https://YOUR-DEPLOY/v1/models           # -> 401
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer WRONG" \
  https://YOUR-DEPLOY/v1/models                                                   # -> 401

# Correct token lists models:
curl -s -H "Authorization: Bearer $KEY" https://YOUR-DEPLOY/v1/models             # -> {"data":[...]}

# A real completion works (and streaming works):
curl -s -H "Authorization: Bearer $KEY" -H "content-type: application/json" \
  -d '{"model":"llama3.2:1b","messages":[{"role":"user","content":"say hi"}]}' \
  https://YOUR-DEPLOY/v1/chat/completions

# Ollama is NOT public (no direct 11434 surface; only the proxy is exposed).
```
Then confirm end-to-end in FoulFox: connect, assign to all agents, send one agent message.

---

## 8. Honest caveats (tell the user — do not bury these)

- **No GPU on Replit.** Reserved VM is CPU-only. Expect only small models (1B–3B) at a
  few tokens/sec. Fine for light tasks; **the Architect review role will feel slow**. For
  real speed/quality use Hosting option B (external GPU) with this same code.
- **Always-on costs compute.** A Reserved VM bills continuously (that's the point — it
  stays warm so the home PC can sleep). This replaces the **AI API** cost, not the
  **hosting** cost.
- **Concurrency.** Ollama largely serializes requests; the three agents sharing one small
  CPU instance will queue. Size the instance accordingly or use GPU.
- **Cold model load.** On the first request after boot/redeploy the model loads into RAM;
  the pre-pull in `start.sh` avoids re-downloading but not the load. Reserved VM keeps it
  warm thereafter.
- **Security.** The bearer token is the only thing protecting your cloud GPU/CPU from
  abuse — treat it like a password, store it as a secret, rotate if leaked. Keep Ollama
  bound to `127.0.0.1`. Consider adding basic rate limiting in the proxy if the URL ever
  leaks.

---

## 9. Summary for the new agent

> Build a Replit Repl that runs Ollama on `127.0.0.1:11434` behind a Node bearer-auth
> reverse proxy (`proxy/server.mjs`) bound to `$PORT`, started by `start.sh` which pulls
> `$OLLAMA_MODEL`. Secrets: `OLLAMA_PROXY_KEY`, `OLLAMA_MODEL`. Deploy as a Reserved VM.
> Acceptance: public `/v1/models` + `/v1/chat/completions` work only with the bearer
> token (else 401), streaming passes through, Ollama isn't publicly reachable, key never
> logged. Hand back the deployment URL + key; the user connects it in FoulFox via
> "Connect local model" → `https://…/v1` + key → assign to all agents. Be upfront that
> Replit is CPU-only (small/slow); recommend an external GPU host if they need speed.
```

# FoulFox App Spec — build an installable app for FoulFox OS

**Give this whole file to the agent building the app (in its own Replit project / GitHub repo).**
It is self-contained: what a FoulFox App is, the manifest contract, the runtime contract,
the broker API for talking to the FoulFox agent + Windows VM, reference code, security
rules, and a verification checklist.

> A FoulFox App is a **normal full-stack web app** (its own backend + its own database)
> with **one extra file at the repo root: `foxapp.json`**. The user installs it into
> FoulFox by pasting the GitHub repo URL. FoulFox clones it, installs deps, builds it,
> and runs its backend as a managed local process; the UI shows up in the FoulFox left
> sidebar and opens in a window.

---

## 1. What you are building

A web app that:
1. Runs its **own HTTP server** bound to `127.0.0.1` on a **port given by FoulFox** (env `PORT`).
2. Serves its **own UI** (the page FoulFox embeds in a window) and its **own API**.
3. Stores all persistent data (including its database) **only** under the directory FoulFox
   gives it (env `FOULFOX_APP_DATA_DIR`) — never inside the repo, because the source tree
   may be wiped and re-cloned on update.
4. Optionally asks FoulFox's **agent** to do work and **drive the Windows VM** (e.g. open a
   browser in the VM and scrape a site), via the **broker** (§5) — but only for capabilities
   it declared and the user granted at install.

You do **not** deploy this app anywhere. FoulFox runs it locally on each PC.

---

## 2. The manifest: `foxapp.json` (repo root, required)

```jsonc
{
  "schemaVersion": 1,
  "id": "rental-aggregator",            // unique slug: [a-z0-9-], stable across updates
  "name": "Rental Aggregator",          // display name in the sidebar
  "version": "1.0.0",
  "description": "Competitor pricing + SEO scores for short-term rentals.",
  "icon": "icon.png",                   // optional, repo-relative, square (≥128px) png/svg

  "runtime": "node",                    // MVP: "node" or "python"

  // Commands are ARRAYS OF ARGV (no shell string — prevents injection).
  // Run from the repo root. Each runs to completion in order.
  "install": [["npm", "ci"]],           // deps install (needs network at install time)
  "build":   [["npm", "run", "build"]], // optional; omit or [] if none
  "start":    ["node", "server.js"],    // long-running; must bind 127.0.0.1:$PORT

  "healthPath": "/healthz",             // GET must return 200 once the app is ready
  "uiPath": "/",                        // the path FoulFox opens in the app window

  "portEnv": "PORT",                    // env var FoulFox sets with the assigned port
  "dataEnv": "FOULFOX_APP_DATA_DIR",    // env var with the per-app writable data dir
  "db": "sqlite",                       // informational; you own your DB under the data dir

  // Powers this app requests. Shown to the user at install for approval.
  // MVP-allowed: "agent.task", "vm.computer_use". (No raw shell/file access in MVP.)
  "capabilities": ["agent.task", "vm.computer_use"],

  "autostart": true,                    // start this app's backend on OS boot
  "window": { "title": "Rental Aggregator", "width": 1200, "height": 800, "singleInstance": true }
}
```

**Rules**
- `id` must be stable and unique — it keys the install, the data dir, and the registry.
- `install`/`build`/`start` are **argv arrays**, executed without a shell. No `&&`, no pipes,
  no env interpolation inside them. Need multiple steps? Use multiple entries in `install`.
- `start` must stay in the **foreground** (don't daemonize) and must keep running.
- Declare the **minimum** capabilities you need. Apps with `capabilities: []` still work —
  they just can't call the agent/VM broker.

---

## 3. The runtime contract (what FoulFox guarantees, what you must do)

FoulFox starts your `start` command with these environment variables:

| Env | Meaning |
|---|---|
| `PORT` | The port you **must** bind to, on `127.0.0.1`. |
| `FOULFOX_APP_DATA_DIR` | Writable, persistent dir. Put your DB + files **here only**. |
| `FOULFOX_APP_ID` | Your app's `id`. |
| `FOULFOX_APP_TOKEN` | Bearer token for the broker (§5). **Backend only — never send to the browser.** |
| `FOULFOX_API_BASE` | Base URL of the FoulFox API (e.g. `http://127.0.0.1:8080`). |

You must:
- **Bind to `127.0.0.1:$PORT`** (not `0.0.0.0`, not a hardcoded port).
- **Serve `healthPath` → 200** as soon as you're ready to take traffic.
- **Serve your UI at `uiPath`.** It will be embedded in a **sandboxed iframe**
  (`allow-scripts allow-forms`, **no** `allow-same-origin`), so:
  - Don't rely on third-party cookies or framebusting (`if (top !== self)`).
  - Keep the UI self-contained; talk to **your own** backend for everything.
- **Keep all writes under `FOULFOX_APP_DATA_DIR`.** The repo dir is disposable.
- Read secrets/config from env, not committed files.

---

## 4. Capabilities (what an app may ask FoulFox to do)

| Capability | Grants | MVP |
|---|---|---|
| `agent.task` | Ask the FoulFox agent to perform a natural-language task and get results. | ✅ |
| `vm.computer_use` | Screenshot the Windows VM and send mouse/keyboard input. | ✅ |
| `files.read` / `files.write` | Read/write host files outside the app data dir. | ❌ later |
| `shell` | Run host shell commands. | ❌ (not planned for untrusted apps) |

Only declared + user-granted capabilities work; others return `403`.

---

## 5. The Broker API — talk to the agent + drive the VM

Your **backend** calls these (never the browser). Auth = `Authorization: Bearer $FOULFOX_APP_TOKEN`.
Base = `$FOULFOX_API_BASE`. All requests/responses are JSON.

### Ask the agent to do a task — `POST /api/apps/broker/agent/task`  *(needs `agent.task`)*
```jsonc
// request
{ "prompt": "Scrape tonight's Airbnb prices for ZIP 90210 and return a JSON list.",
  "context": { "anything": "your app wants to pass" } }
// response
{ "taskId": "t_abc123", "status": "running" }
```
Poll it: `GET /api/apps/broker/agent/task/:taskId` →
```jsonc
{ "taskId": "t_abc123", "status": "running|done|error",
  "result": { /* present when done */ }, "error": "..." }
```

### Drive the Windows VM  *(needs `vm.computer_use`)*
- `POST /api/apps/broker/vm/screenshot` → `{ "image": "<base64 png>", "width": 1920, "height": 1080 }`
- `POST /api/apps/broker/vm/input` with a single action or an array:
```jsonc
{ "action": "move|click|double_click|right_click|type|key|scroll|drag",
  "x": 640, "y": 360,            // for pointer actions; coords are in the last screenshot's pixels
  "text": "hello",               // for "type"
  "keys": ["ctrl", "l"] }        // for "key"
```
FoulFox targets the currently selected VM. (No VM selected → honest `409` error.)

### Human-in-the-loop checkpoint (bot checks / CAPTCHA)  *(always available)*
When you hit a wall a human must clear (login, CAPTCHA), pause and ask:
```jsonc
// POST /api/apps/broker/human/checkpoint
{ "message": "Solve the CAPTCHA in the VM, then click Resume.",
  "screenshot": true }          // optionally attach the current VM screen to the prompt
// response
{ "checkpointId": "c_xyz", "status": "waiting" }
```
FoulFox shows the user a banner/modal (and the VM is right there in the shell to interact with).
Poll: `GET /api/apps/broker/human/checkpoint/:id` → `{ "status": "waiting|resumed|cancelled" }`.
Resume your flow on `resumed`; abort cleanly on `cancelled`.

> The exact broker endpoints above are the **contract** FoulFox implements. Code your app to
> them; don't try to reach the agent or VM any other way (you can't — only the broker token works).

---

## 6. Reference code

### Minimal broker client — Node (`foulfox.js`)
```js
const BASE = process.env.FOULFOX_API_BASE;
const TOKEN = process.env.FOULFOX_APP_TOKEN;
const H = { "authorization": `Bearer ${TOKEN}`, "content-type": "application/json" };

async function call(path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method: body ? "POST" : "GET",
    headers: H,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`broker ${path} -> ${r.status} ${await r.text()}`);
  return r.json();
}

export const foulfox = {
  agentTask: (prompt, context) => call("/api/apps/broker/agent/task", { prompt, context }),
  agentResult: (id) => call(`/api/apps/broker/agent/task/${id}`),
  vmScreenshot: () => call("/api/apps/broker/vm/screenshot", {}),
  vmInput: (action) => call("/api/apps/broker/vm/input", action),
  humanCheckpoint: (message, screenshot = true) =>
    call("/api/apps/broker/human/checkpoint", { message, screenshot }),
  checkpointStatus: (id) => call(`/api/apps/broker/human/checkpoint/${id}`),
};
```

### Minimal app server — Node (`server.js`)
```js
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const PORT = Number(process.env.PORT);
const DATA = process.env.FOULFOX_APP_DATA_DIR;
fs.mkdirSync(DATA, { recursive: true });          // your DB/files go here
const DB_PATH = path.join(DATA, "app.db");        // e.g. open SQLite at this path

const server = http.createServer((req, res) => {
  if (req.url === "/healthz") { res.writeHead(200); return res.end("ok"); }
  if (req.url === "/") {
    res.writeHead(200, { "content-type": "text/html" });
    return res.end("<h1>Rental Aggregator</h1><p>Your UI here.</p>");
  }
  // ... your own API routes (the frontend calls THESE; only the backend calls the broker)
  res.writeHead(404); res.end("not found");
});
server.listen(PORT, "127.0.0.1", () => console.log(`app on 127.0.0.1:${PORT}, data=${DATA}`));
```

### Minimal app server — Python (`server.py`, `runtime: "python"`, `start: ["python","server.py"]`)
```python
import os, http.server, socketserver
PORT = int(os.environ["PORT"])
DATA = os.environ["FOULFOX_APP_DATA_DIR"]
os.makedirs(DATA, exist_ok=True)  # sqlite3.connect(os.path.join(DATA, "app.db"))

class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/healthz":
            self.send_response(200); self.end_headers(); self.wfile.write(b"ok"); return
        if self.path == "/":
            self.send_response(200); self.send_header("content-type","text/html"); self.end_headers()
            self.wfile.write(b"<h1>App</h1>"); return
        self.send_response(404); self.end_headers()

with socketserver.TCPServer(("127.0.0.1", PORT), H) as httpd:
    print(f"app on 127.0.0.1:{PORT}"); httpd.serve_forever()
```

### A typical "scrape with the VM + human help" loop (pseudo)
```js
import { foulfox } from "./foulfox.js";
// 1) drive the VM browser to the site
await foulfox.vmInput({ action: "type", text: "https://airbnb.com" });
await foulfox.vmInput({ action: "key", keys: ["enter"] });
// 2) if a bot check appears, pause for the human
const cp = await foulfox.humanCheckpoint("Clear the CAPTCHA in the VM, then Resume.");
let s; do { await new Promise(r=>setTimeout(r,2000)); s = await foulfox.checkpointStatus(cp.checkpointId); }
while (s.status === "waiting");
if (s.status !== "resumed") return;                // user cancelled
// 3) hand the actual extraction to the agent
const t = await foulfox.agentTask("Read the listing prices on screen and return JSON.");
```

---

## 7. Security rules for app authors (do these)

- **Bind to `127.0.0.1` only.** Your app must never be reachable off the machine.
- **Keep `FOULFOX_APP_TOKEN` server-side.** Never embed it in HTML/JS or send it to the iframe.
- **Validate your own inputs.** You're a real server; treat your API like one.
- **Request least privilege.** Only list capabilities you actually use.
- **Store secrets in env**, not in the repo. Don't log tokens or scraped PII.
- Assume your UI runs **without `allow-same-origin`** — no reliance on cookies set by other origins.

---

## 8. Verification checklist (the app agent must confirm)

```bash
# Simulate how FoulFox launches you:
PORT=5055 FOULFOX_APP_DATA_DIR=/tmp/foxdata FOULFOX_APP_ID=myapp \
FOULFOX_APP_TOKEN=dummy FOULFOX_API_BASE=http://127.0.0.1:8080 \
  <your start command>

curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:5055/healthz   # -> 200
curl -s http://127.0.0.1:5055/                                            # -> your UI HTML
# Confirm app.db / files were created under /tmp/foxdata, NOT in the repo.
```
- [ ] `foxapp.json` present at repo root, valid, `id` is a stable slug.
- [ ] Binds `127.0.0.1:$PORT`; health returns 200; UI served at `uiPath`.
- [ ] All writes land in `FOULFOX_APP_DATA_DIR`.
- [ ] Works inside an iframe without `allow-same-origin`.
- [ ] Broker calls use `$FOULFOX_APP_TOKEN` from the backend only; capabilities match `foxapp.json`.
- [ ] Install needs network; running afterward does not.

---

## 9. Summary for the app-building agent

> Build a normal full-stack web app, but: add `foxapp.json` at the repo root; bind to
> `127.0.0.1:$PORT`; store all data under `$FOULFOX_APP_DATA_DIR`; serve `/healthz`→200 and
> your UI at `uiPath`; assume the UI runs in a sandboxed iframe (no `allow-same-origin`).
> To use the FoulFox agent or drive the Windows VM, call the broker at `$FOULFOX_API_BASE`
> with `Authorization: Bearer $FOULFOX_APP_TOKEN`, only for the capabilities you declared
> (`agent.task`, `vm.computer_use`) and the user granted. Use `human/checkpoint` to pause
> for the user to clear bot checks. Push to GitHub; the user installs by pasting the repo URL.
```

# Connect your own local model (run FoulFox AI for free)

FoulFox's agents don't need a paid AI API. Every agent runs through a configurable
**model endpoint**, so you can point them at a model running on your own computer
(Ollama or LM Studio). When you do that, the AI runs on your hardware and there are
**no per-call AI charges** — only the cost of hosting FoulFox itself.

This guide shows you how to:

1. Run a model locally (Ollama or LM Studio).
2. Expose it to the internet with a tunnel (so the cloud-hosted FoulFox can reach it).
3. Connect it inside FoulFox and assign it to your agents.

---

## Why a tunnel?

Your home computer is behind your router (NAT), so a cloud-hosted FoulFox can't reach
it directly. A **tunnel** gives your local model a public `https://…` URL that FoulFox
can call. Cloudflare Tunnel is free and the quickest to start with.

> **Security note:** a tunnel makes your model reachable from the internet. Use a
> quick tunnel only while testing, and prefer a named tunnel + access control (below)
> for anything you leave running. Treat the tunnel URL like a password.

---

## Step 1 — Run a model locally

### Option A: Ollama (recommended)

1. Install Ollama from <https://ollama.com>.
2. Pull and run a model:
   ```bash
   ollama run llama3.2
   ```
   Pick a small model if your machine is modest (e.g. an AMD A9 / 8 GB):
   `llama3.2:1b`, `qwen2.5:1.5b`, or `phi3:mini`.
3. Ollama serves an OpenAI-compatible API at `http://localhost:11434/v1`.

### Option B: LM Studio

1. Install LM Studio from <https://lmstudio.ai>.
2. Download a model, open the **Developer / Local Server** tab, and **Start Server**.
3. It serves an OpenAI-compatible API at `http://localhost:1234/v1`.

---

## Step 2 — Expose it with a tunnel

### Quick tunnel (fastest, temporary URL)

1. Install `cloudflared` (<https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/>).
2. Point it at your local model server:
   ```bash
   # Ollama
   cloudflared tunnel --url http://localhost:11434

   # LM Studio
   cloudflared tunnel --url http://localhost:1234
   ```
3. It prints a URL like `https://random-words.trycloudflare.com`. Copy it.
   This URL changes every time you restart the quick tunnel.

### Named tunnel (stable URL, recommended for ongoing use)

1. `cloudflared login` (authorizes with your Cloudflare account + a domain).
2. `cloudflared tunnel create foulfox-llm`
3. Route a hostname to it and run it, e.g.:
   ```bash
   cloudflared tunnel route dns foulfox-llm llm.yourdomain.com
   cloudflared tunnel --url http://localhost:11434 run foulfox-llm
   ```
4. Optionally protect it with **Cloudflare Access** so only you can reach it.

---

## Step 3 — Connect it in FoulFox

1. In FoulFox, click **Connect local model** (top-right of the header).
2. Paste your tunnel URL into **Local model URL**
   (e.g. `https://random-words.trycloudflare.com`). FoulFox adds `/v1` automatically
   if it's missing.
3. (Optional) Give it a **Name** and a **Secret** if your server requires an API key.
4. Click **Test connection** — you should see the models it discovered.
5. Click **Connect**, choose a model, then
   **Use this model for all FoulFox agents**.

That's it. All three agents (Windows, Game, Architect) now run on your local model.
You can fine-tune which model each agent uses later in the setup wizard.

---

## Caveats (so there are no surprises)

- **Model quality scales with your hardware.** A 2-core / 8 GB machine (e.g. AMD A9)
  can only run small models comfortably. They're fine for many tasks but won't match
  a frontier cloud model on hard reasoning. This is a quality trade-off, not a cost one.
- **Keep the tunnel + model running.** If your home machine sleeps or the tunnel stops,
  FoulFox can't reach the model and agent runs will fail until it's back.
- **Hosting FoulFox still costs compute.** Running your own local model removes the AI
  API cost. A always-on, published FoulFox deployment still uses hosting compute beyond
  a base subscription. Connecting a local model does not change that.
- **Your existing default stays until you assign.** Simply adding the endpoint doesn't
  redirect the agents — assigning it to the agents (Step 3.5) is what makes runs use it.

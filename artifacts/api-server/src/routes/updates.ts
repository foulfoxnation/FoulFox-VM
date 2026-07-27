import { Router, type IRouter, type Request, type Response } from "express";
import { logger } from "../lib/logger";

// ── Public update mirror ──────────────────────────────────────────────────────
// When this api-server runs on the PUBLISHED Replit site (e.g.
// https://odysseus-vm.replit.app), these routes turn it into an update mirror
// for FoulFox OS devices: the device's patcher fetches the manifest + bundle
// from here instead of (or as a fallback to) GitHub. That sidesteps GitHub
// rate limits / reachability issues on the appliance ("could not reach the
// update server") — the fix path becomes: build → publish → device patches.
//
//   GET /updates/foulfox-app-latest.json    manifest, with bundleUrl rewritten
//                                           to this mirror's own bundle route
//   GET /updates/foulfox-app-latest.tar.gz  streams the bundle from GitHub
//
// Read-only, no secrets: it proxies the PUBLIC rolling release of
// FOULFOX_GITHUB_REPO. Public by design — devices in the field have no token.
// Integrity is preserved end-to-end: the manifest's sha256 is passed through
// untouched and the device patcher verifies the bundle against it.

const ROLLING_TAG = "foulfox-app-latest";
const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

function repo(): string | null {
  const raw = (process.env.FOULFOX_GITHUB_REPO || "").trim()
    .replace(/^git@github\.com:/i, "")
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/^\/+|\/+$/g, "");
  return REPO_RE.test(raw) ? raw : null;
}

function assetUrl(name: string): string | null {
  const r = repo();
  return r ? `https://github.com/${r}/releases/download/${ROLLING_TAG}/${name}` : null;
}

// The mirror advertises itself as the bundle host so a device that can reach
// this site never needs github.com at all.
function selfBase(req: Request): string {
  const proto = (req.headers["x-forwarded-proto"] as string)?.split(",")[0]?.trim() || req.protocol;
  const host = (req.headers["x-forwarded-host"] as string)?.split(",")[0]?.trim() || req.get("host") || "";
  return `${proto}://${host}`;
}

const FETCH_TIMEOUT_MS = 15_000;

const router: IRouter = Router();

router.get("/updates/foulfox-app-latest.json", async (req: Request, res: Response) => {
  const url = assetUrl("foulfox-app-latest.json");
  if (!url) {
    res.status(503).json({ error: "Mirror not configured (FOULFOX_GITHUB_REPO unset)." });
    return;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const upstream = await fetch(url, { redirect: "follow", signal: controller.signal });
    if (!upstream.ok) {
      res.status(502).json({ error: `Upstream manifest fetch failed (${upstream.status}).` });
      return;
    }
    const manifest = (await upstream.json()) as Record<string, unknown>;
    manifest.bundleUrl = `${selfBase(req)}/api/updates/foulfox-app-latest.tar.gz`;
    res.setHeader("Cache-Control", "no-store");
    res.json(manifest);
  } catch (err) {
    logger.warn({ err }, "update mirror: manifest fetch failed");
    res.status(502).json({ error: "Could not fetch the upstream manifest." });
  } finally {
    clearTimeout(timer);
  }
});

router.get("/updates/foulfox-app-latest.tar.gz", async (req: Request, res: Response) => {
  const url = assetUrl("foulfox-app-latest.tar.gz");
  if (!url) {
    res.status(503).json({ error: "Mirror not configured (FOULFOX_GITHUB_REPO unset)." });
    return;
  }
  try {
    const upstream = await fetch(url, { redirect: "follow" });
    if (!upstream.ok || !upstream.body) {
      res.status(502).json({ error: `Upstream bundle fetch failed (${upstream.status}).` });
      return;
    }
    res.status(200);
    res.setHeader("Content-Type", "application/gzip");
    const len = upstream.headers.get("content-length");
    if (len) res.setHeader("Content-Length", len);
    res.setHeader("Cache-Control", "no-store");

    const reader = upstream.body.getReader();
    req.on("close", () => void reader.cancel().catch(() => {}));
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(value)) {
        await new Promise<void>((resolve) => res.once("drain", resolve));
      }
    }
    res.end();
  } catch (err) {
    logger.warn({ err }, "update mirror: bundle stream failed");
    // Headers may already be sent mid-stream — just terminate the response so
    // the device sees a short read and its sha256 check fails loudly.
    if (!res.headersSent) res.status(502).json({ error: "Could not stream the bundle." });
    else res.destroy();
  }
});

export default router;

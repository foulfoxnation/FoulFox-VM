import { Router, type IRouter } from "express";

// ── FoulFox OS release info ────────────────────────────────────────────────────
// Exposes where the bootable appliance .iso can be downloaded from, so the shell's
// "Get FoulFox OS" tab can hand the user a one-click download. This is a public,
// read-only GET (no token) — it returns only a URL, never anything sensitive.
//
// Resolution order:
//   1. FOULFOX_ISO_URL        — an explicit direct download URL (wins if set).
//   2. FOULFOX_GITHUB_REPO    — "owner/repo": construct the GitHub Actions rolling
//      release links (foulfox-os-latest) the cloud build publishes.
//   3. neither set            — status "unconfigured", so the tab shows setup steps.
//
// When a URL is resolved we additionally probe whether the file actually exists
// yet (the cloud build may still be running), so the tab can show "building"
// instead of handing out a link that 404s. The probe is cached so polling clients
// don't hammer GitHub.

const ROLLING_TAG = "foulfox-os-latest";
const ROLLING_ISO = "foulfox-os-latest.iso";

function normalizeRepo(raw: string): string {
  return raw
    .trim()
    .replace(/^git@github\.com:/i, "")
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/^\/+|\/+$/g, "");
}

function githubReleaseUrls(repo: string): { iso: string; sha256: string } {
  const base = `https://github.com/${repo}/releases/download/${ROLLING_TAG}`;
  return { iso: `${base}/${ROLLING_ISO}`, sha256: `${base}/${ROLLING_ISO}.sha256` };
}

// "owner/repo" with GitHub-legal characters only — two segments, nothing exotic
// that could bend the constructed release URL somewhere unexpected.
const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

// ── availability probe (cached) ───────────────────────────────────────────────
type CacheEntry = { ok: boolean; expires: number };
const availabilityCache = new Map<string, CacheEntry>();
const OK_TTL_MS = 5 * 60_000; // it exists — re-confirm every 5 min
const MISS_TTL_MS = 30_000; // not there yet — re-check every 30s so it flips on fast
const PROBE_TIMEOUT_MS = 6_000;

async function isoExists(url: string): Promise<boolean> {
  const now = Date.now();
  const cached = availabilityCache.get(url);
  if (cached && cached.expires > now) return cached.ok;

  let ok = false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    let resp = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: controller.signal,
    });
    // Some CDNs/edges refuse HEAD — fall back to a 1-byte ranged GET.
    if (resp.status === 403 || resp.status === 405) {
      resp = await fetch(url, {
        method: "GET",
        redirect: "follow",
        headers: { Range: "bytes=0-0" },
        signal: controller.signal,
      });
    }
    ok = resp.status >= 200 && resp.status < 300;
  } catch {
    ok = false;
  } finally {
    clearTimeout(timer);
  }
  availabilityCache.set(url, { ok, expires: now + (ok ? OK_TTL_MS : MISS_TTL_MS) });
  return ok;
}

const router: IRouter = Router();

router.get("/os/release-info", async (_req, res) => {
  const explicitIsoRaw = process.env.FOULFOX_ISO_URL?.trim();
  const explicitShaRaw = process.env.FOULFOX_ISO_SHA256_URL?.trim();
  const repoEnv = process.env.FOULFOX_GITHUB_REPO?.trim();

  const explicitIso = explicitIsoRaw && isHttpUrl(explicitIsoRaw) ? explicitIsoRaw : null;
  const explicitSha = explicitShaRaw && isHttpUrl(explicitShaRaw) ? explicitShaRaw : null;
  const normalized = repoEnv ? normalizeRepo(repoEnv) : null;
  const repo = normalized && REPO_RE.test(normalized) ? normalized : null;

  let isoUrl: string | null = null;
  let sha256Url: string | null = null;
  let source: "explicit" | "github" | null = null;

  if (explicitIso) {
    isoUrl = explicitIso;
    sha256Url = explicitSha || `${explicitIso}.sha256`;
    source = "explicit";
  } else if (repo) {
    const urls = githubReleaseUrls(repo);
    isoUrl = urls.iso;
    sha256Url = urls.sha256;
    source = "github";
  }

  // status: ready (file is downloadable now) | building (configured, not published
  // yet) | unconfigured (no repo/url wired in).
  let status: "ready" | "building" | "unconfigured";
  let available = false;
  if (isoUrl) {
    available = await isoExists(isoUrl);
    status = available ? "ready" : "building";
  } else {
    status = "unconfigured";
  }

  res.json({
    available,
    status,
    isoUrl,
    sha256Url,
    repo,
    source,
    version: process.env.FOULFOX_ISO_VERSION?.trim() || null,
  });
});

export default router;

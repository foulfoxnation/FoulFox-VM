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
//   3. neither set            — available:false, so the tab shows setup steps.

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

const router: IRouter = Router();

router.get("/os/release-info", (_req, res) => {
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

  res.json({
    available: Boolean(isoUrl),
    isoUrl,
    sha256Url,
    repo,
    source,
    version: process.env.FOULFOX_ISO_VERSION?.trim() || null,
  });
});

export default router;

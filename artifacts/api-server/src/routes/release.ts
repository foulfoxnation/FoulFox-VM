import { Router, type IRouter } from "express";
import { logger } from "../lib/logger";

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

// ── ISO build trigger + live status ───────────────────────────────────────────
// The "Get FoulFox OS" tab can both START a build (GitHub Actions workflow_dispatch)
// and SHOW its real state, instead of just guessing "building" because no release
// exists yet. These are intentionally public (no localhostOnly/token guard) so the
// button works from the Replit preview too — auth hardening is deferred for now.
const WORKFLOW_FILE = "build-foulfox-os.yml";
const BUILD_REF = process.env.FOULFOX_BUILD_REF?.trim() || "main";

function resolveRepo(): string | null {
  const repoEnv = process.env.FOULFOX_GITHUB_REPO?.trim();
  const normalized = repoEnv ? normalizeRepo(repoEnv) : null;
  return normalized && REPO_RE.test(normalized) ? normalized : null;
}

// A token with the `workflow` scope lets the server dispatch a build and lifts the
// 60/hr unauthenticated GitHub API limit when polling run status.
function githubToken(): string | null {
  return (
    process.env.FOULFOX_GITHUB_TOKEN?.trim() ||
    process.env.GH_PUSH_TOKEN?.trim() ||
    process.env.GITHUB_TOKEN?.trim() ||
    null
  );
}

function ghHeaders(extra?: Record<string, string>): Record<string, string> {
  const h: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "foulfox-os-shell",
    ...extra,
  };
  const token = githubToken();
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

type BuildState = "queued" | "in_progress" | "success" | "failed" | "unknown";

interface LatestRun {
  runNumber: number | null;
  state: BuildState;
  status: string | null;
  conclusion: string | null;
  htmlUrl: string | null;
  event: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

interface BuildStatusResponse {
  configured: boolean;
  canTrigger: boolean;
  repo: string | null;
  workflowUrl: string | null;
  running: boolean;
  latestRun: LatestRun | null;
  error: string | null;
}

function normalizeRunState(status: string | null, conclusion: string | null): BuildState {
  if (status === "completed") return conclusion === "success" ? "success" : "failed";
  if (status === "in_progress") return "in_progress";
  if (status === "queued" || status === "requested" || status === "waiting" || status === "pending") {
    return "queued";
  }
  return "unknown";
}

// Cache the run lookup briefly so a roomful of polling clients (every page open
// polls) can't blow the GitHub API budget — one upstream call per ~12s, max.
type BuildStatusCache = { payload: BuildStatusResponse; expires: number };
let buildStatusCache: BuildStatusCache | null = null;
const BUILD_STATUS_TTL_MS = 12_000;

async function fetchLatestRun(repo: string): Promise<{ run: LatestRun | null; error: string | null }> {
  const url = `https://api.github.com/repos/${repo}/actions/workflows/${WORKFLOW_FILE}/runs?per_page=1`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { headers: ghHeaders(), signal: controller.signal });
    if (!resp.ok) {
      return {
        run: null,
        error:
          resp.status === 404
            ? "Build workflow not found on GitHub yet."
            : `GitHub returned ${resp.status} while checking build status.`,
      };
    }
    const body = (await resp.json()) as { workflow_runs?: Array<Record<string, unknown>> };
    const r = body.workflow_runs?.[0];
    if (!r) return { run: null, error: null };
    const status = (r.status as string | null) ?? null;
    const conclusion = (r.conclusion as string | null) ?? null;
    return {
      run: {
        runNumber: typeof r.run_number === "number" ? r.run_number : null,
        state: normalizeRunState(status, conclusion),
        status,
        conclusion,
        htmlUrl: (r.html_url as string | null) ?? null,
        event: (r.event as string | null) ?? null,
        createdAt: (r.created_at as string | null) ?? null,
        updatedAt: (r.updated_at as string | null) ?? null,
      },
      error: null,
    };
  } catch {
    return { run: null, error: "Could not reach GitHub to check build status." };
  } finally {
    clearTimeout(timer);
  }
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

// GET /os/build-status — the ACTUAL latest GitHub Actions run for the ISO build,
// so the tab can say "running / failed / never built" instead of a permanent
// "building". Read-only; cached server-side to stay within GitHub's rate limit.
router.get("/os/build-status", async (_req, res) => {
  const repo = resolveRepo();
  if (!repo) {
    res.json({
      configured: false,
      canTrigger: false,
      repo: null,
      workflowUrl: null,
      running: false,
      latestRun: null,
      error: null,
    } satisfies BuildStatusResponse);
    return;
  }

  const now = Date.now();
  if (buildStatusCache && buildStatusCache.expires > now) {
    res.json(buildStatusCache.payload);
    return;
  }

  const { run, error } = await fetchLatestRun(repo);
  const running = run ? run.state === "queued" || run.state === "in_progress" : false;
  const payload: BuildStatusResponse = {
    configured: true,
    canTrigger: Boolean(githubToken()),
    repo,
    workflowUrl: `https://github.com/${repo}/actions/workflows/${WORKFLOW_FILE}`,
    running,
    latestRun: run,
    error,
  };
  buildStatusCache = { payload, expires: now + BUILD_STATUS_TTL_MS };
  res.json(payload);
});

// POST /os/build — kick off the ISO build (GitHub Actions workflow_dispatch).
// Needs a server-side token with the `workflow` scope. Returns quickly; the run
// shows up via /os/build-status a few seconds later.
router.post("/os/build", async (_req, res) => {
  const repo = resolveRepo();
  if (!repo) {
    res.status(400).json({
      started: false,
      error: "No GitHub repo is configured, so there's nothing to build (set FOULFOX_GITHUB_REPO).",
    });
    return;
  }
  if (!githubToken()) {
    res.status(501).json({
      started: false,
      error:
        "The server has no GitHub token with the 'workflow' scope, so it can't start a build. Start one from GitHub instead.",
    });
    return;
  }

  const url = `https://api.github.com/repos/${repo}/actions/workflows/${WORKFLOW_FILE}/dispatches`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: ghHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ ref: BUILD_REF, inputs: { publish_release: "true" } }),
      signal: controller.signal,
    });
    if (resp.status === 204) {
      buildStatusCache = null; // force the next poll to fetch the fresh "running" state
      res.json({
        started: true,
        repo,
        workflowUrl: `https://github.com/${repo}/actions/workflows/${WORKFLOW_FILE}`,
      });
      return;
    }

    let detail = `GitHub returned ${resp.status}`;
    try {
      const j = (await resp.json()) as { message?: string };
      if (j?.message) detail = j.message;
    } catch {
      /* non-JSON body */
    }
    const error =
      resp.status === 401 || resp.status === 403
        ? "GitHub rejected the build request — the token is missing the 'workflow' scope or lacks access to this repo."
        : resp.status === 404
          ? "Couldn't find the build workflow on GitHub (check the workflow file name and branch)."
          : resp.status === 422
            ? "GitHub couldn't start this workflow on the selected branch (it must exist on the default branch with workflow_dispatch enabled)."
            : `Could not start the build: ${detail}`;
    logger.warn({ repo, status: resp.status, detail }, "ISO build dispatch failed");
    res.status(502).json({ started: false, error });
  } catch {
    res.status(502).json({ started: false, error: "Could not reach GitHub to start the build." });
  } finally {
    clearTimeout(timer);
  }
});

export default router;

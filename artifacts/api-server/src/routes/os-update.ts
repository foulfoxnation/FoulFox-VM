import { Router, type IRouter, type Request, type Response } from "express";
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import { logger } from "../lib/logger";

// ── FoulFox OS live app-update API ──────────────────────────────────────────────
// Thin HTTP surface over the device-side updater (/usr/local/sbin/foulfox-patcher).
// The patcher is the workhorse (download → verify → atomic swap → health-check →
// rollback); these routes only:
//   GET  /os/app-update-info   probe the rolling manifest, compare to the running
//                              version (read-only, no token — like /os/release-info)
//   GET  /os/update/status     read the patcher's status.json (read-only)
//   POST /os/update/apply      `sudo foulfox-patcher apply`    (token-guarded)
//   POST /os/update/rollback   `sudo foulfox-patcher rollback` (token-guarded)
//
// In the Replit dev workspace there is no patcher/systemd/sudo, so the POSTs return
// 501 and the read endpoints degrade gracefully (currentVersion is null) — the UI
// shows "not available here" instead of erroring.

const execFileAsync = promisify(execFile);

const PATCHER = "/usr/local/sbin/foulfox-patcher";
const ROLLING_TAG = "foulfox-app-latest";
const ROLLING_MANIFEST = "foulfox-app-latest.json";

const DATA_DIR = process.env.ODYSSEUS_DATA_DIR || "/var/lib/foulfox";
const STATUS_FILE = path.join(DATA_DIR, "updates", "status.json");

// The active release records its identity at <app-root>/.foulfox-app-version.
// __dirname is .../app-current/artifacts/api-server/dist → ../../.. = app root.
const VERSION_FILE = path.resolve(__dirname, "..", "..", "..", ".foulfox-app-version");

// "owner/repo", GitHub-legal chars only (mirrors routes/release.ts).
const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

function normalizeRepo(raw: string): string {
  return raw
    .trim()
    .replace(/^git@github\.com:/i, "")
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/^\/+|\/+$/g, "");
}

// Signature verification is a deferred seam, so https is the only thing stopping
// a network attacker from swapping the manifest (and thus the sha256 + bundle URL
// the device trusts). Require it for an explicitly configured manifest too — the
// GitHub-derived URL is already https.
function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function resolveManifestUrl(): { url: string | null; repo: string | null; source: "explicit" | "github" | null } {
  const explicit = process.env.FOULFOX_APP_MANIFEST_URL?.trim();
  if (explicit && isHttpsUrl(explicit)) {
    return { url: explicit, repo: null, source: "explicit" };
  }
  const repoEnv = process.env.FOULFOX_GITHUB_REPO?.trim();
  const normalized = repoEnv ? normalizeRepo(repoEnv) : null;
  const repo = normalized && REPO_RE.test(normalized) ? normalized : null;
  if (repo) {
    return {
      url: `https://github.com/${repo}/releases/download/${ROLLING_TAG}/${ROLLING_MANIFEST}`,
      repo,
      source: "github",
    };
  }
  return { url: null, repo: null, source: null };
}

function readCurrentVersion(): string | null {
  const envVer = process.env.FOULFOX_APP_VERSION?.trim();
  if (envVer) return envVer;
  try {
    const parsed = JSON.parse(fs.readFileSync(VERSION_FILE, "utf8")) as { version?: string };
    return parsed.version?.trim() || null;
  } catch {
    return null;
  }
}

// ── manifest fetch (cached, like release.ts's availability probe) ─────────────
interface Manifest {
  version?: string;
  commit?: string;
  channel?: string;
  bundleUrl?: string;
  sha256?: string;
  sizeBytes?: number;
  builtAt?: string;
  minCompatibleAppVersion?: string | null;
  notes?: string;
}
type ManifestCache = { manifest: Manifest | null; expires: number };
const manifestCache = new Map<string, ManifestCache>();
const HIT_TTL_MS = 5 * 60_000;
const MISS_TTL_MS = 30_000;
const FETCH_TIMEOUT_MS = 8_000;

async function fetchManifest(url: string): Promise<Manifest | null> {
  const now = Date.now();
  const cached = manifestCache.get(url);
  if (cached && cached.expires > now) return cached.manifest;

  let manifest: Manifest | null = null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { redirect: "follow", signal: controller.signal });
    if (resp.status >= 200 && resp.status < 300) {
      manifest = (await resp.json()) as Manifest;
    }
  } catch {
    manifest = null;
  } finally {
    clearTimeout(timer);
  }
  manifestCache.set(url, { manifest, expires: now + (manifest ? HIT_TTL_MS : MISS_TTL_MS) });
  return manifest;
}

const router: IRouter = Router();

// GET /os/app-update-info — current vs latest, for the shell's "App updates" panel.
router.get("/os/app-update-info", async (_req: Request, res: Response) => {
  const currentVersion = readCurrentVersion();
  const { url, repo, source } = resolveManifestUrl();

  if (!url) {
    res.json({
      available: false,
      status: "unconfigured",
      currentVersion,
      latestVersion: null,
      notes: null,
      builtAt: null,
      sizeBytes: null,
      repo,
      source,
      supported: fs.existsSync(PATCHER),
    });
    return;
  }

  const manifest = await fetchManifest(url);
  const latestVersion = manifest?.version?.trim() || null;

  // ready: an update is downloadable and differs from what we run.
  // current: manifest matches the running version. building: configured but the
  // channel has no (valid) manifest published yet.
  let status: "ready" | "current" | "building";
  let available = false;
  if (!latestVersion) {
    status = "building";
  } else if (currentVersion && currentVersion === latestVersion) {
    status = "current";
  } else {
    status = "ready";
    available = true;
  }

  res.json({
    available,
    status,
    currentVersion,
    latestVersion,
    notes: manifest?.notes ?? null,
    builtAt: manifest?.builtAt ?? null,
    sizeBytes: typeof manifest?.sizeBytes === "number" ? manifest.sizeBytes : null,
    repo,
    source,
    supported: fs.existsSync(PATCHER),
  });
});

// GET /os/update/status — the patcher's live progress (or an idle stub).
router.get("/os/update/status", (_req: Request, res: Response) => {
  try {
    const raw = fs.readFileSync(STATUS_FILE, "utf8");
    res.type("application/json").send(raw);
  } catch {
    res.json({
      phase: "idle",
      state: "idle",
      message: "No update has run yet.",
      currentVersion: readCurrentVersion(),
      targetVersion: null,
      previousVersion: null,
      error: null,
      updatedAt: null,
    });
  }
});

async function runPatcher(action: "apply" | "rollback", res: Response): Promise<void> {
  if (!fs.existsSync(PATCHER)) {
    res.status(501).json({
      started: false,
      error: "Live updates are only available on FoulFox OS (no patcher in this environment).",
    });
    return;
  }
  try {
    // The patcher detaches the real work into a transient systemd unit and
    // returns quickly with {started:...}. -n: never prompt for a password.
    const { stdout } = await execFileAsync("sudo", ["-n", PATCHER, action], { timeout: 20_000 });
    let payload: unknown = null;
    try {
      payload = JSON.parse(stdout.trim());
    } catch {
      payload = { started: true };
    }
    res.json(payload);
  } catch (err) {
    logger.error({ err, action }, "foulfox-patcher invocation failed");
    res.status(500).json({ started: false, error: `Could not start ${action}.` });
  }
}

// POST /os/update/apply — pull + atomically apply the latest app bundle.
router.post("/os/update/apply", (_req: Request, res: Response) => {
  void runPatcher("apply", res);
});

// POST /os/update/rollback — revert to the previous release.
router.post("/os/update/rollback", (_req: Request, res: Response) => {
  void runPatcher("rollback", res);
});

export default router;

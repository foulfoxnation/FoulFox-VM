import { Router, type IRouter, type Request, type Response } from "express";
import { execFile } from "child_process";
import { existsSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import http from "http";
import os from "os";
import { logger } from "../lib/logger";
import { netQuietRemaining, netQuietMessage } from "../lib/net-quiet";

// ── Odysseus patch updater ─────────────────────────────────────────────────────
// Keeps the embedded Odysseus agent (artifacts/odysseus-service) in sync with
// its upstream Git repository. One button in the shell drives three cases:
//   - up to date            → nothing to do (UI toasts "up to date")
//   - behind upstream       → pull the newest code and restart the agent
//   - missing OR broken     → same sync acts as an install/repair
//
// The vendored service directory is NOT its own git checkout (it lives inside
// the app monorepo), so upstream state is tracked with a marker file holding
// the last-synced upstream commit. The sync itself is: shallow-clone upstream
// to a temp dir, rsync it over the service dir (PRESERVING data/, .venv/ and
// the marker-independent local state), then restart the service.

const UPSTREAM_REPO =
  process.env.ODYSSEUS_UPSTREAM_REPO?.trim() ||
  "https://github.com/odysseus-dev/odysseus.git";

const ODYSSEUS_PORT = parseInt(process.env.ODYSSEUS_PORT || "7000", 10);

// Same resolution as odysseus-lifecycle.ts (dist/ → ../.. → artifacts/…).
const ODYSSEUS_DIR = path.resolve(
  process.env.ODYSSEUS_DIR || path.join(__dirname, "..", "..", "odysseus-service"),
);
const MARKER_FILE = path.join(ODYSSEUS_DIR, ".odysseus-upstream-commit");

// Never clobber runtime state, user data, installed apps, or FoulFox-specific
// files when syncing upstream code. rsync's --delete never removes excluded
// paths (we do NOT pass --delete-excluded), so everything listed here is safe
// from both overwrite and deletion.
const SYNC_EXCLUDES = [
  "data/",              // SQLite DB, chroma, caches, user documents, installed apps (apps/ lives under the data dir)
  "apps/",              // defensive: installed FoulFox apps if ever placed here
  ".venv/",             // provisioned python env
  ".git/",
  "__pycache__/",
  "node_modules/",
  "start.sh",           // FoulFox boot script (venv provisioning) — upstream ships its own; keep ours
  ".env",               // local secrets/config
  ".odysseus-upstream-commit",
  ".foulfox-deps-installed",
];

function run(
  cmd: string,
  args: string[],
  timeoutMs: number,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: stdout ?? "", stderr: stderr ?? (err ? err.message : "") });
    });
  });
}

function probeHealthy(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request(
      { hostname: "127.0.0.1", port: ODYSSEUS_PORT, path: "/", method: "GET", timeout: 3000 },
      (res) => resolve(res.statusCode !== undefined && res.statusCode < 500),
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

function localCommit(): string | null {
  try {
    const v = readFileSync(MARKER_FILE, "utf8").trim();
    return /^[0-9a-f]{7,40}$/i.test(v) ? v : null;
  } catch {
    return null;
  }
}

async function remoteCommit(): Promise<string | null> {
  const r = await run("git", ["ls-remote", UPSTREAM_REPO, "HEAD"], 20_000);
  if (!r.ok) return null;
  const sha = r.stdout.split(/\s+/)[0]?.trim();
  return sha && /^[0-9a-f]{40}$/i.test(sha) ? sha : null;
}

// ── background sync job (one at a time) ───────────────────────────────────────
type JobState = "idle" | "running" | "done" | "error";
let job: { state: JobState; message: string; startedAt: string | null; finishedAt: string | null } = {
  state: "idle",
  message: "No update has run yet.",
  startedAt: null,
  finishedAt: null,
};

async function restartOdysseus(): Promise<string> {
  // Appliance: systemd unit (passwordless sudo granted by the OS sudoers rule).
  const sysd = await run("sudo", ["-n", "systemctl", "restart", "odysseus-service"], 20_000);
  if (sysd.ok) return "restarted";
  // Dev / non-appliance: no systemd — the running process keeps serving the old
  // code until its workflow restarts. Say so honestly instead of pretending.
  logger.warn({ stderr: sysd.stderr }, "odysseus-update: systemd restart unavailable");
  return "updated on disk — restart the Odysseus service to load it";
}

async function runSync(target: string | null): Promise<void> {
  const tmp = path.join(os.tmpdir(), `odysseus-upstream-${Date.now()}`);
  try {
    job = { state: "running", message: "Downloading the latest Odysseus…", startedAt: new Date().toISOString(), finishedAt: null };

    const clone = await run("git", ["clone", "--depth", "1", UPSTREAM_REPO, tmp], 300_000);
    if (!clone.ok) throw new Error(`download failed: ${clone.stderr.slice(0, 300)}`);

    const head = await run("git", ["-C", tmp, "rev-parse", "HEAD"], 10_000);
    const sha = head.ok ? head.stdout.trim() : target;

    job.message = "Installing the update…";
    const rsyncArgs = ["-a", "--delete-after", ...SYNC_EXCLUDES.flatMap((e) => ["--exclude", e]), `${tmp}/`, `${ODYSSEUS_DIR}/`];
    const sync = await run("rsync", rsyncArgs, 300_000);
    if (!sync.ok) throw new Error(`install failed: ${sync.stderr.slice(0, 300)}`);

    if (sha) writeFileSync(MARKER_FILE, `${sha}\n`);

    job.message = "Restarting Odysseus…";
    const note = await restartOdysseus();

    job = { ...job, state: "done", message: `Odysseus is up to date (${note}).`, finishedAt: new Date().toISOString() };
    logger.info({ sha }, "odysseus-update: sync complete");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    job = { ...job, state: "error", message: msg, finishedAt: new Date().toISOString() };
    logger.error({ err: msg }, "odysseus-update: sync failed");
  } finally {
    void run("rm", ["-rf", tmp], 60_000);
  }
}

const router: IRouter = Router();

// GET /os/odysseus-update/check — what state is Odysseus in, and is there work?
router.get("/os/odysseus-update/check", async (_req: Request, res: Response) => {
  const quiet = netQuietRemaining();
  if (quiet > 0) {
    res.status(503).json({ error: netQuietMessage(quiet) });
    return;
  }
  const installed = existsSync(path.join(ODYSSEUS_DIR, "app.py"));
  const [healthy, local, remote] = await Promise.all([
    installed ? probeHealthy() : Promise.resolve(false),
    Promise.resolve(localCommit()),
    remoteCommit(),
  ]);
  if (!remote) {
    res.status(502).json({ error: "Could not reach the Odysseus update server (GitHub)." });
    return;
  }
  // action: what pressing the button should do.
  const action = !installed ? "install" : !healthy ? "repair" : local !== remote ? "update" : "none";
  res.json({
    installed,
    healthy,
    localCommit: local,
    remoteCommit: remote,
    upToDate: action === "none",
    updating: job.state === "running",
    action,
  });
});

// POST /os/odysseus-update/apply — pull upstream and install (also = repair).
router.post("/os/odysseus-update/apply", async (_req: Request, res: Response) => {
  const quiet = netQuietRemaining();
  if (quiet > 0) {
    res.status(503).json({ started: false, error: netQuietMessage(quiet) });
    return;
  }
  if (job.state === "running") {
    res.status(409).json({ started: false, error: "An Odysseus update is already running." });
    return;
  }
  void runSync(null);
  res.json({ started: true });
});

// GET /os/odysseus-update/status — live progress of the background sync.
router.get("/os/odysseus-update/status", (_req: Request, res: Response) => {
  res.json(job);
});

export default router;

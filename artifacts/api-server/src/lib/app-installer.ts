// FoulFox App fetch + install engine.
//
// Flow (per install job, run asynchronously; the client polls for progress):
//   cloning   -> git clone --depth 1 the GitHub repo into a staging dir
//   parsing   -> read + validate foxapp.json (id, runtime, argv commands, caps)
//   installing-> run the manifest's install commands (argv arrays, no shell)
//   building  -> run the manifest's build commands
//   done/error
//
// SECURITY MODEL: installing an app necessarily runs that repo's own install
// scripts (npm ci runs lifecycle scripts, etc.), so this is trusted-on-install.
// The guardrails that remain meaningful:
//   - clone source is allowlisted to github.com over https (normalizeGithubUrl)
//   - commands are spawned as argv arrays WITHOUT a shell (no metachar expansion)
//   - the app id is a validated slug before any path is built from it
//   - commands run with cwd confined to the cloned repo and a MINIMAL env
//     (no shell/session/internal tokens, no DB URLs, no broad process.env)
//   - per-step timeouts with process-group kills, and capped logs

import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { logger } from "./logger";
import {
  validateManifest,
  type AppCapability,
  type FoxAppManifest,
} from "./app-manifest";
import {
  STAGING_DIR,
  appDir,
  appRepoDir,
  appDataDir,
  appInstallLogPath,
  getApp,
  saveApp,
  updateApp,
} from "./app-registry";

const CLONE_TIMEOUT_MS = 180_000;
const UNZIP_TIMEOUT_MS = 180_000;
const STEP_TIMEOUT_MS = 600_000;
const LOG_TAIL_BYTES = 256 * 1024; // in-memory tail returned to the poller
const FILE_CAP_BYTES = 4 * 1024 * 1024; // cap the persisted install.log
const MAX_CONCURRENT = 3;
const JOB_TTL_MS = 60 * 60_000;

export type InstallPhase =
  | "cloning"
  | "extracting"
  | "parsing"
  | "installing"
  | "building"
  | "done"
  | "error";

// Where an install job's source tree comes from: a GitHub clone, an uploaded
// zip archive already sitting on local disk, or a reinstall that skips fetch
// and re-runs the install/build steps from the already-present repo dir.
export type InstallSource =
  | { kind: "git"; repoUrl: string }
  | { kind: "zip"; zipPath: string; fileName: string }
  | { kind: "reinstall"; appId: string };

export interface InstallJob {
  jobId: string;
  repoUrl: string; // as entered by the user
  phase: InstallPhase;
  appId: string | null;
  appName: string | null;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
  log: string; // capped tail
}

const jobs = new Map<string, InstallJob>();
const installingIds = new Set<string>();
let active = 0;

const OWNER_REPO_RE = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/;

// Accept https://github.com/owner/repo[.git][/...], git@github.com:owner/repo,
// and bare "owner/repo"; reject everything else (other hosts, ssh elsewhere,
// file/ssh/git protocols). Returns a canonical https clone URL.
export function normalizeGithubUrl(raw: string): { cloneUrl: string; slug: string } {
  const input = (raw || "").trim();
  if (!input) throw new Error("A GitHub repository URL is required.");

  let ownerRepo: string | null = null;

  const ssh = input.match(/^git@github\.com:(.+)$/i);
  if (ssh) {
    ownerRepo = ssh[1];
  } else if (/^[a-z]+:\/\//i.test(input)) {
    let u: URL;
    try {
      u = new URL(input);
    } catch {
      throw new Error("That doesn't look like a valid URL.");
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") {
      throw new Error("Only https GitHub URLs are supported.");
    }
    if (u.hostname.toLowerCase() !== "github.com") {
      throw new Error("Only github.com repositories are supported.");
    }
    ownerRepo = u.pathname.replace(/^\/+/, "");
  } else {
    ownerRepo = input; // "owner/repo" shorthand
  }

  ownerRepo = ownerRepo
    .replace(/\.git$/i, "")
    .replace(/^\/+|\/+$/g, "");
  const parts = ownerRepo.split("/").filter(Boolean);
  if (parts.length < 2) {
    throw new Error("Use a GitHub URL like https://github.com/owner/repo.");
  }
  const owner = parts[0];
  const repo = parts[1]; // ignore any deeper path (e.g. /tree/main)
  if (!OWNER_REPO_RE.test(`${owner}/${repo}`)) {
    throw new Error("That doesn't look like a valid GitHub owner/repo.");
  }
  return { cloneUrl: `https://github.com/${owner}/${repo}.git`, slug: `${owner}/${repo}` };
}

// Captures process output to both the in-memory job tail and a capped file.
class InstallLog {
  private filePath: string | null = null;
  private fileBytes = 0;
  private truncated = false;
  constructor(private job: InstallJob) {}

  write(text: string): void {
    this.job.log += text;
    if (this.job.log.length > LOG_TAIL_BYTES) {
      this.job.log = this.job.log.slice(this.job.log.length - LOG_TAIL_BYTES);
    }
    if (this.filePath) this.toFile(text);
  }

  // Start persisting to disk, flushing whatever preamble (clone/parse) we have.
  attachFile(p: string): void {
    this.filePath = p;
    try {
      fs.writeFileSync(p, this.job.log);
      this.fileBytes = Buffer.byteLength(this.job.log);
    } catch (err) {
      logger.warn({ err }, "could not open app install log file");
      this.filePath = null;
    }
  }

  private toFile(text: string): void {
    if (!this.filePath) return;
    if (this.fileBytes >= FILE_CAP_BYTES) {
      if (!this.truncated) {
        try {
          fs.appendFileSync(this.filePath, "\n[log truncated]\n");
        } catch {
          /* ignore */
        }
        this.truncated = true;
      }
      return;
    }
    try {
      fs.appendFileSync(this.filePath, text);
      this.fileBytes += Buffer.byteLength(text);
    } catch {
      /* ignore */
    }
  }
}

// git needs PATH + HOME (config); never prompt for credentials so private repos
// fail fast instead of hanging.
function cloneEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    GIT_TERMINAL_PROMPT: "0",
  };
}

// Minimal, deliberately narrow env for the app's own install/build commands.
function buildAppEnv(id: string, manifest: FoxAppManifest): NodeJS.ProcessEnv {
  const dataDir = appDataDir(id);
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: process.env.LANG,
    TERM: "dumb",
    NODE_ENV: "production",
    GIT_TERMINAL_PROMPT: "0",
  };
  env[manifest.dataEnv] = dataDir;
  env.FOULFOX_APP_DATA_DIR = dataDir;
  env.FOULFOX_APP_ID = id;
  return env;
}

function runStep(
  argv: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  log: InstallLog,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const [bin, ...args] = argv;
    let child: ReturnType<typeof spawn>;
    try {
      // detached: own process group so a timeout can SIGKILL the whole subtree
      // (e.g. npm + the package manager's children), not just the parent.
      child = spawn(bin, args, {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    let finished = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      const pid = child.pid;
      try {
        if (pid) process.kill(-pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }
    }, timeoutMs);

    child.stdout?.on("data", (b: Buffer) => log.write(b.toString()));
    child.stderr?.on("data", (b: Buffer) => log.write(b.toString()));

    child.on("error", (err: NodeJS.ErrnoException) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (err.code === "ENOENT") reject(new Error(`"${bin}" is not installed on this host.`));
      else reject(err);
    });

    child.on("close", (code: number | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s: ${argv.join(" ")}`));
      } else if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Command failed (exit ${code ?? "?"}): ${argv.join(" ")}`));
      }
    });
  });
}

function pruneJobs(): void {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, j] of jobs) {
    if (j.finishedAt && j.finishedAt < cutoff) jobs.delete(id);
  }
}

export function getJob(jobId: string): InstallJob | undefined {
  return jobs.get(jobId);
}

export function startInstall(repoUrl: string, approvedCaps: AppCapability[]): InstallJob {
  return startInstallJob({ kind: "git", repoUrl }, approvedCaps);
}

export function startInstallFromZip(
  zipPath: string,
  fileName: string,
  approvedCaps: AppCapability[],
): InstallJob {
  return startInstallJob({ kind: "zip", zipPath, fileName }, approvedCaps);
}

export function startReinstall(appId: string, approvedCaps: AppCapability[]): InstallJob {
  const existing = getApp(appId);
  if (!existing) throw new Error(`No app with id "${appId}" is installed.`);
  const repoDir = appRepoDir(appId);
  if (!fs.existsSync(repoDir)) {
    throw new Error(
      "The app's repo directory is missing — uninstall and reinstall the app instead.",
    );
  }
  return startInstallJob({ kind: "reinstall", appId }, approvedCaps);
}

function startInstallJob(source: InstallSource, approvedCaps: AppCapability[]): InstallJob {
  pruneJobs();
  if (active >= MAX_CONCURRENT) {
    throw new Error("Too many installs are running right now — try again in a moment.");
  }
  const jobId = crypto.randomBytes(8).toString("hex");
  const job: InstallJob = {
    jobId,
    repoUrl:
      source.kind === "git"
        ? source.repoUrl
        : source.kind === "zip"
          ? `upload:${source.fileName}`
          : `reinstall:${source.appId}`,
    phase: source.kind === "git" ? "cloning" : source.kind === "zip" ? "extracting" : "parsing",
    appId: null,
    appName: null,
    error: null,
    startedAt: Date.now(),
    finishedAt: null,
    log: "",
  };
  jobs.set(jobId, job);
  active++;
  void runInstall(job, source, approvedCaps)
    .catch((err) => logger.error({ err, jobId }, "app install crashed"))
    .finally(() => {
      active = Math.max(0, active - 1);
    });
  return job;
}

async function runInstall(
  job: InstallJob,
  source: InstallSource,
  approvedCaps: AppCapability[],
): Promise<void> {
  const log = new InstallLog(job);
  const staging = path.join(STAGING_DIR, job.jobId);
  let lockedId: string | null = null;

  try {
    fs.mkdirSync(STAGING_DIR, { recursive: true });
    try {
      fs.rmSync(staging, { recursive: true, force: true });
    } catch {
      /* ignore */
    }

    // ── fetch: clone the repo, extract zip, or skip (reinstall) ──────────────
    let sourceLabel: string;
    let srcRoot = staging; // dir that must contain foxapp.json
    if (source.kind === "reinstall") {
      // Re-use the existing repo directory verbatim — no clone or extract.
      // The staging dir is not needed; jump straight to parsing.
      srcRoot = appRepoDir(source.appId);
      sourceLabel = `reinstall:${source.appId}`;
      log.write(`Rerunning setup for ${source.appId} (using existing repo)…\n`);
    } else if (source.kind === "git") {
      job.phase = "cloning";
      const { cloneUrl } = normalizeGithubUrl(source.repoUrl);
      sourceLabel = cloneUrl;
      log.write(`$ git clone --depth 1 ${cloneUrl}\n`);
      await runStep(
        ["git", "clone", "--depth", "1", cloneUrl, staging],
        STAGING_DIR,
        cloneEnv(),
        log,
        CLONE_TIMEOUT_MS,
      );
    } else {
      job.phase = "extracting";
      sourceLabel = `upload:${source.fileName}`;
      fs.mkdirSync(staging, { recursive: true });
      log.write(`$ unzip -q ${source.fileName}\n`);
      // -q quiet, -o overwrite; argv (no shell) and confined to the staging dir.
      await runStep(
        ["unzip", "-q", "-o", source.zipPath, "-d", staging],
        STAGING_DIR,
        cloneEnv(),
        log,
        UNZIP_TIMEOUT_MS,
      );
      // Fix permissions: zips from macOS/Windows often store files with
      // restrictive modes (e.g. assets/ dir as 0700) that prevent the web
      // server from reading them — express.static returns 403 on EACCES.
      // Make every file world-readable and every directory world-traversable.
      try {
        await runStep(["chmod", "-R", "a+rX", staging], STAGING_DIR, cloneEnv(), log, 30_000);
      } catch {
        /* best-effort — non-fatal */
      }
      try {
        fs.rmSync(source.zipPath, { force: true });
      } catch {
        /* ignore */
      }
      // Zips made by GitHub ("Download ZIP") or by zipping a folder usually wrap
      // everything in a single top-level directory — descend into it.
      if (!fs.existsSync(path.join(staging, "foxapp.json"))) {
        const entries = fs
          .readdirSync(staging, { withFileTypes: true })
          .filter((e) => !e.name.startsWith("__MACOSX"));
        if (
          entries.length === 1 &&
          entries[0].isDirectory() &&
          fs.existsSync(path.join(staging, entries[0].name, "foxapp.json"))
        ) {
          srcRoot = path.join(staging, entries[0].name);
        }
      }
    }

    // ── parse + validate manifest ──────────────────────────────────────────────
    job.phase = "parsing";
    const manifestPath = path.join(srcRoot, "foxapp.json");
    if (!fs.existsSync(manifestPath)) {
      throw new Error(
        source.kind === "git"
          ? "This repository has no foxapp.json at its root, so it isn't a FoulFox App."
          : "This zip has no foxapp.json at its root (or inside its single top-level folder), so it isn't a FoulFox App.",
      );
    }
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    } catch {
      throw new Error("foxapp.json is not valid JSON.");
    }
    const result = validateManifest(raw);
    if (!result.ok) {
      throw new Error("Invalid foxapp.json:\n- " + result.errors.join("\n- "));
    }
    const manifest = result.manifest;
    const id = manifest.id;
    job.appId = id;
    job.appName = manifest.name;
    const granted = manifest.capabilities.filter((c) => approvedCaps.includes(c));
    log.write(
      `\nManifest OK: ${manifest.name} v${manifest.version} (id: ${id}, runtime: ${manifest.runtime})\n`,
    );
    if (manifest.capabilities.length) {
      log.write(`Requested capabilities: ${manifest.capabilities.join(", ")}\n`);
    }

    // ── per-id lock (prevents concurrent install/update of the same app) ───────
    if (installingIds.has(id)) {
      throw new Error(`Another install of "${id}" is already in progress.`);
    }
    installingIds.add(id);
    lockedId = id;

    // ── relocate into the app's permanent home; preserve the data dir ──────────
    const repoDir = appRepoDir(id);
    const dataDir = appDataDir(id);
    fs.mkdirSync(appDir(id), { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    if (source.kind !== "reinstall") {
      // For clone/zip installs: replace the existing repo dir with the freshly
      // fetched source. For reinstalls the repo dir IS srcRoot, so skip rm+rename.
      try {
        fs.rmSync(repoDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      try {
        fs.renameSync(srcRoot, repoDir);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EXDEV") {
          fs.cpSync(srcRoot, repoDir, { recursive: true });
        } else {
          throw err;
        }
      }
    }
    // Drop whatever is left of staging (e.g. the emptied zip wrapper dir).
    try {
      fs.rmSync(staging, { recursive: true, force: true });
    } catch {
      /* ignore */
    }

    // Persist the log from here on (flushes the clone/parse preamble too).
    log.attachFile(appInstallLogPath(id));

    const existing = getApp(id);
    const now = Date.now();
    // On reinstall keep the original repoUrl so the UI still shows the source.
    const recordRepoUrl =
      source.kind === "reinstall" ? (existing?.repoUrl ?? sourceLabel) : sourceLabel;
    saveApp({
      id,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      icon: manifest.icon,
      repoUrl: recordRepoUrl,
      runtime: manifest.runtime,
      capabilities: manifest.capabilities,
      grantedCapabilities: granted,
      status: "installing",
      error: null,
      manifest,
      createdAt: existing?.createdAt ?? now,
      installedAt: existing?.installedAt ?? null,
      updatedAt: now,
    });

    const env = buildAppEnv(id, manifest);

    // ── install steps ──────────────────────────────────────────────────────────
    job.phase = "installing";
    for (const argv of manifest.install) {
      log.write(`\n$ ${argv.join(" ")}\n`);
      await runStep(argv, repoDir, env, log, STEP_TIMEOUT_MS);
    }

    // ── build steps ────────────────────────────────────────────────────────────
    job.phase = "building";
    for (const argv of manifest.build) {
      log.write(`\n$ ${argv.join(" ")}\n`);
      await runStep(argv, repoDir, env, log, STEP_TIMEOUT_MS);
    }

    updateApp(id, (a) => {
      a.status = "installed";
      a.error = null;
      a.installedAt = Date.now();
    });
    job.phase = "done";
    job.finishedAt = Date.now();
    log.write(`\nInstalled ${manifest.name} successfully.\n`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    job.error = message;
    job.phase = "error";
    job.finishedAt = Date.now();
    log.write(`\nERROR: ${message}\n`);
    if (job.appId) {
      try {
        updateApp(job.appId, (a) => {
          a.status = "error";
          a.error = message;
        });
      } catch {
        /* ignore */
      }
    }
    logger.warn({ jobId: job.jobId, err: message }, "app install failed");
  } finally {
    if (lockedId) installingIds.delete(lockedId);
    if (source.kind === "zip") {
      // If extraction failed before the post-unzip cleanup ran, don't orphan
      // the temp zip in the staging dir.
      try {
        fs.rmSync(source.zipPath, { force: true });
      } catch {
        /* ignore */
      }
    }
    try {
      fs.rmSync(staging, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

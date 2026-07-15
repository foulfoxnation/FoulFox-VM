// FoulFox App fetch/install HTTP API. Mounted under /api by the route index and
// guarded in app.ts with localhostOnly + requireStateChangeToken (read-only GETs
// pass; POST/DELETE require the shell token or Odysseus internal token).
//
// Scope is fetch + install only. Running/launching an installed app, the broker
// API, the app-window UI and autostart are intentionally NOT implemented here.

import { Router, type IRouter, type Request, type Response } from "express";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import {
  listApps,
  getApp,
  deleteApp,
  appDir,
  appInstallLogPath,
  STAGING_DIR,
  type AppRecord,
} from "../lib/app-registry";
import { startInstall, startInstallFromZip, getJob } from "../lib/app-installer";
import { ALLOWED_CAPABILITIES, type AppCapability } from "../lib/app-manifest";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// In this project req.params values are typed `string | string[]`; these routes
// each use a single value, so normalize to a plain string.
function pathParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

// The full manifest is heavy and internal; expose a stable summary instead.
function summarize(a: AppRecord) {
  return {
    id: a.id,
    name: a.name,
    version: a.version,
    description: a.description,
    icon: a.icon,
    runtime: a.runtime,
    status: a.status,
    error: a.error,
    capabilities: a.capabilities,
    grantedCapabilities: a.grantedCapabilities,
    repoUrl: a.repoUrl,
    uiPath: a.manifest.uiPath,
    hasWindow: !!a.manifest.window,
    autostart: a.manifest.autostart,
    createdAt: a.createdAt,
    installedAt: a.installedAt,
    updatedAt: a.updatedAt,
  };
}

// POST /apps/install — kick off an async install; returns a job id to poll.
router.post("/apps/install", (req: Request, res: Response) => {
  const repoUrl = typeof req.body?.repoUrl === "string" ? req.body.repoUrl.trim() : "";
  if (!repoUrl) {
    res.status(400).json({ error: "A GitHub repository URL is required." });
    return;
  }
  // The client approves which capabilities it's willing to grant; the installer
  // grants the intersection with what the manifest actually requests. Default to
  // the full supported set when omitted.
  const rawCaps = Array.isArray(req.body?.capabilities)
    ? (req.body.capabilities as unknown[])
    : ALLOWED_CAPABILITIES;
  const approved = rawCaps.filter(
    (c): c is AppCapability =>
      typeof c === "string" && (ALLOWED_CAPABILITIES as readonly string[]).includes(c),
  );
  try {
    const job = startInstall(repoUrl, approved);
    res.status(202).json({ jobId: job.jobId, status: "installing" });
  } catch (err) {
    res.status(503).json({ error: err instanceof Error ? err.message : "Could not start install." });
  }
});

// Approved-capability list from a request body (shared by all install routes).
function approvedCaps(body: unknown): AppCapability[] {
  const raw = Array.isArray((body as { capabilities?: unknown })?.capabilities)
    ? ((body as { capabilities: unknown[] }).capabilities)
    : ALLOWED_CAPABILITIES;
  return raw.filter(
    (c): c is AppCapability =>
      typeof c === "string" && (ALLOWED_CAPABILITIES as readonly string[]).includes(c),
  );
}

const MAX_ZIP_BYTES = 1024 * 1024 * 1024; // 1 GiB — apps should be lean; models download at runtime
const SAFE_NAME_RE = /[^A-Za-z0-9._-]+/g;

// POST /apps/install-zip?name=<file.zip> — upload a zip from the browser.
// The raw request body IS the zip (Content-Type: application/zip), streamed to
// a temp file under the apps staging dir, then installed like a cloned repo.
router.post("/apps/install-zip", (req: Request, res: Response) => {
  const rawName = typeof req.query.name === "string" ? req.query.name : "app.zip";
  const fileName = rawName.replace(SAFE_NAME_RE, "_").slice(0, 128) || "app.zip";
  if (!/\.zip$/i.test(fileName)) {
    res.status(400).json({ error: "The uploaded file must be a .zip archive." });
    return;
  }
  // Capabilities can't ride in the body (it's the zip); accept them via query.
  const capsParam = typeof req.query.capabilities === "string" ? req.query.capabilities : "";
  const caps = approvedCaps({
    capabilities: capsParam ? capsParam.split(",").map((s) => s.trim()) : undefined,
  });

  const tmpPath = path.join(
    STAGING_DIR,
    `upload-${crypto.randomBytes(6).toString("hex")}.zip`,
  );
  try {
    fs.mkdirSync(STAGING_DIR, { recursive: true });
  } catch (err) {
    logger.error({ err }, "could not create apps staging dir");
    res.status(500).json({ error: "Could not prepare the upload area." });
    return;
  }

  const out = fs.createWriteStream(tmpPath);
  let bytes = 0;
  let failed = false;
  const fail = (status: number, message: string) => {
    if (failed) return;
    failed = true;
    try {
      out.destroy();
      fs.rmSync(tmpPath, { force: true });
    } catch {
      /* ignore */
    }
    req.destroy();
    if (!res.headersSent) res.status(status).json({ error: message });
  };

  req.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > MAX_ZIP_BYTES) {
      fail(413, "Zip is too large (max 1 GiB). Keep model weights out of the app package.");
    }
  });
  req.on("error", () => fail(400, "Upload interrupted."));
  req.pipe(out);
  out.on("error", () => fail(500, "Could not write the upload to disk."));
  out.on("finish", () => {
    if (failed) return;
    if (bytes === 0) {
      fail(400, "The upload was empty.");
      return;
    }
    try {
      const job = startInstallFromZip(tmpPath, fileName, caps);
      res.status(202).json({ jobId: job.jobId, status: "installing" });
    } catch (err) {
      try {
        fs.rmSync(tmpPath, { force: true });
      } catch {
        /* ignore */
      }
      res
        .status(503)
        .json({ error: err instanceof Error ? err.message : "Could not start install." });
    }
  });
});

// POST /apps/install-file — install a zip already on this machine, e.g. on a
// plugged-in flash drive (/media, /run/media, /mnt). The zip is COPIED into
// staging first so the user can unplug the drive as soon as install starts.
router.post("/apps/install-file", (req: Request, res: Response) => {
  const p = typeof req.body?.path === "string" ? req.body.path.trim() : "";
  if (!p || p.includes("\0")) {
    res.status(400).json({ error: "An absolute path to a .zip file is required." });
    return;
  }
  const abs = path.resolve(p);
  if (!/\.zip$/i.test(abs)) {
    res.status(400).json({ error: "The file must be a .zip archive." });
    return;
  }
  let st: fs.Stats;
  try {
    st = fs.statSync(abs);
  } catch {
    res.status(404).json({ error: "File not found. Is the drive still plugged in?" });
    return;
  }
  if (!st.isFile()) {
    res.status(400).json({ error: "That path is not a file." });
    return;
  }
  if (st.size > MAX_ZIP_BYTES) {
    res.status(413).json({ error: "Zip is too large (max 1 GiB)." });
    return;
  }
  const tmpPath = path.join(
    STAGING_DIR,
    `usb-${crypto.randomBytes(6).toString("hex")}.zip`,
  );
  try {
    fs.mkdirSync(STAGING_DIR, { recursive: true });
    fs.copyFileSync(abs, tmpPath);
  } catch (err) {
    logger.warn({ err, abs }, "could not copy zip from drive");
    res.status(500).json({ error: "Could not read the file from the drive." });
    return;
  }
  try {
    const job = startInstallFromZip(tmpPath, path.basename(abs), approvedCaps(req.body));
    res.status(202).json({ jobId: job.jobId, status: "installing" });
  } catch (err) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      /* ignore */
    }
    res
      .status(503)
      .json({ error: err instanceof Error ? err.message : "Could not start install." });
  }
});

// GET /apps/install/:jobId — install progress + captured log tail. Declared
// before /apps/:id so "install" is never matched as an app id.
router.get("/apps/install/:jobId", (req: Request, res: Response) => {
  const job = getJob(pathParam(req.params.jobId));
  if (!job) {
    res.status(404).json({ error: "Unknown or expired install job." });
    return;
  }
  res.json({
    jobId: job.jobId,
    phase: job.phase,
    appId: job.appId,
    appName: job.appName,
    error: job.error,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    log: job.log,
  });
});

// GET /apps — installed apps (summaries).
router.get("/apps", (_req: Request, res: Response) => {
  res.json({ apps: listApps().map(summarize) });
});

// GET /apps/:id/logs — the persisted install/build log (plain text). Declared
// before /apps/:id.
router.get("/apps/:id/logs", (req: Request, res: Response) => {
  const id = pathParam(req.params.id);
  if (!getApp(id)) {
    res.status(404).json({ error: "No such app." });
    return;
  }
  try {
    res.type("text/plain").send(fs.readFileSync(appInstallLogPath(id), "utf-8"));
  } catch {
    res.type("text/plain").send("");
  }
});

// GET /apps/:id — a single app summary.
router.get("/apps/:id", (req: Request, res: Response) => {
  const a = getApp(pathParam(req.params.id));
  if (!a) {
    res.status(404).json({ error: "No such app." });
    return;
  }
  res.json(summarize(a));
});

// DELETE /apps/:id — uninstall: drop from the registry and remove its directory
// (repo, data and logs). This is destructive — the UI confirms first.
router.delete("/apps/:id", (req: Request, res: Response) => {
  const id = pathParam(req.params.id);
  if (!getApp(id)) {
    res.status(404).json({ error: "No such app." });
    return;
  }
  deleteApp(id);
  try {
    fs.rmSync(appDir(id), { recursive: true, force: true });
  } catch (err) {
    logger.warn({ err, id }, "failed to remove app directory");
  }
  res.json({ ok: true });
});

export default router;

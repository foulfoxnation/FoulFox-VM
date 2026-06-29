// FoulFox App fetch/install HTTP API. Mounted under /api by the route index and
// guarded in app.ts with localhostOnly + requireStateChangeToken (read-only GETs
// pass; POST/DELETE require the shell token or Odysseus internal token).
//
// Scope is fetch + install only. Running/launching an installed app, the broker
// API, the app-window UI and autostart are intentionally NOT implemented here.

import { Router, type IRouter, type Request, type Response } from "express";
import fs from "fs";
import {
  listApps,
  getApp,
  deleteApp,
  appDir,
  appInstallLogPath,
  type AppRecord,
} from "../lib/app-registry";
import { startInstall, getJob } from "../lib/app-installer";
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

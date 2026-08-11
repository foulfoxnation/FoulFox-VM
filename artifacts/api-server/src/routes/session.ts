/**
 * Session portal API routes.
 *
 * GET  /api/session/info         — machine info + active VMs + WS paths
 * POST /api/session/view-token   — create a shareable read-only session token
 */

import { Router, type Request, type Response } from "express";
import os from "os";
import { listVms, getRuntime } from "../lib/vm-registry";
import { detectHostCapabilities } from "../lib/vm-capabilities";
import { SHELL_SESSION_TOKEN } from "../lib/shell-token";
import { createViewToken, isValidViewToken } from "../lib/view-tokens";
import { logger } from "../lib/logger";

const router = Router();

// ── Auth helpers ───────────────────────────────────────────────────────────────

function isAuthorized(req: Request): boolean {
  const headerToken = req.headers["x-shell-token"] as string | undefined;
  const queryToken  = req.query["token"] as string | undefined;
  if (headerToken === SHELL_SESSION_TOKEN) return true;
  if (queryToken  === SHELL_SESSION_TOKEN) return true;
  if (isValidViewToken(queryToken)) return true;
  return false;
}

// ── GET /session/info ──────────────────────────────────────────────────────────

router.get("/session/info", async (req: Request, res: Response) => {
  if (!isAuthorized(req)) {
    res.status(401).json({ error: "Missing or invalid session token" });
    return;
  }

  let caps: Awaited<ReturnType<typeof detectHostCapabilities>>;
  try {
    caps = await detectHostCapabilities();
  } catch {
    caps = {
      totalRamGb: 0, cpuCount: 0, totalDiskGb: 0, freeDiskGb: 0,
      accelerator: { accel: "none", hardware: false, reason: "unknown" },
      platform: process.platform, arch: process.arch,
      qemuSystem: false, qemuImg: false, appleHost: false,
      osSupport: {} as any,
    };
  }

  const vms = listVms().map((vm) => {
    const rt = getRuntime(vm.id);
    return {
      id:           vm.id,
      name:         vm.name,
      osKind:       vm.osKind,
      state:        rt.state,
      displayToken: rt.state === "running" ? vm.displayToken : null,
    };
  });

  res.json({
    machineName:    os.hostname(),
    platform:       caps.platform ?? os.platform(),
    arch:           caps.arch    ?? os.arch(),
    uptimeSeconds:  Math.floor(os.uptime()),
    totalRamGb:     caps.totalRamGb,
    cpuCount:       caps.cpuCount,
    totalDiskGb:    caps.totalDiskGb,
    freeDiskGb:     caps.freeDiskGb,
    vms,
    logsStreamUrl:  "/api/shell/logs/stream",
    shellWsPath:    "/api/shell/ws",
    displayWsPath:  "/api/vm/ws/display",
  });
});

// ── POST /session/view-token ───────────────────────────────────────────────────

router.post("/session/view-token", (req: Request, res: Response) => {
  // Creating a shareable token requires the real shell token (not a view token).
  const headerToken = req.headers["x-shell-token"] as string | undefined;
  const queryToken  = req.query["token"] as string | undefined;
  if (headerToken !== SHELL_SESSION_TOKEN && queryToken !== SHELL_SESSION_TOKEN) {
    logger.warn({ url: req.url }, "Rejected view-token creation: invalid shell token");
    res.status(401).json({ error: "Shell session token required to create a view token" });
    return;
  }

  const { token, expiresAt } = createViewToken();

  // Build the shareable URL from the request origin.
  const proto = req.headers["x-forwarded-proto"] ?? (req.secure ? "https" : "http");
  const host  = req.headers["x-forwarded-host"] ?? req.headers.host ?? "localhost";
  const sessionUrl = `${proto}://${host}/session-portal/?token=${token}`;

  res.json({
    token,
    expiresAt: new Date(expiresAt).toISOString(),
    sessionUrl,
  });
});

export default router;

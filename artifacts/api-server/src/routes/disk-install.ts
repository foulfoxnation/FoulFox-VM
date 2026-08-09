import { Router, type IRouter, type Request, type Response } from "express";
import { execFile } from "child_process";
import { promisify } from "util";
import { spawn } from "child_process";
import fs from "fs";
import { EventEmitter } from "events";
import { logger } from "../lib/logger";

// ── Disk Install API ──────────────────────────────────────────────────────────
// Installs the live FoulFox OS to a chosen internal disk, replacing whatever
// was there (Windows, blank disk, etc.). All destructive work runs inside the
// foulfox-install-to-disk shell script as root (via sudo).
//
// Routes (all under /api/os, protected by requireStateChangeToken in app.ts):
//   GET  /os/disk-install/candidates  — list candidate internal disks
//   GET  /os/disk-install/status      — current job state (for page reload)
//   GET  /os/disk-install/stream      — SSE live progress feed
//   POST /os/disk-install/start       — launch the install; body: { targetDisk }

const execFileAsync = promisify(execFile);

const INSTALL_HELPER = "/usr/local/sbin/foulfox-install-to-disk";

const router: IRouter = Router();

// ── Job state ──────────────────────────────────────────────────────────────────

type JobStatus = "idle" | "running" | "done" | "error";

interface JobState {
  status: JobStatus;
  step: string;
  pct: number;
  msg: string;
  targetDisk: string | null;
  startedAt: number | null;
  finishedAt: number | null;
}

const job: JobState = {
  status: "idle",
  step: "",
  pct: 0,
  msg: "",
  targetDisk: null,
  startedAt: null,
  finishedAt: null,
};

const bus = new EventEmitter();
bus.setMaxListeners(0);

function patch(update: Partial<JobState>) {
  Object.assign(job, update);
  bus.emit("update", { ...job });
}

// ── Disk detection helpers ─────────────────────────────────────────────────────

interface DiskInfo {
  path: string;
  sizeBytes: number;
  sizeGb: number;
  model: string | null;
  removable: boolean;
  isBootDisk: boolean;
}

interface LsblkNode {
  name?: string;
  path?: string;
  type?: string;
  size?: number | string | null;
  model?: string | null;
  rm?: boolean | string | null;
  mountpoint?: string | null;
  children?: LsblkNode[];
}

async function getBootDisk(): Promise<string | null> {
  // Try live-boot medium first, then fall back to the regular root mount source.
  for (const mountpoint of ["/run/live/medium", "/"]) {
    try {
      const { stdout: src } = await execFileAsync(
        "findmnt", ["-n", "-o", "SOURCE", mountpoint],
        { timeout: 5_000 },
      );
      const part = src.trim().split("\n")[0];
      if (!part) continue;
      const { stdout: pk } = await execFileAsync("lsblk", ["-no", "PKNAME", part], { timeout: 5_000 });
      const name = pk.trim().split("\n")[0];
      if (name) return `/dev/${name}`;
    } catch {
      // not found, try next
    }
  }
  return null;
}

// ── GET /os/disk-install/candidates ───────────────────────────────────────────

router.get("/os/disk-install/candidates", async (_req: Request, res: Response) => {
  const helperAvailable = fs.existsSync(INSTALL_HELPER);

  let bootDisk: string | null = null;
  try {
    bootDisk = await getBootDisk();
  } catch { /* ignore */ }

  const disks: DiskInfo[] = [];
  try {
    const { stdout } = await execFileAsync(
      "lsblk",
      ["-J", "-b", "-o", "NAME,PATH,TYPE,SIZE,MODEL,RM,MOUNTPOINT"],
      { timeout: 5_000 },
    );
    const parsed = JSON.parse(stdout) as { blockdevices?: LsblkNode[] };
    for (const dev of parsed.blockdevices ?? []) {
      if (dev.type !== "disk") continue;
      const path = dev.path ?? (dev.name ? `/dev/${dev.name}` : "");
      if (!path) continue;
      const sizeBytes = typeof dev.size === "string" ? Number(dev.size) || 0 : (dev.size ?? 0);
      disks.push({
        path,
        sizeBytes,
        sizeGb: Math.round(sizeBytes / 1_073_741_824),
        model: dev.model ? String(dev.model).trim() || null : null,
        removable: dev.rm === true || dev.rm === "1",
        isBootDisk: bootDisk !== null && path === bootDisk,
      });
    }
  } catch (err) {
    logger.warn({ err }, "lsblk failed in disk-install candidates");
  }

  res.json({ helperAvailable, bootDisk, disks });
});

// ── GET /os/disk-install/status ────────────────────────────────────────────────

router.get("/os/disk-install/status", (_req: Request, res: Response) => {
  res.json({ ...job });
});

// ── GET /os/disk-install/stream — SSE live progress ───────────────────────────

router.get("/os/disk-install/stream", (req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.write(`data: ${JSON.stringify(job)}\n\n`);

  const handler = (s: JobState) => {
    try { res.write(`data: ${JSON.stringify(s)}\n\n`); } catch { /* client gone */ }
  };
  bus.on("update", handler);
  req.on("close", () => bus.off("update", handler));
});

// ── POST /os/disk-install/start ────────────────────────────────────────────────

router.post("/os/disk-install/start", (req: Request, res: Response) => {
  if (job.status === "running") {
    res.status(409).json({ ok: false, error: "An install is already in progress." });
    return;
  }
  if (!fs.existsSync(INSTALL_HELPER)) {
    res.status(501).json({
      ok: false,
      error: "The disk-install helper is only available on FoulFox OS. This environment is the Replit dev workspace.",
    });
    return;
  }

  const targetDisk = req.body?.targetDisk;
  if (typeof targetDisk !== "string" || !/^\/dev\/[A-Za-z0-9/_-]+$/.test(targetDisk)) {
    res.status(400).json({ ok: false, error: "Invalid targetDisk. Expected a /dev/... path." });
    return;
  }

  // Partition sizes (GiB). Validated: OS ≥ 60, data ≥ 20.
  const osSizeGb   = typeof req.body?.osSizeGb   === "number" ? Math.round(req.body.osSizeGb)   : 150;
  const dataSizeGb = typeof req.body?.dataSizeGb  === "number" ? Math.round(req.body.dataSizeGb) : 100;
  if (osSizeGb < 60 || osSizeGb > 8000) {
    res.status(400).json({ ok: false, error: `osSizeGb must be between 60 and 8000 (got ${osSizeGb}).` });
    return;
  }
  if (dataSizeGb < 20 || dataSizeGb > 8000) {
    res.status(400).json({ ok: false, error: `dataSizeGb must be between 20 and 8000 (got ${dataSizeGb}).` });
    return;
  }

  patch({
    status: "running",
    step: "starting",
    pct: 0,
    msg: `Starting installation to ${targetDisk} (OS ${osSizeGb} GiB + VM data ${dataSizeGb} GiB)…`,
    targetDisk,
    startedAt: Date.now(),
    finishedAt: null,
  });

  const proc = spawn("sudo", ["-n", INSTALL_HELPER, targetDisk, "--confirm"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      OS_SIZE_GiB:   String(osSizeGb),
      DATA_SIZE_GiB: String(dataSizeGb),
    },
  });

  let stderrBuf = "";
  proc.stdout?.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as { step: string; pct: number; msg: string };
        if (parsed.step === "done") {
          patch({ status: "done", step: "done", pct: 100, msg: parsed.msg, finishedAt: Date.now() });
        } else if (parsed.step === "error") {
          patch({ status: "error", step: "error", pct: 0, msg: parsed.msg, finishedAt: Date.now() });
        } else {
          patch({ step: parsed.step, pct: parsed.pct, msg: parsed.msg });
        }
      } catch {
        logger.debug({ line: trimmed }, "disk-install: non-JSON stdout line");
      }
    }
  });

  proc.stderr?.on("data", (chunk: Buffer) => {
    stderrBuf += chunk.toString();
  });

  proc.on("error", (err) => {
    logger.error({ err, disk: targetDisk }, "disk-install helper failed to start");
    patch({ status: "error", step: "error", pct: 0, msg: `Failed to start installer: ${err.message}`, finishedAt: Date.now() });
  });

  proc.on("close", (code) => {
    if (code !== 0 && job.status === "running") {
      const detail = stderrBuf.trim().split("\n").slice(-3).join(" ") || `exit code ${code}`;
      patch({ status: "error", step: "error", pct: 0, msg: `Installer exited unexpectedly: ${detail}`, finishedAt: Date.now() });
    }
    if (stderrBuf.trim()) {
      logger.warn({ disk: targetDisk, stderr: stderrBuf.trim().slice(-500) }, "disk-install helper stderr");
    }
  });

  res.json({ ok: true, msg: `Installation to ${targetDisk} started.` });
});

export default router;

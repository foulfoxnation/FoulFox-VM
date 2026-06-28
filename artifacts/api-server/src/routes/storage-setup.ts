import { Router, type IRouter, type Request, type Response } from "express";
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import { detectHostCapabilities } from "../lib/vm-capabilities";
import { recommendVmSizing, resolveReserveGb } from "../lib/storage-sizing";
import { DEFAULT_VM_ID, getVm, listVms, updateVm, updateVmConfig } from "../lib/vm-registry";
import { logger } from "../lib/logger";

// ── Storage Setup API ─────────────────────────────────────────────────────────
// Phase 1: non-destructive, hardware-tiered Windows VM sizing.
//   GET  /setup/storage/plan       recommend disk/RAM/CPU from detected hardware
//   POST /setup/storage/vm-sizing  apply a (possibly user-adjusted) sizing to the
//                                  default VM, validated against the same disk/RAM
//                                  guardrails as routes/vm.ts createVm.
// Phase 2: opt-in, destructive auto-partitioning of the persistence disk.
//   GET  /setup/storage/partitions       read-only block-device snapshot (lsblk)
//   POST /setup/storage/partition/dry-run plan the 'foulfox-persist' partition
//   POST /setup/storage/partition/apply   create+format it (confirm-gated)
// Mounted under /api/setup with localhostOnly + requireStateChangeToken (see
// app.ts), so GETs are open to the local shell and the POSTs need the session token.

const execFileAsync = promisify(execFile);

// Device-side helper that owns ALL partitioning logic + safety guards. Absent in
// the Replit dev workspace (no real disk), so the POSTs degrade to 501 there.
const STORAGE_HELPER = "/usr/local/sbin/foulfox-storage-setup";
const PERSIST_LABEL = "foulfox-persist";

const router: IRouter = Router();

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "string" ? Number(value) : (value as number);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function describeDefaultVm() {
  const vm = getVm(DEFAULT_VM_ID);
  if (!vm) return null;
  const diskExists = !!(vm.config.diskPath && fs.existsSync(vm.config.diskPath));
  return {
    ramGb: vm.config.ramGb,
    cpuCores: vm.config.cpuCores,
    diskGb: vm.diskGb,
    diskPath: vm.config.diskPath,
    diskExists,
  };
}

// GET /setup/storage/plan — hardware-tiered recommendation + current default VM.
router.get("/setup/storage/plan", async (_req: Request, res: Response) => {
  const caps = await detectHostCapabilities();
  const reserveGb = resolveReserveGb(caps.totalDiskGb);
  const plan = recommendVmSizing({
    totalDiskGb: caps.totalDiskGb,
    freeDiskGb: caps.freeDiskGb,
    totalRamGb: caps.totalRamGb,
    cpuCount: caps.cpuCount,
    reserveGb,
  });
  res.json({
    plan,
    current: describeDefaultVm(),
    canBootVm: caps.accelerator.hardware && caps.qemuSystem,
  });
});

// POST /setup/storage/vm-sizing — apply sizing to the default VM.
// Body: { ramGb?, cpuCores?, diskGb? }. Anything omitted uses the recommendation.
router.post("/setup/storage/vm-sizing", async (req: Request, res: Response) => {
  const vm = getVm(DEFAULT_VM_ID);
  if (!vm) {
    res.status(503).json({ error: "Default VM not initialized" });
    return;
  }

  const caps = await detectHostCapabilities();
  const reserveGb = resolveReserveGb(caps.totalDiskGb);
  const plan = recommendVmSizing({
    totalDiskGb: caps.totalDiskGb,
    freeDiskGb: caps.freeDiskGb,
    totalRamGb: caps.totalRamGb,
    cpuCount: caps.cpuCount,
    reserveGb,
  });

  // RAM: never above 50% of host (mirrors createVm). Unknown host → sane ceiling.
  const ramMax = caps.totalRamGb > 0 ? Math.max(2, Math.floor(caps.totalRamGb * 0.5)) : 64;
  const cpuMax = caps.cpuCount > 0 ? caps.cpuCount : 16;
  const ramGb = clampInt(req.body?.ramGb, 1, ramMax, plan.ramGb);
  const cpuCores = clampInt(req.body?.cpuCores, 1, cpuMax, plan.cpuCores);

  // Disk: bounded by the shared VM budget (total − reserve) minus what OTHER VMs
  // already reserve. The default VM is the one being sized, so exclude it. This
  // mirrors routes/vm.ts createVm exactly (no minimum floor on the budget), so a
  // sizing accepted here is one createVm/first-run will also accept.
  const diskGb = clampInt(req.body?.diskGb, 8, 4096, plan.diskGb);
  if (caps.totalDiskGb > 0) {
    const committedOther = listVms()
      .filter((v) => v.id !== DEFAULT_VM_ID)
      .reduce((s, v) => s + v.diskGb, 0);
    const vmBudgetGb = Math.max(0, caps.totalDiskGb - reserveGb);
    const diskCeil = Math.max(0, vmBudgetGb - committedOther);
    if (diskGb > diskCeil) {
      const reserveBreakdown = `${caps.totalDiskGb}GB disk − ${reserveGb}GB reserved for FoulFox OS + your apps${committedOther > 0 ? ` − ${committedOther}GB for other VMs` : ""}`;
      res.status(409).json({
        error:
          diskCeil >= 8
            ? `A ${diskGb}GB Windows VM exceeds the ${diskCeil}GB available for VMs (${reserveBreakdown}). Pick ${diskCeil}GB or less.`
            : `Only ${diskCeil}GB is available for VMs (${reserveBreakdown}) — too small for a Windows VM. Use a larger drive or lower FOULFOX_DISK_RESERVE_GB.`,
        diskCeil,
      });
      return;
    }
  }

  updateVmConfig(DEFAULT_VM_ID, { ramGb, cpuCores });
  updateVm(DEFAULT_VM_ID, (v) => {
    v.diskGb = diskGb;
  });

  const diskExists = !!(vm.config.diskPath && fs.existsSync(vm.config.diskPath));
  res.json({
    applied: { ramGb, cpuCores, diskGb },
    diskExists,
    note: diskExists
      ? "RAM and CPU updated. The Windows disk image already exists, so its on-disk size is unchanged — the new size applies only if the disk is recreated."
      : "Sizing saved. The Windows disk will be created at this size on first provision.",
  });
});

// ── Phase 2: persistence-disk auto-partitioning ───────────────────────────────

interface LsblkNode {
  name?: string;
  path?: string;
  type?: string;
  size?: number | string | null;
  model?: string | null;
  label?: string | null;
  mountpoint?: string | null;
  rm?: boolean | string | null;
  children?: LsblkNode[];
}

function walkLsblk(nodes: LsblkNode[], visit: (n: LsblkNode) => void): void {
  for (const n of nodes) {
    visit(n);
    if (Array.isArray(n.children)) walkLsblk(n.children, visit);
  }
}

// GET /setup/storage/partitions — read-only snapshot for the wizard. Uses lsblk
// (unprivileged) so it works even in dev; the detailed plan (free space, exact
// partition) comes from the sudo-gated dry-run below. Never touches the disk.
router.get("/setup/storage/partitions", async (_req: Request, res: Response) => {
  const helperAvailable = fs.existsSync(STORAGE_HELPER);

  // Identify the disk the live system booted from (its parent block device), so
  // the UI can name the drive it would partition. Absent on a non-live host.
  let bootDisk: string | null = null;
  try {
    const { stdout: src } = await execFileAsync(
      "findmnt",
      ["-n", "-o", "SOURCE", "/run/live/medium"],
      { timeout: 5_000 },
    );
    const part = src.trim().split("\n")[0];
    if (part) {
      const { stdout: pk } = await execFileAsync("lsblk", ["-no", "PKNAME", part], {
        timeout: 5_000,
      });
      const name = pk.trim().split("\n")[0];
      if (name) bootDisk = `/dev/${name}`;
    }
  } catch {
    // Not a FoulFox live boot (e.g. the dev workspace) — leave bootDisk null.
  }

  let persistExists = false;
  const disks: Array<{
    path: string;
    sizeBytes: number;
    model: string | null;
    removable: boolean;
    isBootDisk: boolean;
  }> = [];
  try {
    const { stdout } = await execFileAsync(
      "lsblk",
      ["-J", "-b", "-o", "NAME,PATH,TYPE,SIZE,MODEL,LABEL,MOUNTPOINT,RM"],
      { timeout: 5_000 },
    );
    const parsed = JSON.parse(stdout) as { blockdevices?: LsblkNode[] };
    const tree = parsed.blockdevices ?? [];
    walkLsblk(tree, (n) => {
      if ((n.label ?? "") === PERSIST_LABEL) persistExists = true;
    });
    for (const dev of tree) {
      if (dev.type !== "disk") continue;
      const path = dev.path ?? (dev.name ? `/dev/${dev.name}` : "");
      if (!path) continue;
      disks.push({
        path,
        sizeBytes: typeof dev.size === "string" ? Number(dev.size) || 0 : dev.size ?? 0,
        model: dev.model ? String(dev.model).trim() || null : null,
        removable: dev.rm === true || dev.rm === "1",
        isBootDisk: bootDisk !== null && path === bootDisk,
      });
    }
  } catch (err) {
    logger.error({ err }, "lsblk snapshot failed");
  }

  res.json({ helperAvailable, bootDisk, persistExists, persistLabel: PERSIST_LABEL, disks });
});

// Build the validated --expected-device arg (a confirmation hint; the helper
// still derives the real target itself and rejects a mismatch).
function deviceArg(device: unknown): string[] {
  if (typeof device === "string" && /^\/dev\/[A-Za-z0-9/_-]+$/.test(device)) {
    return ["--expected-device", device];
  }
  return [];
}

// Run the device-side helper and relay its JSON. 501 when the helper is absent
// (dev). The helper emits JSON + a non-zero exit on validation failure, so parse
// stdout from the thrown error and map it to 409 rather than a generic 500.
async function runStorageHelper(
  sub: "dry-run" | "apply",
  args: string[],
  res: Response,
): Promise<void> {
  if (!fs.existsSync(STORAGE_HELPER)) {
    res.status(501).json({
      ok: false,
      error:
        "Auto-partitioning is only available on FoulFox OS (the storage helper isn't present in this environment).",
    });
    return;
  }
  try {
    const { stdout } = await execFileAsync(
      "sudo",
      ["-n", STORAGE_HELPER, sub, "--json", ...args],
      { timeout: sub === "apply" ? 120_000 : 20_000 },
    );
    try {
      res.json(JSON.parse(stdout.trim()));
    } catch {
      res.status(500).json({ ok: false, error: "Storage helper returned malformed output." });
    }
    return;
  } catch (err) {
    const e = err as { stdout?: string };
    if (e.stdout) {
      try {
        res.status(409).json(JSON.parse(e.stdout.trim()));
        return;
      } catch {
        // fall through to the generic error
      }
    }
    logger.error({ err, sub }, "foulfox-storage-setup invocation failed");
    res.status(500).json({ ok: false, error: `Could not run storage ${sub}.` });
  }
}

// POST /setup/storage/partition/dry-run — plan only; never modifies the disk.
router.post("/setup/storage/partition/dry-run", (req: Request, res: Response) => {
  void runStorageHelper("dry-run", deviceArg(req.body?.device), res);
});

// POST /setup/storage/partition/apply — DESTRUCTIVE (creates+formats the new
// partition). Double-gated: requires confirm:true in addition to the wizard's
// typed confirmation, on top of the localhost-only + state-change-token guards.
router.post("/setup/storage/partition/apply", (req: Request, res: Response) => {
  if (req.body?.confirm !== true) {
    res.status(400).json({
      ok: false,
      error: "Confirmation required: pass confirm:true once the user agrees to erase the free space.",
    });
    return;
  }
  const args = deviceArg(req.body?.device);
  const fp = req.body?.fingerprint;
  if (typeof fp === "string" && /^[a-f0-9]{64}$/.test(fp)) {
    args.push("--expect-fingerprint", fp);
  }
  void runStorageHelper("apply", args, res);
});

export default router;

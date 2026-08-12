import { Router, type IRouter, type Request, type Response } from "express";
import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import {
  GetVmStatusResponse,
  GetVmConfigResponse,
  StartVmResponse,
  StopVmResponse,
  RestartVmResponse,
  SnapshotVmResponse,
  UpdateVmConfigBody,
  SnapshotVmBody,
} from "@workspace/api-zod";
import {
  DEFAULT_VM_ID,
  getVm,
  getRuntime,
  listVms,
  createVm,
  deleteVm,
  updateVmConfig,
  recommendVmSize,
  VM_DATA_DIR,
  type VmRecord,
} from "../lib/vm-registry";
import { startVm, stopVm, writeMonitor } from "../lib/vm-launch";
import { qmpScreendump, qmpInputSendEvent } from "../lib/vm-qmp";
import { actionToEventBatches, actionNeedsCoords, type InputAction } from "../lib/vm-input";
import {
  detectHostCapabilities,
  isValidVmId,
  isValidVmName,
  isValidSnapshotName,
  isOsKind,
  type OsKind,
} from "../lib/vm-capabilities";
import { startProvisioning, startCloneProvisioning, subscribeProvisioning, cancelProvisioning, buildWindowsDevSetupScript, ensureVmSshKey, windowsNeedsInstaller, diskLooksBlank, goldenImagePath } from "../lib/vm-provision";
import { authMode, checkAgentHealth, runSshCommand, runScpPull, runScpPush } from "../lib/vm-ssh";
import { OS_IMAGES, toPublic, getOsImage, isOsImageId } from "../lib/os-catalog";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// ── Helpers ───────────────────────────────────────────────────────────────────

function statusPayload(vm: VmRecord) {
  const rt = getRuntime(vm.id);
  const uptime = rt.startTime ? Math.floor((Date.now() - rt.startTime) / 1000) : null;
  return {
    id: vm.id,
    name: vm.name,
    osKind: vm.osKind,
    state: rt.state,
    pid: rt.process?.pid ?? null,
    uptime,
    isoPath: vm.config.isoPath,
    diskPath: vm.config.diskPath,
    ramGb: vm.config.ramGb,
    cpuCores: vm.config.cpuCores,
    gpuPassthrough: vm.config.gpuPassthrough,
    connectionMode: vm.config.connectionMode,
    sshPort: vm.config.sshPort,
    authMode: authMode(vm),
    ports: vm.ports,
    provisioning: vm.provisioning,
    displayToken: vm.displayToken,
    lastError: rt.lastError,
    projectPath: vm.config.projectPath ?? null,
  };
}

// Shared self-heal for the start routes: no media yet → run a provisioning
// pass (frontload scan + Microsoft download) and AUTO-START the VM as soon as
// media is attached. The user already pressed Start — making them watch a
// progress bar and press Start again was a dead end in practice.
function provisionThenStart(vmId: string): void {
  startProvisioning(vmId)
    .then(() => {
      const fresh = getVm(vmId);
      if (!fresh) return;
      if (!fresh.config.diskPath && !fresh.config.isoPath) return; // still no media
      // Still a blank disk with no installer (e.g. Microsoft download failed
      // again): starting would only boot into the UEFI shell — don't.
      if (windowsNeedsInstaller(fresh)) {
        logger.warn({ vm: vmId }, "Provisioning finished without an installer ISO; not auto-starting a blank Windows disk");
        return;
      }
      const r = startVm(fresh);
      logger.info({ vm: vmId, ok: r.ok, state: r.state, message: r.message }, "Auto-start after provisioning");
    })
    .catch((err) => logger.error({ err, vm: vmId }, "Auto-provision on start failed"));
}

function requireVm(req: Request, res: Response): VmRecord | null {
  const id = req.params.id;
  if (!isValidVmId(id)) {
    res.status(400).json({ error: "Invalid VM id" });
    return null;
  }
  const vm = getVm(id);
  if (!vm) {
    res.status(404).json({ error: `VM '${id}' not found` });
    return null;
  }
  return vm;
}

// ── Multi-VM endpoints ─────────────────────────────────────────────────────────

// GET /vm/list — all VMs with live status.
router.get("/vm/list", (_req: Request, res: Response) => {
  res.json({ vms: listVms().map(statusPayload) });
});

// GET /vm/os-images — the OS catalog the picker renders, with per-host gating.
// Raw download URLs / Microsoft product ids are intentionally NOT exposed.
router.get("/vm/os-images", async (_req: Request, res: Response) => {
  const caps = await detectHostCapabilities();
  const images = OS_IMAGES.map((i) => {
    const support = caps.osSupport[i.family];
    return { ...toPublic(i), supported: support.supported, reason: support.reason };
  });
  res.json({ images });
});

// POST /vm/create — register a new VM and kick off auto-provisioning.
// Body: { name, osKind, ramGb?, cpuCores?, diskGb? }
router.post("/vm/create", async (req: Request, res: Response) => {
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  if (!isValidVmName(name)) {
    res.status(400).json({ error: "Invalid VM name (allowed: letters, digits, space . _ -, max 64 chars)" });
    return;
  }

  // Prefer an explicit catalog image id; fall back to a bare osKind for
  // backwards compatibility. The image id is an allowlist and osKind is derived
  // from it, so the client can never select an out-of-catalog target or URL.
  const rawImageId = req.body?.imageId;
  let image: ReturnType<typeof getOsImage> = undefined;
  let osKind: unknown = req.body?.osKind;
  if (rawImageId !== undefined && rawImageId !== null) {
    if (!isOsImageId(rawImageId)) {
      res.status(400).json({ error: "Unknown OS image" });
      return;
    }
    image = getOsImage(rawImageId);
    osKind = image!.family;
  }
  if (!isOsKind(osKind)) {
    res.status(400).json({ error: "Invalid osKind (expected linux, windows or macos)" });
    return;
  }

  // Honest capability + guardrail checks before creating anything.
  const caps = await detectHostCapabilities();
  if (!caps.osSupport[osKind as OsKind].supported) {
    res.status(409).json({ error: caps.osSupport[osKind as OsKind].reason });
    return;
  }
  const existing = listVms();
  if (existing.length >= caps.cpuCount && existing.length >= 8) {
    res.status(409).json({ error: "Maximum number of VMs reached." });
    return;
  }
  // Right-size defaults to the host: a Ryzen-class box with plenty of RAM/disk
  // gets a genuinely usable Windows VM by default; a small test box stays
  // conservative. Explicit request values and catalog image defaults still win.
  const sized = recommendVmSize();
  const bigDisk = caps.freeDiskGb >= 400; // room for a dev-tools Windows guest
  const ramDefault = image?.defaultRamGb ?? (osKind === "windows" ? Math.max(4, sized.ramGb) : 2);
  const diskDefault = image?.defaultDiskGb ?? (osKind === "windows" ? (bigDisk ? 256 : 64) : 32);
  const ramGb = clampInt(req.body?.ramGb, 1, Math.max(2, Math.floor(caps.totalRamGb * 0.5)), ramDefault);
  const cpuCores = clampInt(req.body?.cpuCores, 1, Math.max(1, caps.cpuCount), Math.min(recommendVmSize().cpuCores, Math.max(1, caps.cpuCount)));
  const diskGb = clampInt(req.body?.diskGb, 8, 256, diskDefault);

  // Aggregate-resource guardrails across all VMs.
  const totalRam = existing.reduce((s, v) => s + v.config.ramGb, 0) + ramGb;
  if (totalRam > Math.max(2, Math.floor(caps.totalRamGb * 0.75))) {
    res.status(409).json({ error: `Not enough RAM: this VM would push total allocation to ${totalRam}GB, above the ${Math.floor(caps.totalRamGb * 0.75)}GB cap.` });
    return;
  }

  // Aggregate-disk guardrail: FoulFox OS, every VM disk, and the user's
  // installable apps share ONE physical disk. qcow2 images are sparse, so we
  // treat diskGb as the *reservation* we account against and hold back a slice
  // (FOULFOX_DISK_RESERVE_GB, default 30) for the OS + apps. This prevents
  // silently overcommitting the drive. Fails open when capacity is unknown.
  if (caps.totalDiskGb > 0) {
    const reserveGb = clampInt(process.env["FOULFOX_DISK_RESERVE_GB"], 0, caps.totalDiskGb, 30);
    const committedDisk = existing.reduce((s, v) => s + v.diskGb, 0);
    const vmBudgetGb = Math.max(0, caps.totalDiskGb - reserveGb);
    if (committedDisk + diskGb > vmBudgetGb) {
      res.status(409).json({ error: `Not enough disk: this ${diskGb}GB VM plus ${committedDisk}GB already reserved by other VMs exceeds the ${vmBudgetGb}GB VM budget (${caps.totalDiskGb}GB disk − ${reserveGb}GB held for FoulFox OS + your apps). Shrink the disk, remove a VM, or lower FOULFOX_DISK_RESERVE_GB.` });
      return;
    }
    // totalDiskGb > 0 proves statfs succeeded, so freeDiskGb is known (even 0).
    if (caps.freeDiskGb < reserveGb) {
      res.status(409).json({ error: `Not enough free disk: only ${caps.freeDiskGb}GB free, below the ${reserveGb}GB reserved for FoulFox OS + your apps. Free up space before creating another VM.` });
      return;
    }
  }

  try {
    const vm = await createVm({ name, osKind: osKind as OsKind, imageId: image?.id, ramGb, cpuCores, diskGb });
    // Fire-and-forget provisioning; the UI subscribes to progress via SSE.
    startProvisioning(vm.id).catch((err) => logger.error({ err, vm: vm.id }, "Provisioning failed to start"));
    res.json({ vm: statusPayload(vm) });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// GET /vm/:id/status
router.get("/vm/:id/status", (req: Request, res: Response) => {
  const vm = requireVm(req, res); if (!vm) return;
  res.json(statusPayload(vm));
});

// GET /vm/:id/agent-health — verify an agent can run a command in the guest with
// no human input. Runs `echo <marker>` over key-based SSH and reports the result
// so the UI can surface a clear connection-health status.
router.get("/vm/:id/agent-health", async (req: Request, res: Response) => {
  const vm = requireVm(req, res); if (!vm) return;
  const health = await checkAgentHealth(vm);
  res.json(health);
});

// ── Computer-use: see (screenshot) + control (input) ──────────────────────────
// These let an agent perceive and drive the guest desktop directly. They speak
// QMP over the per-VM monitor TCP port; the live noVNC display is untouched (it
// uses the separate VNC socket), so a human can watch the agent work.

const PNG_MAGIC = 0x89504e47;

// Parse width/height from a PNG IHDR (bytes 16-23, big-endian). Returns null if
// the buffer isn't a PNG. Used to tell the agent the resolution its screenshot
// coordinates live in, and to scale input coordinates back to QEMU's abs range.
function pngSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24 || buf.readUInt32BE(0) !== PNG_MAGIC) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// Convert an image file (QEMU may emit PPM on older builds) to a PNG buffer via
// ImageMagick. Tries `magick` (v7) then falls back to `convert` (v6).
function convertToPng(inputPath: string): Promise<Buffer> {
  const run = (bin: string): Promise<Buffer> =>
    new Promise((resolve, reject) => {
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      const child = spawn(bin, [inputPath, "png:-"]);
      child.stdout.on("data", (d: Buffer) => out.push(d));
      child.stderr.on("data", (d: Buffer) => err.push(d));
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve(Buffer.concat(out));
        else reject(new Error(`${bin} exited ${code}: ${Buffer.concat(err).toString().slice(0, 500)}`));
      });
    });
  return run("magick").catch(() => run("convert"));
}

// Screendump to a temp host file, read it, ensure PNG, and return base64 + size.
async function captureScreenshot(monitorPort: number): Promise<{ image: string; mimeType: string; width: number; height: number }> {
  const tmp = path.join(os.tmpdir(), `vm-shot-${crypto.randomBytes(8).toString("hex")}.img`);
  try {
    const dump = await qmpScreendump(monitorPort, tmp);
    if (!dump.ok) throw new Error(dump.error || "screendump failed");
    const raw = await fs.promises.readFile(tmp);
    const pngBuf = pngSize(raw) ? raw : await convertToPng(tmp);
    const size = pngSize(pngBuf) ?? { width: 0, height: 0 };
    return { image: pngBuf.toString("base64"), mimeType: "image/png", width: size.width, height: size.height };
  } finally {
    fs.promises.unlink(tmp).catch(() => { /* best-effort cleanup */ });
  }
}

// POST /vm/:id/screenshot — capture the guest desktop as a PNG (base64).
router.post("/vm/:id/screenshot", async (req: Request, res: Response) => {
  const vm = requireVm(req, res); if (!vm) return;
  if (getRuntime(vm.id).state !== "running") {
    res.status(409).json({ error: `VM '${vm.name}' is not running` });
    return;
  }
  try {
    const shot = await captureScreenshot(vm.ports.monitor);
    res.json(shot);
  } catch (e) {
    logger.warn({ err: e, vm: vm.id }, "Screenshot failed");
    res.status(502).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// POST /vm/:id/input — inject mouse/keyboard. Body is a single action object or
// { actions: [...] }. Coordinate-based actions scale against the display size,
// taken from `screenW`/`screenH` if provided (the size from the last screenshot)
// or discovered with a one-off screendump otherwise.
router.post("/vm/:id/input", async (req: Request, res: Response) => {
  const vm = requireVm(req, res); if (!vm) return;
  if (getRuntime(vm.id).state !== "running") {
    res.status(409).json({ error: `VM '${vm.name}' is not running` });
    return;
  }
  const body = (req.body ?? {}) as { actions?: InputAction[]; type?: string; screenW?: number; screenH?: number };
  const rawActions: InputAction[] = Array.isArray(body.actions)
    ? body.actions
    : body.type
    ? [body as InputAction]
    : [];
  if (rawActions.length === 0) {
    res.status(400).json({ error: "No actions provided" });
    return;
  }

  // ── Paste pre-processing ────────────────────────────────────────────────────
  // "paste" is a high-level action: write the text to the guest clipboard via
  // SSH (PowerShell Set-Clipboard) then substitute a Ctrl+V QMP action. This
  // lets the agent paste arbitrarily large / multi-line / Unicode text into
  // any focused UI element without having to type every character individually.
  const resolvedActions: InputAction[] = [];
  for (const a of rawActions) {
    if ((a.type || "").toLowerCase() === "paste") {
      const text = String(a.text ?? "");
      if (!text) continue; // skip empty paste silently
      // Base64-encode the text so it passes safely through PowerShell quoting.
      // The base64 alphabet (A-Z a-z 0-9 + / =) is safe inside PS single-quotes.
      const b64 = Buffer.from(text, "utf-8").toString("base64");
      const psCmd = `powershell -NoProfile -NonInteractive -Command "[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')) | Set-Clipboard"`;
      const r = await runSshCommand(vm, psCmd, 15_000);
      if (!r.ok) {
        res.status(502).json({
          error: `paste: could not set clipboard via SSH — ${r.stderr.trim() || "check that the VM is running and has an SSH key (re-provision if needed)"}`,
        });
        return;
      }
      // After setting the clipboard, inject a Ctrl+V to paste it into the focused element.
      resolvedActions.push({ type: "key", keys: ["ctrl", "v"] });
      continue;
    }
    resolvedActions.push(a);
  }

  const actions = resolvedActions;
  if (actions.length === 0) {
    res.json({ success: true, actions: 0, screenW: 0, screenH: 0 });
    return;
  }

  let screenW = Number(body.screenW) > 0 ? Number(body.screenW) : 0;
  let screenH = Number(body.screenH) > 0 ? Number(body.screenH) : 0;
  if ((!screenW || !screenH) && actions.some(actionNeedsCoords)) {
    try {
      const shot = await captureScreenshot(vm.ports.monitor);
      screenW = shot.width;
      screenH = shot.height;
    } catch (e) {
      res.status(502).json({ error: `Could not determine display size: ${e instanceof Error ? e.message : String(e)}` });
      return;
    }
  }

  // Translate first (so a bad action 400s before we inject anything partial).
  let batches: unknown[][];
  try {
    batches = actions.flatMap((a) => actionToEventBatches(a, screenW, screenH));
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    return;
  }

  for (const events of batches) {
    const r = await qmpInputSendEvent(vm.ports.monitor, events);
    if (!r.ok) {
      res.status(502).json({ error: r.error || "input-send-event failed" });
      return;
    }
  }
  res.json({ success: true, actions: actions.length, screenW, screenH });
});

// POST /vm/:id/start
router.post("/vm/:id/start", (req: Request, res: Response) => {
  const vm = requireVm(req, res); if (!vm) return;
  // Self-heal the "no media" case: if the VM has no disk/ISO yet (e.g. the user
  // frontloaded a Windows ISO after the VM record was created), kick a
  // provisioning pass — it re-scans the frontload staging dir, adopts the ISO,
  // creates the disk, and updates the record — instead of dead-ending with an
  // unactionable toast.
  // Also treat "blank disk + no installer ISO" as no media: booting it would
  // only reach the UEFI shell, so fetch the installer instead.
  if ((!vm.config.diskPath && !vm.config.isoPath) || windowsNeedsInstaller(vm)) {
    provisionThenStart(vm.id);
    res.json({
      success: false,
      message:
        "No bootable Windows found yet — fetching a Windows ISO now (frontloaded files, then Microsoft download). The VM will start automatically as soon as it's ready.",
      state: "provisioning",
    });
    return;
  }
  const r = startVm(vm);
  res.json({ success: r.ok, message: r.message, state: r.state });
});

// POST /vm/:id/clone — duplicate an installed VM into a new, independent VM.
// The heavy lifting (qemu-img convert of the whole disk) runs async and reports
// through the new VM's provisioning SSE stream, so the UI shows a progress
// banner in the freshly created tab. The source must be fully stopped: copying
// a disk under a running QEMU produces a corrupt image.
router.post("/vm/:id/clone", async (req: Request, res: Response) => {
  const vm = requireVm(req, res); if (!vm) return;
  const rt = getRuntime(vm.id);
  if (rt.state !== "stopped" && rt.state !== "error") {
    res.status(409).json({ error: "Stop the VM before cloning — copying a running disk would corrupt the clone." });
    return;
  }
  if (!vm.config.diskPath || !fs.existsSync(vm.config.diskPath)) {
    res.status(409).json({ error: "This VM has no installed disk to clone yet. Install the OS first, then clone." });
    return;
  }
  const rawName = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  const name = rawName || `${vm.name} clone`.slice(0, 64);
  if (!isValidVmName(name)) {
    res.status(400).json({ error: "Invalid VM name (allowed: letters, digits, space . _ -, max 64 chars)" });
    return;
  }

  // Same aggregate guardrails as /vm/create — a clone costs the same RAM/disk.
  const caps = await detectHostCapabilities();
  const existing = listVms();
  if (existing.length >= caps.cpuCount && existing.length >= 8) {
    res.status(409).json({ error: "Maximum number of VMs reached." });
    return;
  }
  const totalRam = existing.reduce((s, v) => s + v.config.ramGb, 0) + vm.config.ramGb;
  if (totalRam > Math.max(2, Math.floor(caps.totalRamGb * 0.75))) {
    res.status(409).json({ error: `Not enough RAM: this clone would push total allocation to ${totalRam}GB, above the ${Math.floor(caps.totalRamGb * 0.75)}GB cap. Stop or delete a VM first (stopped VMs still count as reserved).` });
    return;
  }
  if (caps.totalDiskGb > 0) {
    const reserveGb = clampInt(process.env["FOULFOX_DISK_RESERVE_GB"], 0, caps.totalDiskGb, 30);
    const committedDisk = existing.reduce((s, v) => s + v.diskGb, 0);
    const vmBudgetGb = Math.max(0, caps.totalDiskGb - reserveGb);
    if (committedDisk + vm.diskGb > vmBudgetGb) {
      res.status(409).json({ error: `Not enough disk: this ${vm.diskGb}GB clone plus ${committedDisk}GB already reserved by other VMs exceeds the ${vmBudgetGb}GB VM budget.` });
      return;
    }
  }

  try {
    const clone = await createVm({
      name,
      osKind: vm.osKind,
      imageId: vm.imageId,
      ramGb: vm.config.ramGb,
      cpuCores: vm.config.cpuCores,
      diskGb: vm.diskGb,
    });
    startCloneProvisioning(vm.id, clone.id).catch((err) =>
      logger.error({ err, source: vm.id, clone: clone.id }, "Clone provisioning failed to start"),
    );
    res.json({ vm: statusPayload(clone) });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// POST /vm/:id/stop
router.post("/vm/:id/stop", (req: Request, res: Response) => {
  const vm = requireVm(req, res); if (!vm) return;
  // Cancel any active download/provisioning first so the Stop button always
  // works even when the VM is stopped mid-download (QEMU never launched yet).
  cancelProvisioning(vm.id);
  const r = stopVm(vm);
  res.json({ success: r.ok, message: r.message, state: r.state });
});

// POST /vm/:id/restart
router.post("/vm/:id/restart", (req: Request, res: Response) => {
  const vm = requireVm(req, res); if (!vm) return;
  cancelProvisioning(vm.id);
  stopVm(vm);
  setTimeout(() => {
    const fresh = getVm(vm.id);
    if (fresh) startVm(fresh);
  }, 1500);
  res.json({ success: true, message: "VM restarting", state: "stopping" });
});

// DELETE /vm/:id — stop and remove a non-default VM.
router.delete("/vm/:id", (req: Request, res: Response) => {
  const vm = requireVm(req, res); if (!vm) return;
  if (vm.id === DEFAULT_VM_ID) {
    res.status(400).json({ error: "The default VM cannot be deleted." });
    return;
  }
  stopVm(vm);
  const ok = deleteVm(vm.id);
  res.json({ success: ok });
});

// GET /vm/:id/config
router.get("/vm/:id/config", (req: Request, res: Response) => {
  const vm = requireVm(req, res); if (!vm) return;
  res.json(GetVmConfigResponse.parse(vm.config));
});

// PUT /vm/:id/config
router.put("/vm/:id/config", (req: Request, res: Response) => {
  const vm = requireVm(req, res); if (!vm) return;
  const parsed = UpdateVmConfigBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const updated = updateVmConfig(vm.id, parsed.data);
  res.json(GetVmConfigResponse.parse(updated!.config));
});

// Snapshot ops (id-scoped)
router.post("/vm/:id/snapshot", (req: Request, res: Response) => {
  const vm = requireVm(req, res); if (!vm) return;
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : req.body?.name;
  if (!isValidSnapshotName(name)) { res.status(400).json({ error: "Invalid snapshot name" }); return; }
  const ok = writeMonitor(vm.id, `savevm ${name}`);
  res.json({ success: ok, message: ok ? `Snapshot '${name}' requested` : "VM must be running to take a snapshot", state: getRuntime(vm.id).state });
});

router.get("/vm/:id/snapshot/list", async (req: Request, res: Response) => {
  const vm = requireVm(req, res); if (!vm) return;
  if (!vm.config.diskPath) { res.json({ success: true, snapshots: [], message: "No disk image configured" }); return; }
  if (!canRunOfflineImg(vm.id)) { res.json({ success: false, snapshots: [], message: `Stop the VM fully to list snapshots (state: ${getRuntime(vm.id).state})` }); return; }
  const r = await runQemuImg(["snapshot", "-l", vm.config.diskPath]);
  if (!r.ok) { res.json({ success: false, snapshots: [], message: r.error || "Failed to list snapshots" }); return; }
  res.json({ success: true, snapshots: parseSnapshotList(r.stdout) });
});

router.post("/vm/:id/snapshot/restore", async (req: Request, res: Response) => {
  const vm = requireVm(req, res); if (!vm) return;
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : req.body?.name;
  if (!isValidSnapshotName(name)) { res.status(400).json({ success: false, message: "Invalid snapshot name" }); return; }
  if (writeMonitor(vm.id, `loadvm ${name}`)) { res.json({ success: true, message: `Restore of '${name}' requested`, state: getRuntime(vm.id).state }); return; }
  if (!canRunOfflineImg(vm.id) || !vm.config.diskPath) { res.json({ success: false, message: `Stop the VM fully before restoring offline`, state: getRuntime(vm.id).state }); return; }
  const r = await runQemuImg(["snapshot", "-a", name, vm.config.diskPath]);
  res.json(r.ok ? { success: true, message: `Snapshot '${name}' restored`, state: getRuntime(vm.id).state } : { success: false, message: r.error || "Failed to restore", state: getRuntime(vm.id).state });
});

router.post("/vm/:id/snapshot/delete", async (req: Request, res: Response) => {
  const vm = requireVm(req, res); if (!vm) return;
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : req.body?.name;
  if (!isValidSnapshotName(name)) { res.status(400).json({ success: false, message: "Invalid snapshot name" }); return; }
  if (writeMonitor(vm.id, `delvm ${name}`)) { res.json({ success: true, message: `Delete of '${name}' requested`, state: getRuntime(vm.id).state }); return; }
  if (!canRunOfflineImg(vm.id) || !vm.config.diskPath) { res.json({ success: false, message: `Stop the VM fully before deleting offline`, state: getRuntime(vm.id).state }); return; }
  const r = await runQemuImg(["snapshot", "-d", name, vm.config.diskPath]);
  res.json(r.ok ? { success: true, message: `Snapshot '${name}' deleted`, state: getRuntime(vm.id).state } : { success: false, message: r.error || "Failed to delete", state: getRuntime(vm.id).state });
});

// ── Agent coding-session snapshots ────────────────────────────────────────────
// One call before each agent coding session: takes a live `agent-session-<ts>`
// snapshot and prunes to the newest N so long-running appliances don't bloat
// the qcow2. A sidecar JSON tracks names because a RUNNING VM cannot list
// snapshots via qemu-img (delvm works over the monitor, list does not).
const SESSION_SNAP_KEEP = 5;
function sessionSnapLogPath(vmId: string): string {
  return path.join(VM_DATA_DIR, `${vmId}-session-snapshots.json`);
}
function readSessionSnaps(vmId: string): string[] {
  try { const v = JSON.parse(fs.readFileSync(sessionSnapLogPath(vmId), "utf8")); return Array.isArray(v) ? v.filter((s) => typeof s === "string") : []; } catch { return []; }
}
function writeSessionSnaps(vmId: string, names: string[]): void {
  try { fs.mkdirSync(VM_DATA_DIR, { recursive: true }); fs.writeFileSync(sessionSnapLogPath(vmId), JSON.stringify(names)); } catch { /* best-effort */ }
}

router.post("/vm/:id/session-snapshot", (req: Request, res: Response) => {
  const vm = requireVm(req, res); if (!vm) return;
  const name = `agent-session-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
  if (!writeMonitor(vm.id, `savevm ${name}`)) {
    res.json({ success: false, message: "VM must be running to take a session snapshot", state: getRuntime(vm.id).state });
    return;
  }
  const names = readSessionSnaps(vm.id);
  names.push(name);
  while (names.length > SESSION_SNAP_KEEP) {
    const oldest = names.shift()!;
    writeMonitor(vm.id, `delvm ${oldest}`); // best-effort prune
  }
  writeSessionSnaps(vm.id, names);
  logger.info({ vm: vm.id, name }, "Agent session snapshot requested");
  res.json({ success: true, message: `Session snapshot '${name}' requested`, name, kept: names });
});

// ── Golden image ("vibe-coding ready" base) ───────────────────────────────────
// Saves a stopped, installed guest disk as the golden base image; future VMs of
// the same OS clone from it instead of reinstalling from scratch.
const goldenSavesInFlight = new Set<string>();
router.post("/vm/:id/golden/save", async (req: Request, res: Response) => {
  const vm = requireVm(req, res); if (!vm) return;
  const disk = vm.config.diskPath;
  if (!disk || !fs.existsSync(disk)) { res.status(409).json({ success: false, message: "This VM has no disk image yet." }); return; }
  if (!canRunOfflineImg(vm.id)) { res.status(409).json({ success: false, message: `Stop the VM fully before saving a golden image (state: ${getRuntime(vm.id).state}).` }); return; }
  if (diskLooksBlank(disk)) { res.status(409).json({ success: false, message: "This disk looks blank — install the OS first, then save it as the golden image." }); return; }
  const dest = goldenImagePath(vm.osKind);
  if (goldenSavesInFlight.has(dest)) { res.status(409).json({ success: false, message: "A golden image save is already in progress." }); return; }
  goldenSavesInFlight.add(dest);
  const tmp = `${dest}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    // convert flattens backing chains AND drops internal snapshots — the golden
    // image is a clean standalone base.
    const r = await runQemuImg(["convert", "-O", "qcow2", disk, tmp]);
    if (!r.ok) { fs.rmSync(tmp, { force: true }); res.status(500).json({ success: false, message: r.error || "qemu-img convert failed" }); return; }
    fs.renameSync(tmp, dest);
    // Save the guest's credentials + agent key alongside the image: a clone of
    // this install only trusts THESE, so provisioning restores them.
    try {
      const credPath = dest.replace(/\.qcow2$/, ".cred.json");
      fs.writeFileSync(credPath, JSON.stringify({ sshUser: vm.config.sshUser ?? null, sshPassword: vm.config.sshPassword ?? null }), { mode: 0o600 });
      if (vm.config.sshKeyPath && fs.existsSync(vm.config.sshKeyPath)) {
        const keyDest = dest.replace(/\.qcow2$/, ".sshkey");
        fs.copyFileSync(vm.config.sshKeyPath, keyDest);
        fs.chmodSync(keyDest, 0o600);
        if (fs.existsSync(vm.config.sshKeyPath + ".pub")) fs.copyFileSync(vm.config.sshKeyPath + ".pub", keyDest + ".pub");
      }
    } catch (err) {
      logger.warn({ err }, "Golden image saved but credential sidecar failed — clones may need manual SSH setup");
    }
    logger.info({ vm: vm.id, dest }, "Golden image saved");
    res.json({ success: true, message: `Golden ${vm.osKind} image saved — new ${vm.osKind} VMs will start from it.`, path: dest });
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    res.status(500).json({ success: false, message: err instanceof Error ? err.message : String(err) });
  } finally {
    goldenSavesInFlight.delete(dest);
  }
});

router.get("/vm/golden/status", (_req: Request, res: Response) => {
  const out: Record<string, { exists: boolean; sizeGb?: number; savedAt?: string }> = {};
  for (const kind of ["windows", "linux"] as const) {
    const p = goldenImagePath(kind);
    try {
      const st = fs.statSync(p);
      out[kind] = { exists: true, sizeGb: Math.round((st.size / 1024 ** 3) * 10) / 10, savedAt: st.mtime.toISOString() };
    } catch { out[kind] = { exists: false }; }
  }
  res.json(out);
});

// GET /vm/:id/provision/stream — SSE progress for auto-provisioning.
router.get("/vm/:id/provision/stream", (req: Request, res: Response) => {
  const vm = requireVm(req, res); if (!vm) return;
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(`data: ${JSON.stringify(getVm(vm.id)?.provisioning)}\n\n`);
  const unsub = subscribeProvisioning(vm.id, (state) => {
    res.write(`data: ${JSON.stringify(state)}\n\n`);
  });
  req.on("close", () => { unsub(); res.end(); });
});

// POST /vm/:id/provision — (re)start provisioning for a VM.
router.post("/vm/:id/provision", (req: Request, res: Response) => {
  const vm = requireVm(req, res); if (!vm) return;
  startProvisioning(vm.id).catch((err) => logger.error({ err, vm: vm.id }, "Provisioning failed"));
  res.json({ success: true });
});

// POST /vm/:id/provision/cancel — cancel an in-flight provisioning pass (e.g.
// a stuck download). Aborts the HTTP request, deletes the partial file, and
// resets the provisioning state to "none" so the user can retry immediately.
router.post("/vm/:id/provision/cancel", (req: Request, res: Response) => {
  const vm = requireVm(req, res); if (!vm) return;
  cancelProvisioning(vm.id);
  res.json({ success: true });
});

// POST /vm/:id/generate-keys — generate (or regenerate) the per-VM ed25519 SSH
// keypair used by the agent to authenticate into the Windows guest.
// backfillVmSshKeys() runs once at api-server boot, but VMs created after boot
// (or installs that pre-date the key backfill feature) will have sshKeyPath=null.
// This endpoint lets the diagnostic tool trigger key generation on demand.
router.post("/vm/:id/generate-keys", async (req: Request, res: Response) => {
  const vm = requireVm(req, res); if (!vm) return;
  try {
    const result = await ensureVmSshKey(vm.id);
    if (!result) {
      return res.status(500).json({ error: "ssh-keygen unavailable — install openssh-client" });
    }
    // Persist the key path in the VM config so subsequent list calls show authMode=key
    updateVmConfig(vm.id, { sshKeyPath: result.keyPath });
    logger.info({ vm: vm.id, keyPath: result.keyPath }, "Agent SSH keypair generated on demand");
    return res.json({ sshKeyPath: result.keyPath, pubKey: result.pubKey });
  } catch (err) {
    logger.error({ err, vm: vm.id }, "generate-keys failed");
    return res.status(500).json({ error: String(err) });
  }
});

// GET /vm/:id/dev-setup — download a PowerShell script that installs the full
// developer toolchain (Git, VS Code + extensions, GitHub CLI, .NET 8 SDK,
// Unity Hub, Epic Games Launcher) on an EXISTING Windows VM.
// Run inside the VM as Administrator:
//   Set-ExecutionPolicy Bypass -Scope Process -Force
//   irm http://<foulfox-host>/api/vm/default/dev-setup | iex
router.get("/vm/:id/dev-setup", (req: Request, res: Response) => {
  const vm = requireVm(req, res); if (!vm) return;
  const script = buildWindowsDevSetupScript();
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="foulfox-dev-setup-${vm.id}.ps1"`);
  res.send(script);
});

// ── Capabilities (honest, multi-OS) ────────────────────────────────────────────
router.get("/vm/capabilities", async (_req: Request, res: Response) => {
  const caps = await detectHostCapabilities();
  // Backward-compatible fields (used by the legacy setup wizard) preserved
  // alongside the richer multi-OS capability report.
  const canBootVm = caps.accelerator.hardware && caps.qemuSystem;
  let message: string;
  if (canBootVm) {
    message = `This machine can boot VMs (${caps.accelerator.accel.toUpperCase()} acceleration + QEMU available).`;
  } else if (!caps.qemuSystem) {
    message = "QEMU is not installed. Install qemu-system-x86_64 (and qemu-img) to boot VMs.";
  } else {
    message = `Cannot hardware-accelerate VMs here: ${caps.accelerator.reason}. VMs would run under slow software emulation.`;
  }
  res.json({
    canBootVm,
    kvm: caps.accelerator.accel === "kvm" && caps.accelerator.hardware,
    kvmReason: caps.accelerator.reason,
    qemuSystem: caps.qemuSystem,
    qemuImg: caps.qemuImg,
    platform: caps.platform,
    arch: caps.arch,
    message,
    accelerator: caps.accelerator,
    appleHost: caps.appleHost,
    totalRamGb: caps.totalRamGb,
    cpuCount: caps.cpuCount,
    totalDiskGb: caps.totalDiskGb,
    freeDiskGb: caps.freeDiskGb,
    osSupport: caps.osSupport,
  });
});

// ── Legacy default-VM endpoints (preserved exactly) ────────────────────────────
// These continue to operate on the "default" VM so existing clients keep working.

router.get("/vm/status", (_req: Request, res: Response) => {
  const vm = getVm(DEFAULT_VM_ID);
  if (!vm) { res.status(503).json({ error: "Default VM not initialized" }); return; }
  const rt = getRuntime(DEFAULT_VM_ID);
  const uptime = rt.startTime ? Math.floor((Date.now() - rt.startTime) / 1000) : null;
  res.json(GetVmStatusResponse.parse({
    state: rt.state,
    pid: rt.process?.pid ?? null,
    uptime,
    isoPath: vm.config.isoPath,
    diskPath: vm.config.diskPath,
    ramGb: vm.config.ramGb,
    cpuCores: vm.config.cpuCores,
    gpuPassthrough: vm.config.gpuPassthrough,
    connectionMode: vm.config.connectionMode,
    sshPort: vm.config.sshPort,
  }));
});

router.post("/vm/start", (_req: Request, res: Response) => {
  const vm = getVm(DEFAULT_VM_ID);
  if (!vm) { res.json(StartVmResponse.parse({ success: false, message: "Default VM not initialized", state: "error" })); return; }
  // Same self-heal as /vm/:id/start: no media yet → kick a provisioning pass
  // (re-scans frontloaded ISOs) instead of a dead-end error.
  if ((!vm.config.diskPath && !vm.config.isoPath) || windowsNeedsInstaller(vm)) {
    provisionThenStart(vm.id);
    res.json(StartVmResponse.parse({
      success: false,
      message:
        "No bootable Windows found yet — fetching a Windows ISO now (frontloaded files, then Microsoft download). The VM will start automatically as soon as it's ready.",
      state: "provisioning",
    }));
    return;
  }
  const r = startVm(vm);
  res.json(StartVmResponse.parse({ success: r.ok, message: r.message, state: r.state }));
});

router.post("/vm/stop", (_req: Request, res: Response) => {
  const vm = getVm(DEFAULT_VM_ID);
  if (!vm) { res.json(StopVmResponse.parse({ success: false, message: "Default VM not initialized", state: "error" })); return; }
  cancelProvisioning(vm.id);
  const r = stopVm(vm);
  res.json(StopVmResponse.parse({ success: r.ok, message: r.message, state: r.state }));
});

router.post("/vm/restart", (_req: Request, res: Response) => {
  const vm = getVm(DEFAULT_VM_ID);
  if (!vm) { res.json(RestartVmResponse.parse({ success: false, message: "Default VM not initialized", state: "error" })); return; }
  cancelProvisioning(vm.id);
  stopVm(vm);
  res.json(RestartVmResponse.parse({ success: true, message: "VM stopped. Restarting...", state: "stopped" }));
  setTimeout(() => {
    const fresh = getVm(DEFAULT_VM_ID);
    if (fresh) startVm(fresh);
  }, 1500);
});

router.post("/vm/snapshot", (req: Request, res: Response) => {
  const parsed = SnapshotVmBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const { name } = parsed.data;
  if (!isValidSnapshotName(name)) { res.status(400).json({ error: "Invalid snapshot name (allowed: letters, digits, . _ -, max 128 chars)" }); return; }
  const rt = getRuntime(DEFAULT_VM_ID);
  const ok = writeMonitor(DEFAULT_VM_ID, `savevm ${name}`);
  res.json(SnapshotVmResponse.parse({ success: ok, message: ok ? `Snapshot '${name}' requested` : "VM must be running to take a snapshot", state: rt.state }));
});

router.get("/vm/snapshot/list", async (_req: Request, res: Response) => {
  const vm = getVm(DEFAULT_VM_ID);
  if (!vm?.config.diskPath) { res.json({ success: true, snapshots: [], message: "No disk image configured" }); return; }
  if (!canRunOfflineImg(DEFAULT_VM_ID)) { res.json({ success: false, snapshots: [], message: `Stop the VM fully to list snapshots (current state: ${getRuntime(DEFAULT_VM_ID).state})` }); return; }
  const r = await runQemuImg(["snapshot", "-l", vm.config.diskPath]);
  if (!r.ok) { res.json({ success: false, snapshots: [], message: r.error || "Failed to list snapshots" }); return; }
  res.json({ success: true, snapshots: parseSnapshotList(r.stdout) });
});

router.post("/vm/snapshot/restore", async (req: Request, res: Response) => {
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : req.body?.name;
  if (!isValidSnapshotName(name)) { res.status(400).json({ success: false, message: "Invalid snapshot name" }); return; }
  const rt = getRuntime(DEFAULT_VM_ID);
  if (writeMonitor(DEFAULT_VM_ID, `loadvm ${name}`)) { res.json({ success: true, message: `Restore of '${name}' requested`, state: rt.state }); return; }
  const vm = getVm(DEFAULT_VM_ID);
  if (!canRunOfflineImg(DEFAULT_VM_ID) || !vm?.config.diskPath) { res.json({ success: false, message: `VM is busy; stop it fully before restoring a snapshot offline`, state: rt.state }); return; }
  const r = await runQemuImg(["snapshot", "-a", name, vm.config.diskPath]);
  res.json(r.ok ? { success: true, message: `Snapshot '${name}' restored`, state: rt.state } : { success: false, message: r.error || "Failed to restore snapshot", state: rt.state });
});

router.post("/vm/snapshot/delete", async (req: Request, res: Response) => {
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : req.body?.name;
  if (!isValidSnapshotName(name)) { res.status(400).json({ success: false, message: "Invalid snapshot name" }); return; }
  const rt = getRuntime(DEFAULT_VM_ID);
  if (writeMonitor(DEFAULT_VM_ID, `delvm ${name}`)) { res.json({ success: true, message: `Delete of '${name}' requested`, state: rt.state }); return; }
  const vm = getVm(DEFAULT_VM_ID);
  if (!canRunOfflineImg(DEFAULT_VM_ID) || !vm?.config.diskPath) { res.json({ success: false, message: `VM is busy; stop it fully before deleting a snapshot offline`, state: rt.state }); return; }
  const r = await runQemuImg(["snapshot", "-d", name, vm.config.diskPath]);
  res.json(r.ok ? { success: true, message: `Snapshot '${name}' deleted`, state: rt.state } : { success: false, message: r.error || "Failed to delete snapshot", state: rt.state });
});

router.get("/vm/config", (_req: Request, res: Response) => {
  const vm = getVm(DEFAULT_VM_ID);
  if (!vm) { res.status(503).json({ error: "Default VM not initialized" }); return; }
  res.json(GetVmConfigResponse.parse(vm.config));
});

router.put("/vm/config", (req: Request, res: Response) => {
  const parsed = UpdateVmConfigBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const updated = updateVmConfig(DEFAULT_VM_ID, parsed.data);
  if (!updated) { res.status(503).json({ error: "Default VM not initialized" }); return; }
  res.json(GetVmConfigResponse.parse(updated.config));
});

// ── Project path ──────────────────────────────────────────────────────────────

router.get("/:id/project-path", (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const vm = getVm(Array.isArray(id) ? id[0] : id);
  if (!vm) return res.status(404).json({ error: "VM not found" });
  return res.json({ projectPath: vm.config.projectPath ?? null });
});

router.put("/:id/project-path", (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const vmId = Array.isArray(id) ? id[0] : id;
  const vm = getVm(vmId);
  if (!vm) return res.status(404).json({ error: "VM not found" });
  const { projectPath } = req.body as { projectPath?: unknown };
  const p = typeof projectPath === "string" ? projectPath.trim() || null : null;
  const updated = updateVmConfig(vmId, { projectPath: p });
  if (!updated) return res.status(500).json({ error: "Failed to save project path" });
  return res.json({ ok: true, projectPath: p });
});

// ── Project backup ─────────────────────────────────────────────────────────────

const DATA_DIR_BACKUP = path.join(
  process.env["ODYSSEUS_DATA_DIR"] || process.env.HOME || "/tmp",
  ".odysseus-vm-backups",
);

interface BackupMeta {
  backupId: string;
  vmId: string;
  vmName: string;
  projectPath: string;
  backedUpAt: string;
  sizeBytes: number;
  filename: string;
}

function listBackupFiles(vmId: string): BackupMeta[] {
  const vmDir = path.join(DATA_DIR_BACKUP, vmId);
  try {
    if (!fs.existsSync(vmDir)) return [];
    return fs
      .readdirSync(vmDir)
      .map((name) => {
        const metaPath = path.join(vmDir, name, "meta.json");
        try {
          const raw = fs.readFileSync(metaPath, "utf8");
          return JSON.parse(raw) as BackupMeta;
        } catch {
          return null;
        }
      })
      .filter((m): m is BackupMeta => m !== null)
      .sort((a, b) => b.backedUpAt.localeCompare(a.backedUpAt));
  } catch {
    return [];
  }
}

// Build the PowerShell command to compress a project dir to a zip on Windows.
function psCompress(srcPath: string, zipPath: string): string {
  const src = srcPath.replace(/'/g, "''");
  const dst = zipPath.replace(/'/g, "''");
  return (
    `powershell -NoProfile -NonInteractive -Command ` +
    `"Compress-Archive -LiteralPath '${src}' -DestinationPath '${dst}' -Force"`
  );
}

// Build the shell command to compress a project dir to a tar.gz on Linux.
function shCompress(srcPath: string, tarPath: string): string {
  const parent = path.posix.dirname(srcPath);
  const base = path.posix.basename(srcPath);
  return `tar czf '${tarPath.replace(/'/g, "'\\''")}' -C '${parent.replace(/'/g, "'\\''")}' '${base.replace(/'/g, "'\\''")}'`;
}

router.post("/:id/project-backup", async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const vmId = Array.isArray(id) ? id[0] : id;
  const vm = getVm(vmId);
  if (!vm) return res.status(404).json({ error: "VM not found" });

  const projectPath = (req.body as { projectPath?: string }).projectPath?.trim()
    || vm.config.projectPath?.trim();
  if (!projectPath) {
    return res.status(400).json({
      error: "No project path configured. Set one in VM settings or pass projectPath in the request body.",
    });
  }

  const isWindows = vm.osKind === "windows";
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const backupId = timestamp;
  const filename = `backup_${backupId}.zip`;
  const vmBackupDir = path.join(DATA_DIR_BACKUP, vmId, backupId);
  const localZipPath = path.join(vmBackupDir, filename);

  // 1. Create the local backup directory.
  fs.mkdirSync(vmBackupDir, { recursive: true });

  // 2. Compress the project on the guest.
  const tempZipOnGuest = isWindows ? "C:\\Temp\\ff_backup_tmp.zip" : "/tmp/ff_backup_tmp.tar.gz";
  const compressCmd = isWindows
    ? psCompress(projectPath, tempZipOnGuest)
    : shCompress(projectPath, tempZipOnGuest);

  const compResult = await runSshCommand(vm, compressCmd, 120_000);
  if (!compResult.ok) {
    fs.rmSync(vmBackupDir, { recursive: true, force: true });
    return res.status(500).json({
      error: `Failed to compress project on guest: ${compResult.stderr || compResult.stdout || "(no output)"}`,
    });
  }

  // 3. SCP the archive from the guest to the host.
  // On Windows OpenSSH, the SCP remote path uses forward slashes. Drive letters
  // need the form: C:/Temp/file.zip (no leading slash — some implementations
  // need the drive letter as-is for the guest root).
  const guestScpPath = isWindows
    ? tempZipOnGuest.replace(/\\/g, "/")
    : tempZipOnGuest;

  const pullResult = await runScpPull(vm, guestScpPath, localZipPath, 300_000);
  if (!pullResult.ok) {
    fs.rmSync(vmBackupDir, { recursive: true, force: true });
    return res.status(500).json({
      error: `Failed to copy backup from guest: ${pullResult.stderr || "(no output)"}`,
    });
  }

  // 4. Clean up the temp archive on the guest.
  const cleanCmd = isWindows
    ? `powershell -NoProfile -NonInteractive -Command "Remove-Item -LiteralPath '${tempZipOnGuest.replace(/'/g, "''")}' -Force -ErrorAction SilentlyContinue"`
    : `rm -f '${tempZipOnGuest.replace(/'/g, "\\'")}'`;
  // Fire-and-forget — backup already succeeded.
  runSshCommand(vm, cleanCmd, 15_000).catch(() => {});

  // 5. Measure the zip and write metadata.
  let sizeBytes = 0;
  try { sizeBytes = fs.statSync(localZipPath).size; } catch { /* ignore */ }

  const meta: BackupMeta = {
    backupId,
    vmId,
    vmName: vm.name,
    projectPath,
    backedUpAt: new Date().toISOString(),
    sizeBytes,
    filename,
  };
  fs.writeFileSync(path.join(vmBackupDir, "meta.json"), JSON.stringify(meta, null, 2));

  // 6. Save project path back to config if it wasn't already set.
  if (!vm.config.projectPath) updateVmConfig(vmId, { projectPath });

  logger.info({ vmId, projectPath, sizeBytes }, "Project backup completed");
  return res.json({ ok: true, backupId, filename, sizeBytes, backedUpAt: meta.backedUpAt });
});

router.get("/:id/project-backups", (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const vmId = Array.isArray(id) ? id[0] : id;
  const vm = getVm(vmId);
  if (!vm) return res.status(404).json({ error: "VM not found" });
  const backups = listBackupFiles(vmId);
  return res.json({ backups });
});

router.post("/:id/project-restore/:backupId", async (req: Request, res: Response) => {
  const { id, backupId } = req.params as { id: string; backupId: string };
  const vmId = Array.isArray(id) ? id[0] : id;
  const vm = getVm(vmId);
  if (!vm) return res.status(404).json({ error: "VM not found" });

  const meta = listBackupFiles(vmId).find((b) => b.backupId === backupId);
  if (!meta) return res.status(404).json({ error: "Backup not found" });

  const localZipPath = path.join(DATA_DIR_BACKUP, vmId, backupId, meta.filename);
  if (!fs.existsSync(localZipPath)) {
    return res.status(404).json({ error: "Backup archive file is missing from host" });
  }

  const isWindows = vm.osKind === "windows";
  const tempZipOnGuest = isWindows ? "C:\\Temp\\ff_restore_tmp.zip" : "/tmp/ff_restore_tmp.tar.gz";
  const guestScpDst = isWindows ? tempZipOnGuest.replace(/\\/g, "/") : tempZipOnGuest;

  // 1. Push the archive to the guest.
  const pushResult = await runScpPush(vm, localZipPath, guestScpDst, 300_000);
  if (!pushResult.ok) {
    return res.status(500).json({ error: `Failed to upload backup to guest: ${pushResult.stderr}` });
  }

  // 2. Expand on the guest.
  const projectParent = isWindows
    ? path.win32.dirname(meta.projectPath)
    : path.posix.dirname(meta.projectPath);

  const expandCmd = isWindows
    ? `powershell -NoProfile -NonInteractive -Command "Expand-Archive -LiteralPath '${tempZipOnGuest.replace(/'/g, "''")}' -DestinationPath '${projectParent.replace(/'/g, "''")}' -Force"`
    : `tar xzf '${tempZipOnGuest.replace(/'/g, "\\'")}' -C '${projectParent.replace(/'/g, "\\'")}'`;

  const expResult = await runSshCommand(vm, expandCmd, 120_000);

  // 3. Cleanup temp archive on guest.
  const cleanCmd = isWindows
    ? `powershell -NoProfile -NonInteractive -Command "Remove-Item -LiteralPath '${tempZipOnGuest.replace(/'/g, "''")}' -Force -ErrorAction SilentlyContinue"`
    : `rm -f '${tempZipOnGuest.replace(/'/g, "\\'")}'`;
  runSshCommand(vm, cleanCmd, 15_000).catch(() => {});

  if (!expResult.ok) {
    return res.status(500).json({ error: `Failed to extract backup on guest: ${expResult.stderr || expResult.stdout}` });
  }

  logger.info({ vmId, backupId, projectPath: meta.projectPath }, "Project restore completed");
  return res.json({ ok: true, projectPath: meta.projectPath, backedUpAt: meta.backedUpAt });
});

// ── Shared offline-image helpers ───────────────────────────────────────────────

// qemu-img may only touch a qcow2 when no QEMU process holds it open, else it can
// corrupt the active disk. Allow offline ops strictly when fully stopped.
function canRunOfflineImg(vmId: string): boolean {
  const rt = getRuntime(vmId);
  return rt.state === "stopped" && !rt.process;
}

function clampInt(v: unknown, min: number, max: number, dflt: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return Math.min(Math.max(dflt, min), max);
  return Math.min(Math.max(Math.floor(n), min), max);
}

function runQemuImg(
  args: string[],
  timeoutMs = 30000,
): Promise<{ ok: boolean; stdout: string; stderr: string; error?: string }> {
  return new Promise((resolve) => {
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn("qemu-img", args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolve({ ok: false, stdout: "", stderr: "", error: err instanceof Error ? err.message : String(err) });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const done = (r: { ok: boolean; stdout: string; stderr: string; error?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch { /* ignore */ }
      done({ ok: false, stdout, stderr, error: `qemu-img timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    proc.stdout?.on("data", (d) => { stdout += d.toString(); });
    proc.stderr?.on("data", (d) => { stderr += d.toString(); });
    proc.on("error", (err: NodeJS.ErrnoException) => {
      done({ ok: false, stdout, stderr, error: err.code === "ENOENT" ? "qemu-img not installed in this environment" : err.message });
    });
    proc.on("close", (code) => {
      done({ ok: code === 0, stdout, stderr, error: code === 0 ? undefined : (stderr.trim() || `qemu-img exited ${code}`) });
    });
  });
}

function parseSnapshotList(stdout: string): Array<{ id: string; name: string }> {
  const out: Array<{ id: string; name: string }> = [];
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (/^Snapshot list:/i.test(line)) continue;
    if (/^ID\s+TAG/i.test(line)) continue;
    const parts = line.split(/\s+/);
    if (parts.length >= 2) out.push({ id: parts[0], name: parts[1] });
  }
  return out;
}

export default router;

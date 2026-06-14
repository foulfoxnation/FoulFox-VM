import { Router, type IRouter, type Request, type Response } from "express";
import { spawn } from "child_process";
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
  type VmRecord,
} from "../lib/vm-registry";
import { startVm, stopVm, writeMonitor } from "../lib/vm-launch";
import {
  detectHostCapabilities,
  isValidVmId,
  isValidVmName,
  isValidSnapshotName,
  isOsKind,
  type OsKind,
} from "../lib/vm-capabilities";
import { startProvisioning, subscribeProvisioning } from "../lib/vm-provision";
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
    ports: vm.ports,
    provisioning: vm.provisioning,
    displayToken: vm.displayToken,
  };
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
  const ramDefault = image?.defaultRamGb ?? (osKind === "windows" ? 4 : 2);
  const diskDefault = image?.defaultDiskGb ?? (osKind === "windows" ? 64 : 32);
  const ramGb = clampInt(req.body?.ramGb, 1, Math.max(2, Math.floor(caps.totalRamGb * 0.5)), ramDefault);
  const cpuCores = clampInt(req.body?.cpuCores, 1, Math.max(1, caps.cpuCount), 2);
  const diskGb = clampInt(req.body?.diskGb, 8, 256, diskDefault);

  // Aggregate-resource guardrails across all VMs.
  const totalRam = existing.reduce((s, v) => s + v.config.ramGb, 0) + ramGb;
  if (totalRam > Math.max(2, Math.floor(caps.totalRamGb * 0.75))) {
    res.status(409).json({ error: `Not enough RAM: this VM would push total allocation to ${totalRam}GB, above the ${Math.floor(caps.totalRamGb * 0.75)}GB cap.` });
    return;
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

// POST /vm/:id/start
router.post("/vm/:id/start", (req: Request, res: Response) => {
  const vm = requireVm(req, res); if (!vm) return;
  const r = startVm(vm);
  res.json({ success: r.ok, message: r.message, state: r.state });
});

// POST /vm/:id/stop
router.post("/vm/:id/stop", (req: Request, res: Response) => {
  const vm = requireVm(req, res); if (!vm) return;
  const r = stopVm(vm);
  res.json({ success: r.ok, message: r.message, state: r.state });
});

// POST /vm/:id/restart
router.post("/vm/:id/restart", (req: Request, res: Response) => {
  const vm = requireVm(req, res); if (!vm) return;
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
  const r = startVm(vm);
  res.json(StartVmResponse.parse({ success: r.ok, message: r.message, state: r.state }));
});

router.post("/vm/stop", (_req: Request, res: Response) => {
  const vm = getVm(DEFAULT_VM_ID);
  if (!vm) { res.json(StopVmResponse.parse({ success: false, message: "Default VM not initialized", state: "error" })); return; }
  const r = stopVm(vm);
  res.json(StopVmResponse.parse({ success: r.ok, message: r.message, state: r.state }));
});

router.post("/vm/restart", (_req: Request, res: Response) => {
  const vm = getVm(DEFAULT_VM_ID);
  if (!vm) { res.json(RestartVmResponse.parse({ success: false, message: "Default VM not initialized", state: "error" })); return; }
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

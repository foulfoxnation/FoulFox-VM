import { Router, type IRouter, type Request, type Response } from "express";
import { spawn } from "child_process";
import fs from "fs";
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
import { vmRuntime, loadVmConfig, saveVmConfig } from "../lib/vm-state";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// GET /vm/status
router.get("/vm/status", (_req: Request, res: Response) => {
  const config = loadVmConfig();
  const uptime = vmRuntime.startTime ? Math.floor((Date.now() - vmRuntime.startTime) / 1000) : null;

  const status = GetVmStatusResponse.parse({
    state: vmRuntime.state,
    pid: vmRuntime.process?.pid ?? null,
    uptime,
    isoPath: config.isoPath,
    diskPath: config.diskPath,
    ramGb: config.ramGb,
    cpuCores: config.cpuCores,
    gpuPassthrough: config.gpuPassthrough,
    connectionMode: config.connectionMode,
    sshPort: config.sshPort,
  });

  res.json(status);
});

// GET /vm/capabilities — honestly report whether THIS host can boot a VM.
// Used by the setup wizard so it never promises a VM the host can't run.
router.get("/vm/capabilities", async (_req: Request, res: Response) => {
  const kvm = detectKvm();
  const [qemuSystem, qemuImg] = await Promise.all([
    binaryExists("qemu-system-x86_64"),
    binaryExists("qemu-img"),
  ]);
  const canBootVm = kvm.available && qemuSystem;
  let message: string;
  if (canBootVm) {
    message = "This machine can boot a Windows VM (KVM acceleration + QEMU available).";
  } else if (!kvm.available && !qemuSystem) {
    message = "Cannot boot a VM here: no KVM acceleration and QEMU is not installed. Run Odysseus on your own machine with hardware virtualization enabled.";
  } else if (!kvm.available) {
    message = `Cannot boot a VM here: ${kvm.reason}. Snapshot/config still work, but booting needs a host with KVM (your own machine).`;
  } else {
    message = "QEMU is not installed. Install qemu-system-x86_64 (and qemu-img) to boot the VM.";
  }
  res.json({
    canBootVm,
    kvm: kvm.available,
    kvmReason: kvm.reason,
    qemuSystem,
    qemuImg,
    platform: process.platform,
    arch: process.arch,
    message,
  });
});

// POST /vm/start
router.post("/vm/start", (_req: Request, res: Response) => {
  if (vmRuntime.state === "running" || vmRuntime.state === "starting") {
    res.json(StartVmResponse.parse({ success: false, message: "VM is already running", state: vmRuntime.state }));
    return;
  }

  const config = loadVmConfig();

  if (!config.diskPath && !config.isoPath) {
    res.json(StartVmResponse.parse({
      success: false,
      message: "No ISO or disk image configured. Open Settings to configure the VM.",
      state: vmRuntime.state,
    }));
    return;
  }

  vmRuntime.state = "starting";

  const args: string[] = [
    "-enable-kvm",
    "-m", `${config.ramGb}G`,
    "-smp", `cores=${config.cpuCores}`,
    "-cpu", "host",
    "-machine", "type=q35,accel=kvm",
    "-net", "nic,model=virtio",
    "-net", `user,hostfwd=tcp::${config.sshPort}-:22,hostfwd=tcp::3389-:3389`,
    "-device", "virtio-vga",
    "-display", "none",
    // QEMU monitor on stdio for snapshot commands
    "-monitor", "stdio",
  ];

  if (config.gpuPassthrough) {
    args.push("-device", `vfio-pci,host=${config.gpuPassthrough}`);
  }
  if (config.diskPath) {
    args.push("-hda", config.diskPath);
  }
  if (config.isoPath) {
    args.push("-cdrom", config.isoPath);
    if (!config.diskPath) args.push("-boot", "d");
  }
  if (config.connectionMode === "serial") {
    args.push("-serial", "telnet:localhost:4444,server,nowait");
  }

  try {
    vmRuntime.process = spawn("qemu-system-x86_64", args, {
      detached: false,
      stdio: "pipe",
    });

    vmRuntime.process.on("error", (err) => {
      logger.error({ err }, "QEMU process error");
      vmRuntime.state = "error";
      vmRuntime.process = null;
      vmRuntime.startTime = null;
    });

    vmRuntime.process.on("exit", (code) => {
      logger.info({ code }, "QEMU process exited");
      vmRuntime.state = "stopped";
      vmRuntime.process = null;
      vmRuntime.startTime = null;
    });

    // Promote to "running" after 3s if process is still alive
    setTimeout(() => {
      if (vmRuntime.process && !vmRuntime.process.killed) {
        vmRuntime.state = "running";
        vmRuntime.startTime = Date.now();
      }
    }, 3000);

    res.json(StartVmResponse.parse({
      success: true,
      message: "VM starting with KVM acceleration. Connect via SSH once it's ready.",
      state: vmRuntime.state,
    }));
  } catch (err) {
    vmRuntime.state = "error";
    logger.error({ err }, "Failed to start QEMU");
    res.json(StartVmResponse.parse({
      success: false,
      message: `Failed to start VM: ${err instanceof Error ? err.message : String(err)}`,
      state: vmRuntime.state,
    }));
  }
});

// POST /vm/stop
router.post("/vm/stop", (_req: Request, res: Response) => {
  if (!vmRuntime.process || vmRuntime.state === "stopped") {
    res.json(StopVmResponse.parse({ success: false, message: "VM is not running", state: "stopped" }));
    return;
  }

  vmRuntime.state = "stopping";
  vmRuntime.process.kill("SIGTERM");

  setTimeout(() => {
    if (vmRuntime.process) vmRuntime.process.kill("SIGKILL");
  }, 10000);

  res.json(StopVmResponse.parse({ success: true, message: "VM shutting down", state: vmRuntime.state }));
});

// POST /vm/restart
router.post("/vm/restart", (_req: Request, res: Response) => {
  if (vmRuntime.process) {
    vmRuntime.process.kill("SIGTERM");
    vmRuntime.process = null;
  }
  vmRuntime.state = "stopped";
  vmRuntime.startTime = null;

  res.json(RestartVmResponse.parse({
    success: true,
    message: "VM stopped. Restarting... (call /vm/start if not automatic)",
    state: "stopped",
  }));

  // Auto-start after brief delay
  setTimeout(() => {
    const config = loadVmConfig();
    if (!config.diskPath && !config.isoPath) return;

    vmRuntime.state = "starting";
    const args = buildQemuArgs(config);

    vmRuntime.process = spawn("qemu-system-x86_64", args, { detached: false, stdio: "pipe" });
    vmRuntime.process.on("error", (err) => {
      logger.error({ err }, "QEMU restart error");
      vmRuntime.state = "error";
      vmRuntime.process = null;
    });
    vmRuntime.process.on("exit", (code) => {
      logger.info({ code }, "QEMU restarted process exited");
      vmRuntime.state = "stopped";
      vmRuntime.process = null;
      vmRuntime.startTime = null;
    });
    setTimeout(() => {
      if (vmRuntime.process && !vmRuntime.process.killed) {
        vmRuntime.state = "running";
        vmRuntime.startTime = Date.now();
      }
    }, 3000);
  }, 1500);
});

// POST /vm/snapshot
router.post("/vm/snapshot", (req: Request, res: Response) => {
  const parsed = SnapshotVmBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  if (vmRuntime.state !== "running" || !vmRuntime.process) {
    res.json(SnapshotVmResponse.parse({ success: false, message: "VM must be running to take a snapshot", state: vmRuntime.state }));
    return;
  }

  const { name } = parsed.data;
  if (!isValidSnapshotName(name)) {
    res.status(400).json({ error: "Invalid snapshot name (allowed: letters, digits, . _ -, max 128 chars)" });
    return;
  }
  if (vmRuntime.process.stdin) {
    vmRuntime.process.stdin.write(`savevm ${name}\n`);
    res.json(SnapshotVmResponse.parse({ success: true, message: `Snapshot '${name}' requested`, state: vmRuntime.state }));
  } else {
    res.json(SnapshotVmResponse.parse({ success: false, message: "Cannot communicate with VM monitor", state: vmRuntime.state }));
  }
});

// GET /vm/snapshot/list — list snapshots stored in the qcow2 disk.
// qemu-img can only safely read the image while the VM is stopped.
router.get("/vm/snapshot/list", async (_req: Request, res: Response) => {
  const config = loadVmConfig();
  if (!config.diskPath) {
    res.json({ success: true, snapshots: [], message: "No disk image configured" });
    return;
  }
  if (!canRunOfflineImg()) {
    res.json({ success: false, snapshots: [], message: `Stop the VM fully to list snapshots (current state: ${vmRuntime.state})` });
    return;
  }
  const r = await runQemuImg(["snapshot", "-l", config.diskPath]);
  if (!r.ok) {
    res.json({ success: false, snapshots: [], message: r.error || "Failed to list snapshots" });
    return;
  }
  res.json({ success: true, snapshots: parseSnapshotList(r.stdout) });
});

// POST /vm/snapshot/restore { name } — load a snapshot.
// Running VM: via the QEMU monitor (loadvm). Stopped VM: via qemu-img -a.
router.post("/vm/snapshot/restore", async (req: Request, res: Response) => {
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : req.body?.name;
  if (!isValidSnapshotName(name)) {
    res.status(400).json({ success: false, message: "Invalid snapshot name (allowed: letters, digits, . _ -, max 128 chars)" });
    return;
  }
  if (vmRuntime.state === "running" && vmRuntime.process?.stdin) {
    vmRuntime.process.stdin.write(`loadvm ${name}\n`);
    res.json({ success: true, message: `Restore of '${name}' requested`, state: vmRuntime.state });
    return;
  }
  if (!canRunOfflineImg()) {
    res.json({ success: false, message: `VM is busy (state: ${vmRuntime.state}); stop it fully before restoring a snapshot offline`, state: vmRuntime.state });
    return;
  }
  const config = loadVmConfig();
  if (!config.diskPath) {
    res.json({ success: false, message: "No disk image configured", state: vmRuntime.state });
    return;
  }
  const r = await runQemuImg(["snapshot", "-a", name, config.diskPath]);
  res.json(r.ok
    ? { success: true, message: `Snapshot '${name}' restored`, state: vmRuntime.state }
    : { success: false, message: r.error || "Failed to restore snapshot", state: vmRuntime.state });
});

// POST /vm/snapshot/delete { name } — delete a snapshot.
// Running VM: via the QEMU monitor (delvm). Stopped VM: via qemu-img -d.
router.post("/vm/snapshot/delete", async (req: Request, res: Response) => {
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : req.body?.name;
  if (!isValidSnapshotName(name)) {
    res.status(400).json({ success: false, message: "Invalid snapshot name (allowed: letters, digits, . _ -, max 128 chars)" });
    return;
  }
  if (vmRuntime.state === "running" && vmRuntime.process?.stdin) {
    vmRuntime.process.stdin.write(`delvm ${name}\n`);
    res.json({ success: true, message: `Delete of '${name}' requested`, state: vmRuntime.state });
    return;
  }
  if (!canRunOfflineImg()) {
    res.json({ success: false, message: `VM is busy (state: ${vmRuntime.state}); stop it fully before deleting a snapshot offline`, state: vmRuntime.state });
    return;
  }
  const config = loadVmConfig();
  if (!config.diskPath) {
    res.json({ success: false, message: "No disk image configured", state: vmRuntime.state });
    return;
  }
  const r = await runQemuImg(["snapshot", "-d", name, config.diskPath]);
  res.json(r.ok
    ? { success: true, message: `Snapshot '${name}' deleted`, state: vmRuntime.state }
    : { success: false, message: r.error || "Failed to delete snapshot", state: vmRuntime.state });
});

// GET /vm/config
router.get("/vm/config", (_req: Request, res: Response) => {
  res.json(GetVmConfigResponse.parse(loadVmConfig()));
});

// PUT /vm/config
router.put("/vm/config", (req: Request, res: Response) => {
  const parsed = UpdateVmConfigBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const updated = { ...loadVmConfig(), ...parsed.data };
  saveVmConfig(updated);
  res.json(GetVmConfigResponse.parse(updated));
});

// Snapshot names go into QEMU monitor stdin (newline-delimited) and qemu-img
// argv, so restrict to a safe charset to prevent monitor-command injection.
const SNAPSHOT_NAME_RE = /^[A-Za-z0-9._-]{1,128}$/;
function isValidSnapshotName(name: unknown): name is string {
  return typeof name === "string" && SNAPSHOT_NAME_RE.test(name);
}

// qemu-img may only touch the qcow2 when no QEMU process holds it open, else it
// can corrupt an active disk. Allow offline image ops strictly when fully
// stopped with no live process (rejects starting/stopping/error/live-process).
function canRunOfflineImg(): boolean {
  return vmRuntime.state === "stopped" && !vmRuntime.process;
}

// Honest KVM detection: /dev/kvm must exist AND be read/write accessible.
function detectKvm(): { available: boolean; reason: string } {
  if (!fs.existsSync("/dev/kvm")) {
    return { available: false, reason: "/dev/kvm is not present (no hardware virtualization, e.g. a cloud/container host)" };
  }
  try {
    fs.accessSync("/dev/kvm", fs.constants.R_OK | fs.constants.W_OK);
    return { available: true, reason: "/dev/kvm is present and accessible" };
  } catch {
    return { available: false, reason: "/dev/kvm exists but is not readable/writable by this process (check kvm group/permissions)" };
  }
}

// Whether a binary is on PATH. Spawns `<cmd> --version`; ENOENT/timeout => false.
function binaryExists(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(cmd, ["--version"], { stdio: "ignore" });
    } catch {
      resolve(false);
      return;
    }
    let settled = false;
    const finish = (v: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* ignore */ } finish(false); }, 5000);
    proc.on("error", () => finish(false)); // ENOENT => not installed
    proc.on("close", () => finish(true));  // ran at all => exists
  });
}

// Helper: run qemu-img and capture output. Resolves (never rejects); reports
// ENOENT honestly so callers can surface "not installed" (e.g. no-KVM host).
// A timeout guards against missing/hung tooling stalling the request.
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
      done({
        ok: false,
        stdout,
        stderr,
        error: err.code === "ENOENT" ? "qemu-img not installed in this environment" : err.message,
      });
    });
    proc.on("close", (code) => {
      done({
        ok: code === 0,
        stdout,
        stderr,
        error: code === 0 ? undefined : (stderr.trim() || `qemu-img exited ${code}`),
      });
    });
  });
}

// Parse `qemu-img snapshot -l` table output into [{ id, name }].
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

// Helper: build QEMU args from config
function buildQemuArgs(config: ReturnType<typeof loadVmConfig>): string[] {
  const args = [
    "-enable-kvm", "-m", `${config.ramGb}G`, "-smp", `cores=${config.cpuCores}`,
    "-cpu", "host", "-machine", "type=q35,accel=kvm",
    "-net", "nic,model=virtio",
    "-net", `user,hostfwd=tcp::${config.sshPort}-:22,hostfwd=tcp::3389-:3389`,
    "-device", "virtio-vga", "-display", "none", "-monitor", "stdio",
  ];
  if (config.gpuPassthrough) args.push("-device", `vfio-pci,host=${config.gpuPassthrough}`);
  if (config.diskPath) args.push("-hda", config.diskPath);
  if (config.isoPath) { args.push("-cdrom", config.isoPath); if (!config.diskPath) args.push("-boot", "d"); }
  if (config.connectionMode === "serial") args.push("-serial", "telnet:localhost:4444,server,nowait");
  return args;
}

export default router;

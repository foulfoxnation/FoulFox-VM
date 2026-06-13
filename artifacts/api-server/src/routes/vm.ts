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
  if (vmRuntime.process.stdin) {
    vmRuntime.process.stdin.write(`savevm ${name}\n`);
    res.json(SnapshotVmResponse.parse({ success: true, message: `Snapshot '${name}' requested`, state: vmRuntime.state }));
  } else {
    res.json(SnapshotVmResponse.parse({ success: false, message: "Cannot communicate with VM monitor", state: vmRuntime.state }));
  }
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

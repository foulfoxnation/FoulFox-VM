import { Router, type IRouter, type Request, type Response } from "express";
import { spawn, type ChildProcess } from "child_process";
import fs from "fs";
import path from "path";
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
import { logger } from "../lib/logger";

const router: IRouter = Router();

const CONFIG_PATH = path.join(process.env.HOME || "/tmp", ".odysseus-vm-config.json");

type VmState = "stopped" | "starting" | "running" | "stopping" | "error";

interface VmConfigData {
  isoPath: string | null;
  diskPath: string | null;
  ramGb: number;
  cpuCores: number;
  gpuPassthrough: string | null;
  connectionMode: "serial" | "ssh";
  sshPort: number;
  sshUser: string | null;
  sshPassword: string | null;
}

const DEFAULT_CONFIG: VmConfigData = {
  isoPath: null,
  diskPath: null,
  ramGb: 8,
  cpuCores: 4,
  gpuPassthrough: null,
  connectionMode: "ssh",
  sshPort: 5985,
  sshUser: null,
  sshPassword: null,
};

let vmProcess: ChildProcess | null = null;
let vmState: VmState = "stopped";
let vmStartTime: number | null = null;

function loadConfig(): VmConfigData {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")) };
    }
  } catch {
    // ignore
  }
  return { ...DEFAULT_CONFIG };
}

function saveConfig(config: VmConfigData) {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  } catch (err) {
    logger.error({ err }, "Failed to save VM config");
  }
}

// GET /vm/status
router.get("/vm/status", (_req: Request, res: Response) => {
  const config = loadConfig();
  const uptime = vmStartTime ? Math.floor((Date.now() - vmStartTime) / 1000) : null;

  const status = GetVmStatusResponse.parse({
    state: vmState,
    pid: vmProcess?.pid ?? null,
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
  if (vmState === "running" || vmState === "starting") {
    res.json(StartVmResponse.parse({ success: false, message: "VM is already running", state: vmState }));
    return;
  }

  const config = loadConfig();

  if (!config.diskPath && !config.isoPath) {
    res.json(StartVmResponse.parse({
      success: false,
      message: "No ISO or disk image configured. Open Settings to configure the VM.",
      state: vmState,
    }));
    return;
  }

  vmState = "starting";

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
  // QEMU monitor for snapshot commands
  args.push("-monitor", "stdio");

  try {
    vmProcess = spawn("qemu-system-x86_64", args, {
      detached: false,
      stdio: "pipe",
    });

    vmProcess.on("error", (err) => {
      logger.error({ err }, "QEMU process error");
      vmState = "error";
      vmProcess = null;
      vmStartTime = null;
    });

    vmProcess.on("exit", (code) => {
      logger.info({ code }, "QEMU process exited");
      vmState = "stopped";
      vmProcess = null;
      vmStartTime = null;
    });

    setTimeout(() => {
      if (vmProcess && !vmProcess.killed) {
        vmState = "running";
        vmStartTime = Date.now();
      }
    }, 3000);

    res.json(StartVmResponse.parse({
      success: true,
      message: "VM starting with KVM acceleration. Connect via SSH once it's ready.",
      state: vmState,
    }));
  } catch (err) {
    vmState = "error";
    logger.error({ err }, "Failed to start QEMU");
    res.json(StartVmResponse.parse({
      success: false,
      message: `Failed to start VM: ${err instanceof Error ? err.message : String(err)}`,
      state: vmState,
    }));
  }
});

// POST /vm/stop
router.post("/vm/stop", (_req: Request, res: Response) => {
  if (!vmProcess || vmState === "stopped") {
    res.json(StopVmResponse.parse({ success: false, message: "VM is not running", state: "stopped" }));
    return;
  }

  vmState = "stopping";
  vmProcess.kill("SIGTERM");

  setTimeout(() => {
    if (vmProcess) vmProcess.kill("SIGKILL");
  }, 10000);

  res.json(StopVmResponse.parse({ success: true, message: "VM shutting down", state: vmState }));
});

// POST /vm/restart
router.post("/vm/restart", (req: Request, res: Response) => {
  if (vmProcess) {
    vmProcess.kill("SIGTERM");
    vmProcess = null;
  }
  vmState = "stopped";
  vmStartTime = null;

  res.json(RestartVmResponse.parse({ success: true, message: "VM stopped. Call /vm/start to restart.", state: "stopped" }));
});

// POST /vm/snapshot
router.post("/vm/snapshot", (req: Request, res: Response) => {
  const parsed = SnapshotVmBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  if (vmState !== "running" || !vmProcess) {
    res.json(SnapshotVmResponse.parse({ success: false, message: "VM must be running to take a snapshot", state: vmState }));
    return;
  }

  const { name } = parsed.data;
  if (vmProcess.stdin) {
    vmProcess.stdin.write(`savevm ${name}\n`);
    res.json(SnapshotVmResponse.parse({ success: true, message: `Snapshot '${name}' requested`, state: vmState }));
  } else {
    res.json(SnapshotVmResponse.parse({ success: false, message: "Cannot communicate with VM monitor", state: vmState }));
  }
});

// GET /vm/config
router.get("/vm/config", (_req: Request, res: Response) => {
  const config = loadConfig();
  res.json(GetVmConfigResponse.parse(config));
});

// PUT /vm/config
router.put("/vm/config", (req: Request, res: Response) => {
  const parsed = UpdateVmConfigBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const current = loadConfig();
  const updated: VmConfigData = { ...current, ...parsed.data };
  saveConfig(updated);

  res.json(GetVmConfigResponse.parse(updated));
});

export default router;

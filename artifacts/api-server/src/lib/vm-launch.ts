import { spawn, execSync } from "child_process";
import fs from "fs";
import {
  type VmRecord,
  getRuntime,
  listVms,
  updateVm,
} from "./vm-registry";
import {
  selectAccelerator,
  qemuSystemBinary,
  type AcceleratorInfo,
} from "./vm-capabilities";
import { logger } from "./logger";

// QEMU VNC "display number" is added to 5900 to derive the listen port. We pick
// vnc ports >= 5900 (see vm-ports ranges) so this subtraction is always valid.
function vncDisplayNumber(vncPort: number): number {
  return Math.max(0, vncPort - 5900);
}

// Build the full qemu-system argv as an ARRAY (never a shell string) so VM
// names/paths can never inject extra arguments. The accelerator is auto-selected
// for the host OS with a clearly-flagged tcg (software emulation) fallback.
export function buildQemuArgs(vm: VmRecord, accel: AcceleratorInfo): string[] {
  const c = vm.config;
  const args: string[] = [];

  // CPU model: hardware accelerators expose the host CPU; software/whpx use max.
  const cpuModel = accel.accel === "kvm" || accel.accel === "hvf" ? "host" : "max";
  args.push("-machine", `type=q35,accel=${accel.accel}`);
  args.push("-accel", accel.accel);
  args.push("-cpu", cpuModel);
  args.push("-m", `${c.ramGb}G`);
  args.push("-smp", `cores=${c.cpuCores}`);

  // Networking: localhost-only host-forwards for SSH and RDP.
  args.push("-netdev", `user,id=net0,hostfwd=tcp:127.0.0.1:${vm.ports.ssh}-:22,hostfwd=tcp:127.0.0.1:${vm.ports.rdp}-:3389`);
  args.push("-device", "virtio-net,netdev=net0");

  // Graphical display: QEMU VNC bound to localhost with a websocket for noVNC.
  // We never expose an unauthenticated socket to the outside — the websocket is
  // localhost-only and the browser reaches it through our authenticated proxy.
  const disp = vncDisplayNumber(vm.ports.vnc);
  args.push("-vnc", `127.0.0.1:${disp},websocket=127.0.0.1:${vm.ports.vncWs}`);
  args.push("-device", "virtio-vga");

  // QMP monitor on a localhost TCP socket for lifecycle/snapshot control, plus a
  // stdio human monitor for savevm/loadvm/delvm (snapshot commands).
  args.push("-qmp", `tcp:127.0.0.1:${vm.ports.monitor},server,nowait`);
  args.push("-monitor", "stdio");
  args.push("-display", "none");

  if (c.gpuPassthrough) args.push("-device", `vfio-pci,host=${c.gpuPassthrough}`);

  if (c.diskPath) {
    args.push("-drive", `file=${c.diskPath},if=virtio,format=qcow2`);
  }
  if (c.isoPath) {
    args.push("-cdrom", c.isoPath);
    if (!c.diskPath) args.push("-boot", "d");
  }
  if (c.connectionMode === "serial") {
    // Serial console on a localhost telnet port derived from the monitor port.
    args.push("-serial", `telnet:127.0.0.1:${vm.ports.monitor + 1},server,nowait`);
  }

  return args;
}

export interface StartResult {
  ok: boolean;
  message: string;
  state: string;
}

// Start a VM by id. Returns honest failures (no KVM, no QEMU, no media) rather
// than pretending to boot.
export function startVm(vm: VmRecord): StartResult {
  const rt = getRuntime(vm.id);
  if (rt.state === "running" || rt.state === "starting") {
    return { ok: false, message: "VM is already running", state: rt.state };
  }
  if (!vm.config.diskPath && !vm.config.isoPath) {
    return { ok: false, message: "No disk image or ISO configured for this VM.", state: rt.state };
  }

  const accel = selectAccelerator();
  const bin = qemuSystemBinary(vm.osKind);
  const args = buildQemuArgs(vm, accel);
  rt.state = "starting";

  try {
    rt.process = spawn(bin, args, { detached: false, stdio: "pipe" });

    rt.process.on("error", (err: NodeJS.ErrnoException) => {
      logger.error({ err, vm: vm.id }, "QEMU process error");
      rt.state = "error";
      rt.process = null;
      rt.startTime = null;
    });
    rt.process.on("exit", (code) => {
      logger.info({ code, vm: vm.id }, "QEMU process exited");
      rt.state = "stopped";
      rt.process = null;
      rt.startTime = null;
    });

    // Promote to running after 3s if the process is still alive.
    setTimeout(() => {
      if (rt.process && !rt.process.killed) {
        rt.state = "running";
        rt.startTime = Date.now();
      }
    }, 3000);

    const accelNote = accel.hardware
      ? `Booting with ${accel.accel.toUpperCase()} acceleration.`
      : `WARNING: no hardware virtualization — booting with slow software emulation (${accel.accel}). ${accel.reason}`;
    return { ok: true, message: accelNote, state: rt.state };
  } catch (err) {
    rt.state = "error";
    logger.error({ err, vm: vm.id }, "Failed to spawn QEMU");
    return {
      ok: false,
      message: `Failed to start VM: ${err instanceof Error ? err.message : String(err)}`,
      state: rt.state,
    };
  }
}

export function stopVm(vm: VmRecord): StartResult {
  const rt = getRuntime(vm.id);
  if (!rt.process || rt.state === "stopped") {
    return { ok: false, message: "VM is not running", state: "stopped" };
  }
  rt.state = "stopping";
  rt.process.kill("SIGTERM");
  const proc = rt.process;
  setTimeout(() => {
    if (proc && !proc.killed) { try { proc.kill("SIGKILL"); } catch { /* ignore */ } }
  }, 10000);
  return { ok: true, message: "VM shutting down", state: rt.state };
}

// Write a command to a running VM's stdio QEMU monitor (snapshot ops).
export function writeMonitor(vmId: string, command: string): boolean {
  const rt = getRuntime(vmId);
  if (rt.state === "running" && rt.process?.stdin) {
    rt.process.stdin.write(command.endsWith("\n") ? command : command + "\n");
    return true;
  }
  return false;
}

// On server restart, runtime PIDs are lost. Any QEMU process still holding one
// of our managed disks would corrupt the qcow2 if we started a second QEMU on
// it. Reconcile by killing orphaned QEMU processes that reference a registered
// VM's disk path. Best-effort and Linux/macOS only (uses `ps`).
export function reconcileOrphans(): void {
  if (process.platform === "win32") return; // ps-based scan is POSIX only
  let psOut = "";
  try {
    psOut = execSync("ps -eo pid=,args=", { encoding: "utf-8", timeout: 5000 });
  } catch {
    return;
  }
  const disks = new Set<string>();
  for (const vm of listVms()) {
    if (vm.config.diskPath) disks.add(vm.config.diskPath);
  }
  if (disks.size === 0) return;

  for (const line of psOut.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(.*)$/);
    if (!m) continue;
    const [, pidStr, cmd] = m;
    if (!/qemu-system/.test(cmd)) continue;
    for (const disk of disks) {
      if (cmd.includes(disk)) {
        const pid = Number(pidStr);
        logger.warn({ pid, disk }, "Reconciling orphaned QEMU process holding a managed disk — terminating to prevent qcow2 corruption");
        try { process.kill(pid, "SIGKILL"); } catch { /* ignore */ }
        break;
      }
    }
  }
}

// qemu-img availability for offline image ops (snapshot list/create disk).
export function diskExists(p: string | null | undefined): boolean {
  return !!p && fs.existsSync(p);
}

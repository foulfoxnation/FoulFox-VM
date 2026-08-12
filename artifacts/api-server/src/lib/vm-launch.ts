import { spawn, execSync } from "child_process";
import fs from "fs";
import {
  type VmRecord,
  getRuntime,
  listVms,
  updateVm,
  isCloneSource,
  vmDiskDir,
} from "./vm-registry";
import path from "path";
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
  // NOTE: newer QEMU rejects passing BOTH "-machine accel=" and "-accel" —
  // "The -accel and -machine accel= options are incompatible". Specify the
  // accelerator once, on the machine option only.
  args.push("-machine", `type=q35,accel=${accel.accel}`);
  args.push("-cpu", cpuModel);
  args.push("-m", `${c.ramGb}G`);
  args.push("-smp", `cores=${c.cpuCores}`);

  // Networking: localhost-only host-forwards for SSH, RDP, and CDP (Chrome
  // DevTools :9222, for Playwright). Windows has no inbox virtio-net driver, so a
  // fresh install would have no network (and the auto-enabled OpenSSH/RDP would
  // be unreachable) until virtio drivers are installed — use e1000e, which
  // Windows drives out of the box. Linux keeps the faster virtio-net. NOTE: the
  // CDP forward arrives on the guest NIC IP (not loopback), so the in-guest side
  // must listen on 0.0.0.0 — a netsh portproxy handles that (see vm-provision.ts).
  args.push("-netdev", `user,id=net0,hostfwd=tcp:127.0.0.1:${vm.ports.ssh}-:22,hostfwd=tcp:127.0.0.1:${vm.ports.rdp}-:3389,hostfwd=tcp:127.0.0.1:${vm.ports.cdp}-:9222`);
  args.push("-device", `${vm.osKind === "windows" ? "e1000e" : "virtio-net"},netdev=net0`);

  // Graphical display: QEMU VNC bound to localhost with a websocket for noVNC.
  // We never expose an unauthenticated socket to the outside — the websocket is
  // localhost-only and the browser reaches it through our authenticated proxy.
  const disp = vncDisplayNumber(vm.ports.vnc);
  args.push("-vnc", `127.0.0.1:${disp},websocket=127.0.0.1:${vm.ports.vncWs}`);
  args.push("-device", "virtio-vga");

  // Additive SPICE endpoint. The in-shell noVNC viewer (proxying the VNC
  // websocket above) stays the guaranteed display path; when the appliance is
  // configured for SPICE (config.displayMode === "spice") we ALSO expose a
  // loopback SPICE server so the kiosk's fullscreen remote-viewer can attach.
  // VNC and SPICE coexist on one QEMU; ticketing is disabled because the socket
  // is localhost-only and never routed off the box.
  if (c.displayMode === "spice") {
    args.push("-spice", `port=${c.spicePort},addr=127.0.0.1,disable-ticketing=on`);
  }

  // Absolute pointing device for agent computer-use (screenshot → click at exact
  // pixel coordinates). The default PS/2 mouse is RELATIVE and cannot be
  // positioned deterministically from a screenshot; a USB tablet reports
  // ABSOLUTE coordinates, which is what QMP `input-send-event` abs axes need.
  // qemu-xhci is the modern USB controller (q35 has no USB by default) and
  // usb-tablet binds to it. Both Linux and Windows drive usb-tablet with in-box
  // HID drivers, and it is independent of the VNC display, so the live noVNC
  // view and a human using it are unaffected.
  args.push("-device", "qemu-xhci,id=xhci");
  args.push("-device", "usb-tablet,bus=xhci.0");

  // QMP monitor on a localhost TCP socket for lifecycle/snapshot control, plus a
  // stdio human monitor for savevm/loadvm/delvm (snapshot commands).
  args.push("-qmp", `tcp:127.0.0.1:${vm.ports.monitor},server,nowait`);
  args.push("-monitor", "stdio");
  args.push("-display", "none");

  if (c.gpuPassthrough) args.push("-device", `vfio-pci,host=${c.gpuPassthrough}`);

  // Storage + optical media. A fresh Windows installer cannot see a virtio disk
  // without first side-loading drivers, so Windows guests boot on an AHCI/SATA
  // controller their bundled drivers recognize, while Linux keeps fast virtio.
  // The install ISO boots first (bootindex 0) so a blank disk lands in setup;
  // the virtio-win and autounattend ISOs ride along as extra CDs (drivers to
  // install plus the answer file Windows Setup auto-detects on attached media).
  if (vm.osKind === "windows") {
    // UEFI firmware (OVMF) — mandatory for Windows 11. Without it QEMU falls
    // back to SeaBIOS, which cannot boot a UEFI-only Windows installation ISO
    // and reports "no bootable device" at startup.
    //
    // The pflash layout requires TWO drives in order:
    //   slot 0: OVMF_CODE.fd — read-only EFI code (from the OS ovmf package)
    //   slot 1: OVMF_VARS.fd — writeable NVRAM (per-VM copy so EFI boot entries
    //           persist across reboots; copied during provisioning)
    //
    // Common paths by distro (first match wins):
    const OVMF_CODE_CANDIDATES = [
      "/usr/share/OVMF/OVMF_CODE.fd",           // Debian/Ubuntu (ovmf package)
      "/usr/share/edk2/x64/OVMF_CODE.fd",       // Fedora/RHEL
      "/usr/share/OVMF/OVMF.fd",                // some distros (combined)
    ];
    const OVMF_VARS_CANDIDATES = [
      "/usr/share/OVMF/OVMF_VARS.fd",           // Debian/Ubuntu
      "/usr/share/edk2/x64/OVMF_VARS.fd",       // Fedora/RHEL
    ];
    const ovmfCodePath = OVMF_CODE_CANDIDATES.find((p) => fs.existsSync(p));
    if (!ovmfCodePath) {
      // OVMF is required for Windows 11 — it ships as a UEFI-only ISO that
      // SeaBIOS (QEMU's legacy fallback) cannot boot. Without the firmware the
      // guest will display "No bootable device" immediately. Fail fast with a
      // clear message so the user knows to install the ovmf package rather than
      // spending minutes wondering why the screen is blank.
      throw new Error(
        "OVMF UEFI firmware not found on this host (checked: " +
        OVMF_CODE_CANDIDATES.join(", ") +
        "). Install the 'ovmf' package (Debian/Ubuntu: sudo apt install ovmf) " +
        "and restart the FoulFox service. Without OVMF, Windows 11 cannot boot — " +
        "it shows 'No bootable device' because it requires UEFI and SeaBIOS cannot start it."
      );
    }

    // Slot 0: read-only EFI code.
    args.push("-drive", `if=pflash,format=raw,readonly=on,file=${ovmfCodePath}`);
    // Slot 1: writeable per-VM NVRAM. Fall back to the template (read-only)
    // if provisioning hasn't created the per-VM copy yet — the installer will
    // still boot; EFI vars just won't persist until the copy exists.
    const perVmVars = c.ovmfVarsPath && fs.existsSync(c.ovmfVarsPath) ? c.ovmfVarsPath : null;
    const fallbackVars = OVMF_VARS_CANDIDATES.find((p) => fs.existsSync(p));
    if (perVmVars) {
      args.push("-drive", `if=pflash,format=raw,file=${perVmVars}`);
    } else if (fallbackVars) {
      args.push("-drive", `if=pflash,format=raw,readonly=on,file=${fallbackVars}`);
    }

    args.push("-device", "ich9-ahci,id=ahci");
    let ahciPort = 0;
    if (c.diskPath) {
      args.push("-drive", `file=${c.diskPath},if=none,id=osdisk,format=qcow2`);
      args.push("-device", `ide-hd,drive=osdisk,bus=ahci.${ahciPort++},bootindex=1`);
    }
    if (c.isoPath) {
      args.push("-drive", `file=${c.isoPath},if=none,id=installcd,media=cdrom,readonly=on`);
      args.push("-device", `ide-cd,drive=installcd,bus=ahci.${ahciPort++},bootindex=0`);
    }
    if (c.virtioIsoPath) {
      args.push("-drive", `file=${c.virtioIsoPath},if=none,id=virtiocd,media=cdrom,readonly=on`);
      args.push("-device", `ide-cd,drive=virtiocd,bus=ahci.${ahciPort++}`);
    }
    if (c.unattendIsoPath) {
      args.push("-drive", `file=${c.unattendIsoPath},if=none,id=unattendcd,media=cdrom,readonly=on`);
      args.push("-device", `ide-cd,drive=unattendcd,bus=ahci.${ahciPort++}`);
    }
  } else {
    if (c.diskPath) {
      args.push("-drive", `file=${c.diskPath},if=virtio,format=qcow2`);
    }
    if (c.isoPath) {
      args.push("-cdrom", c.isoPath);
      if (!c.diskPath) args.push("-boot", "d");
    }
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
  if (isCloneSource(vm.id)) {
    return {
      ok: false,
      message: "This VM's disk is being cloned right now — wait for the clone to finish, then start it.",
      state: rt.state,
    };
  }

  const accel = selectAccelerator();
  const bin = qemuSystemBinary(vm.osKind);
  const args = buildQemuArgs(vm, accel);
  rt.state = "starting";
  rt.lastError = null;
  gpuArbiter("vm-starting", vm);

  try {
    rt.process = spawn(bin, args, { detached: false, stdio: "pipe" });
    const launchedAt = Date.now();

    // Keep the tail of QEMU's stderr so an instant exit (bad device, port in
    // use, RAM allocation failure…) surfaces an actionable reason in the UI
    // instead of a silent stopped→stopped cycle. Reading the pipe also prevents
    // a full pipe buffer from blocking QEMU.
    let stderrTail = "";

    // Persist QEMU's output to <vm dir>/qemu.log so the Session Portal's log
    // viewer can show why a VM failed even after the process is gone. Rotate
    // by truncation at ~5 MB (single-writer append; rotation loss is fine).
    const qemuLogPath = path.join(vmDiskDir(vm.id), "qemu.log");
    const LOG_CAP = 5 * 1024 * 1024;
    let logStream: fs.WriteStream | null = null;
    let logBytes = 0;
    const closeLog = (marker?: string) => {
      try {
        if (marker) logStream?.write(marker);
        logStream?.end();
      } catch { /* ignore */ }
      logStream = null;
    };
    try {
      fs.mkdirSync(vmDiskDir(vm.id), { recursive: true });
      try {
        logBytes = fs.statSync(qemuLogPath).size;
        if (logBytes > LOG_CAP) { fs.truncateSync(qemuLogPath, 0); logBytes = 0; }
      } catch { /* no existing log */ }
      logStream = fs.createWriteStream(qemuLogPath, { flags: "a" });
      logStream.on("error", () => { logStream = null; });
      logStream.write(`\n===== QEMU launch ${new Date().toISOString()} (vm=${vm.id}) =====\n`);
    } catch { /* logging is best-effort; never block a launch on it */ }
    const logWrite = (d: Buffer) => {
      if (!logStream) return;
      logBytes += d.length;
      if (logBytes > LOG_CAP) {
        // Rotate mid-run: truncate and reopen so a chatty guest can't fill the disk.
        closeLog();
        try {
          fs.truncateSync(qemuLogPath, 0);
          logBytes = 0;
          logStream = fs.createWriteStream(qemuLogPath, { flags: "a" });
          logStream.on("error", () => { logStream = null; });
          logStream.write(`===== log rotated (5MB cap) ${new Date().toISOString()} =====\n`);
        } catch { logStream = null; return; }
      }
      try { logStream?.write(d); } catch { /* ignore */ }
    };

    rt.process.stderr?.on("data", (d: Buffer) => {
      stderrTail = (stderrTail + d.toString()).slice(-4000);
      logWrite(d);
    });
    rt.process.stdout?.on("data", (d: Buffer) => {
      logWrite(d);
    });

    rt.process.on("error", (err: NodeJS.ErrnoException) => {
      logger.error({ err, vm: vm.id }, "QEMU process error");
      closeLog(`===== QEMU spawn error: ${err.message} =====\n`);
      rt.state = "error";
      rt.lastError = `Failed to run QEMU: ${err.message}`;
      rt.process = null;
      rt.startTime = null;
    });
    rt.process.on("exit", (code) => {
      const ranMs = Date.now() - launchedAt;
      closeLog(`===== QEMU exited code=${code} after ${Math.round(ranMs / 1000)}s =====\n`);
      logger.info({ code, ranMs, vm: vm.id }, "QEMU process exited");
      // A non-zero exit, or any exit within seconds of launch, is a failed
      // boot — mark it as an error with the stderr tail so the user sees why.
      // A deliberate stop (state "stopping") is never an error.
      if (rt.state !== "stopping" && (code !== 0 || ranMs < 10000)) {
        rt.state = "error";
        const detail = stderrTail.trim().split("\n").slice(-6).join("\n");
        rt.lastError =
          `QEMU exited ${code === 0 ? "immediately" : `with code ${code}`}` +
          (detail ? `: ${detail}` : " (no error output)");
        logger.error({ code, detail, vm: vm.id }, "VM failed to launch");
      } else {
        rt.state = "stopped";
      }
      rt.process = null;
      rt.startTime = null;
      // Resume Ollama only when QEMU has actually exited (not merely when a
      // stop was requested) and no other passthrough VM still owns the GPU.
      gpuArbiter("vm-stopped", vm);
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
    rt.lastError = `Failed to start VM: ${err instanceof Error ? err.message : String(err)}`;
    logger.error({ err, vm: vm.id }, "Failed to spawn QEMU");
    return {
      ok: false,
      message: `Failed to start VM: ${err instanceof Error ? err.message : String(err)}`,
      state: rt.state,
    };
  }
}

// ── GPU arbiter (appliance only, best-effort) ─────────────────────────────────
// When a VM owns the GPU via VFIO passthrough, the host Ollama must let go of
// VRAM first (and may resume once the VM exits). The appliance whitelists
// exactly these two commands in sudoers; anywhere else this silently no-ops.
export function gpuArbiter(action: "vm-starting" | "vm-stopped", vm: VmRecord): void {
  if (!vm.config.gpuPassthrough || process.platform !== "linux") return;
  if (!fs.existsSync("/etc/foulfox/foulfox.env")) return; // dev workspace: no-op
  if (action === "vm-stopped") {
    // Only resume Ollama when NO other GPU-passthrough VM is still running.
    const stillUsingGpu = listVms().some((other) => {
      if (other.id === vm.id || !other.config.gpuPassthrough) return false;
      const st = getRuntime(other.id).state;
      return st === "running" || st === "starting";
    });
    if (stillUsingGpu) return;
  }
  const verb = action === "vm-starting" ? "stop" : "start";
  try {
    if (action === "vm-starting") {
      // Synchronous: QEMU must not race Ollama for VRAM — wait (bounded) for
      // Ollama to actually release the GPU before the VM launches.
      execSync(`sudo -n systemctl ${verb} ollama`, { stdio: "ignore", timeout: 30000 });
    } else {
      const p = spawn("sudo", ["-n", "systemctl", verb, "ollama"], { stdio: "ignore", detached: true });
      p.on("error", () => { /* best-effort */ });
      p.unref();
    }
    logger.info({ vm: vm.id, verb }, "GPU arbiter: handing GPU between Ollama and VM");
  } catch { /* best-effort: sudoers rule only exists on the appliance */ }
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

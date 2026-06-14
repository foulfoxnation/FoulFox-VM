import fs from "fs";
import os from "os";
import { spawn } from "child_process";

// ── OS kinds & validation allowlists ─────────────────────────────────────────
export type OsKind = "linux" | "windows" | "macos";
export const OS_KINDS: OsKind[] = ["linux", "windows", "macos"];

export function isOsKind(v: unknown): v is OsKind {
  return typeof v === "string" && (OS_KINDS as string[]).includes(v);
}

// VM ids and names go into qemu argv, file paths and the registry. Restrict to a
// safe charset so they can never break out of an argument array or a path join.
const VM_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const VM_NAME_RE = /^[A-Za-z0-9 ._-]{1,64}$/;
const SNAPSHOT_NAME_RE = /^[A-Za-z0-9._-]{1,128}$/;

export function isValidVmId(v: unknown): v is string {
  return typeof v === "string" && VM_ID_RE.test(v);
}
export function isValidVmName(v: unknown): v is string {
  return typeof v === "string" && VM_NAME_RE.test(v);
}
export function isValidSnapshotName(v: unknown): v is string {
  return typeof v === "string" && SNAPSHOT_NAME_RE.test(v);
}

// ── Host capability detection ────────────────────────────────────────────────
// We auto-select the right accelerator for the host OS so the same code runs on
// Linux (KVM), Windows (WHPX/Hyper-V) and macOS (Apple's Hypervisor.framework),
// falling back to slow software emulation ("tcg") with a clear warning.

export type Accelerator = "kvm" | "whpx" | "hvf" | "tcg";

export interface AcceleratorInfo {
  accel: Accelerator;
  hardware: boolean; // true = real hardware virtualization, false = software emulation
  reason: string;
}

// Detect whether the current host is Apple hardware. macOS guests may only be
// offered on genuine Apple machines (licensing + Hypervisor.framework).
export function isAppleHost(): boolean {
  return process.platform === "darwin" && (process.arch === "arm64" || process.arch === "x64");
}

// Linux: /dev/kvm must exist AND be read/write accessible by this process.
function detectKvm(): { available: boolean; reason: string } {
  if (process.platform !== "linux") {
    return { available: false, reason: "not a Linux host" };
  }
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

// Choose the best accelerator available for the current host OS. Hardware
// acceleration is preferred; tcg is the honest, clearly-flagged fallback.
export function selectAccelerator(): AcceleratorInfo {
  if (process.platform === "linux") {
    const kvm = detectKvm();
    if (kvm.available) return { accel: "kvm", hardware: true, reason: kvm.reason };
    return { accel: "tcg", hardware: false, reason: `KVM unavailable (${kvm.reason}); using slow software emulation (tcg)` };
  }
  if (process.platform === "win32") {
    // WHPX is QEMU's Windows Hypervisor Platform accelerator (Hyper-V backed).
    // We can't probe it cheaply from Node, so we assume present and let QEMU fall
    // back; the qemu arg builder requests whpx and the caller surfaces failures.
    return { accel: "whpx", hardware: true, reason: "Windows host: using WHPX (Windows Hypervisor Platform). Ensure Hyper-V/WHP is enabled." };
  }
  if (process.platform === "darwin") {
    return { accel: "hvf", hardware: true, reason: "macOS host: using HVF (Apple Hypervisor.framework)." };
  }
  return { accel: "tcg", hardware: false, reason: `Unsupported host platform ${process.platform}; using slow software emulation (tcg)` };
}

// Whether a binary is on PATH. Spawns `<cmd> --version`; ENOENT/timeout => false.
export function binaryExists(cmd: string): Promise<boolean> {
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
    proc.on("error", () => finish(false));
    proc.on("close", () => finish(true));
  });
}

// The right qemu-system binary for a guest. We run x86_64 guests everywhere; on
// Apple Silicon hosts an aarch64 guest would use qemu-system-aarch64, but our
// provisioning targets x86_64 images for portability.
export function qemuSystemBinary(_os: OsKind): string {
  return "qemu-system-x86_64";
}

export interface HostCapabilities {
  platform: NodeJS.Platform;
  arch: string;
  accelerator: AcceleratorInfo;
  qemuSystem: boolean;
  qemuImg: boolean;
  appleHost: boolean;
  totalRamGb: number;
  cpuCount: number;
  // Which guest OSes this host can realistically run, with honest reasons.
  osSupport: Record<OsKind, { supported: boolean; reason: string }>;
}

export async function detectHostCapabilities(): Promise<HostCapabilities> {
  const accelerator = selectAccelerator();
  const [qemuSystem, qemuImg] = await Promise.all([
    binaryExists("qemu-system-x86_64"),
    binaryExists("qemu-img"),
  ]);
  const apple = isAppleHost();
  const totalRamGb = Math.max(1, Math.round(os.totalmem() / (1024 ** 3)));
  const cpuCount = os.cpus()?.length || 1;

  const baseReason = !qemuSystem
    ? "QEMU is not installed on this host."
    : !accelerator.hardware
    ? `No hardware virtualization — ${accelerator.reason}. VMs will be extremely slow.`
    : "Ready.";

  const osSupport: Record<OsKind, { supported: boolean; reason: string }> = {
    linux: {
      supported: qemuSystem,
      reason: qemuSystem ? baseReason : "QEMU is not installed.",
    },
    windows: {
      supported: qemuSystem,
      reason: qemuSystem ? baseReason : "QEMU is not installed.",
    },
    macos: {
      supported: apple && qemuSystem,
      reason: apple
        ? (qemuSystem ? baseReason : "QEMU is not installed.")
        : "macOS guests are only offered on genuine Apple hardware (licensing + Hypervisor.framework). This host is not Apple hardware.",
    },
  };

  return {
    platform: process.platform,
    arch: process.arch,
    accelerator,
    qemuSystem,
    qemuImg,
    appleHost: apple,
    totalRamGb,
    cpuCount,
    osSupport,
  };
}

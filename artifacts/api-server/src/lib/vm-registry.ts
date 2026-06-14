import fs from "fs";
import path from "path";
import crypto from "crypto";
import { type ChildProcess } from "child_process";
import { type OsKind } from "./vm-capabilities";
import { type VmPorts, allocatePorts, portValues } from "./vm-ports";
import { logger } from "./logger";
import { type DisplayMode } from "./vm-state";

export type VmState = "stopped" | "starting" | "running" | "stopping" | "error";
export type ConnectionMode = "serial" | "ssh";
export type ProvisioningStatus =
  | "none"          // nothing to do (manual disk/iso or already provisioned)
  | "downloading"   // fetching the OS image
  | "creating-disk" // qemu-img create
  | "installing"    // first boot / unattended install in progress
  | "ready"         // provisioned and bootable
  | "failed";

// Per-VM hardware/connection config. Mirrors the legacy single-VM config so the
// default VM migrates cleanly and the existing /vm/config endpoints keep working.
export interface VmConfigData {
  isoPath: string | null;
  diskPath: string | null;
  ramGb: number;
  cpuCores: number;
  gpuPassthrough: string | null;
  connectionMode: ConnectionMode;
  sshPort: number;        // mirror of ports.ssh, kept for legacy compatibility
  sshUser: string | null;
  sshPassword: string | null;
  // ── FoulFox OS appliance display + driver options ──────────────────────────
  virtioIsoPath: string | null;
  unattendIsoPath: string | null; // Windows autounattend.xml packaged as a CD
  displayMode: DisplayMode;
  spicePort: number;
  vncDisplay: number;
  usbPassthrough: string[];
}

export interface ProvisioningState {
  status: ProvisioningStatus;
  progress: number;       // 0..100
  message: string;
  error: string | null;
  imageUrl?: string | null;
}

// The persisted registry record. Runtime (process/state) is NOT persisted — it
// is reconstructed on boot via orphan reconciliation.
export interface VmRecord {
  id: string;
  name: string;
  osKind: OsKind;
  imageId?: string | null; // selected catalog image id (drives auto-download); null = bare osKind
  config: VmConfigData;
  ports: VmPorts;
  provisioning: ProvisioningState;
  displayToken: string;   // per-VM token gating the display WebSocket
  diskGb: number;         // requested disk size (guardrail accounting)
  createdAt: number;
}

// In-memory only runtime state, keyed by VM id.
export interface VmRuntimeState {
  process: ChildProcess | null;
  state: VmState;
  startTime: number | null;
}

interface RegistryFile {
  version: 1;
  vms: VmRecord[];
}

const HOME = process.env.HOME || "/tmp";

// Where all mutable VM state lives (registry, disks, downloaded image cache).
//
// IMPORTANT for the bootable-OS deployment: when FoulFox boots from a flashed USB
// stick, the root filesystem is typically a read-only squashfs with a RAM-backed
// (tmpfs) overlay. Writing multi-GB OS images and qcow2 disks under $HOME would
// exhaust RAM and be lost on reboot. The OS init must therefore point this at a
// PERSISTENT writable partition via ODYSSEUS_DATA_DIR. In the Electron/desktop and
// dev builds it falls back to $HOME, which is already persistent there.
const DATA_DIR = process.env["ODYSSEUS_DATA_DIR"] || HOME;

const REGISTRY_PATH = path.join(DATA_DIR, ".odysseus-vm-registry.json");
const LOCK_PATH = REGISTRY_PATH + ".lock";
// Legacy single-VM config lived in $HOME — read from there for one-time migration
// regardless of where the new persistent data dir points.
const LEGACY_CONFIG_PATH = path.join(HOME, ".odysseus-vm-config.json");
// Managed disk + image-cache location for auto-provisioned VMs.
export const VM_DATA_DIR = path.join(DATA_DIR, ".odysseus-vms");

export const DEFAULT_VM_ID = "default";

// IMPORTANT: legacy default port preserved so existing setups keep working.
const LEGACY_SSH_PORT = 5985;

function defaultConfig(): VmConfigData {
  return {
    isoPath: null,
    diskPath: null,
    ramGb: 8,
    cpuCores: 4,
    gpuPassthrough: null,
    connectionMode: "ssh",
    sshPort: LEGACY_SSH_PORT,
    sshUser: null,
    sshPassword: null,
    virtioIsoPath: null,
    unattendIsoPath: null,
    displayMode: "headless",
    spicePort: 5930,
    vncDisplay: 1,
    usbPassthrough: [],
  };
}

function defaultProvisioning(): ProvisioningState {
  return { status: "none", progress: 0, message: "", error: null, imageUrl: null };
}

// ── Simple cross-instance file lock (best effort, single-process safe) ────────
// Prevents two concurrent registry mutations from racing (e.g. two "+" clicks
// allocating overlapping ports). We retry briefly then steal a stale lock.
function withLock<T>(fn: () => T): T {
  const deadline = Date.now() + 3000;
  let held = false;
  while (Date.now() < deadline) {
    try {
      const fd = fs.openSync(LOCK_PATH, "wx");
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      held = true;
      break;
    } catch {
      // Steal a stale lock (>10s old) — a crashed writer should not deadlock us.
      try {
        const stat = fs.statSync(LOCK_PATH);
        if (Date.now() - stat.mtimeMs > 10000) {
          fs.rmSync(LOCK_PATH, { force: true });
          continue;
        }
      } catch { /* ignore */ }
      // brief spin
      const until = Date.now() + 25;
      while (Date.now() < until) { /* busy wait */ }
    }
  }
  try {
    return fn();
  } finally {
    if (held) {
      try { fs.rmSync(LOCK_PATH, { force: true }); } catch { /* ignore */ }
    }
  }
}

function readRegistryFile(): RegistryFile {
  try {
    if (fs.existsSync(REGISTRY_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf-8"));
      if (parsed && Array.isArray(parsed.vms)) return parsed as RegistryFile;
    }
  } catch (err) {
    logger.error({ err }, "Failed to read VM registry; starting empty");
  }
  return { version: 1, vms: [] };
}

function writeRegistryFile(data: RegistryFile): void {
  fs.mkdirSync(path.dirname(REGISTRY_PATH), { recursive: true });
  const tmp = REGISTRY_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, REGISTRY_PATH);
}

// ── Runtime map (in-memory) ──────────────────────────────────────────────────
const runtimes = new Map<string, VmRuntimeState>();

export function getRuntime(id: string): VmRuntimeState {
  let r = runtimes.get(id);
  if (!r) {
    r = { process: null, state: "stopped", startTime: null };
    runtimes.set(id, r);
  }
  return r;
}

// ── Public registry API ──────────────────────────────────────────────────────

export function listVms(): VmRecord[] {
  return readRegistryFile().vms;
}

export function getVm(id: string): VmRecord | undefined {
  return readRegistryFile().vms.find((v) => v.id === id);
}

export function getVmConfig(id: string): VmConfigData | undefined {
  return getVm(id)?.config;
}

// Update one VM record via a mutator under the registry lock.
export function updateVm(id: string, mutate: (vm: VmRecord) => void): VmRecord | undefined {
  return withLock(() => {
    const file = readRegistryFile();
    const vm = file.vms.find((v) => v.id === id);
    if (!vm) return undefined;
    mutate(vm);
    // keep legacy mirror in sync for the default VM
    vm.config.sshPort = vm.ports.ssh;
    writeRegistryFile(file);
    return vm;
  });
}

export function updateVmConfig(id: string, patch: Partial<VmConfigData>): VmRecord | undefined {
  return updateVm(id, (vm) => {
    vm.config = { ...vm.config, ...patch };
  });
}

export function setProvisioning(id: string, patch: Partial<ProvisioningState>): void {
  updateVm(id, (vm) => {
    vm.provisioning = { ...vm.provisioning, ...patch };
  });
}

function allClaimedPorts(file: RegistryFile): number[] {
  return file.vms.flatMap((v) => portValues(v.ports));
}

// Create a new VM record with freshly allocated, collision-free ports.
export async function createVm(opts: {
  name: string;
  osKind: OsKind;
  imageId?: string | null;
  ramGb?: number;
  cpuCores?: number;
  diskGb?: number;
  config?: Partial<VmConfigData>;
}): Promise<VmRecord> {
  const file = readRegistryFile();
  const ports = await allocatePorts(allClaimedPorts(file));
  const id = makeVmId(opts.name, file.vms.map((v) => v.id));
  const cfg = { ...defaultConfig(), ...opts.config };
  if (opts.ramGb) cfg.ramGb = opts.ramGb;
  if (opts.cpuCores) cfg.cpuCores = opts.cpuCores;
  cfg.sshPort = ports.ssh;

  const record: VmRecord = {
    id,
    name: opts.name,
    osKind: opts.osKind,
    imageId: opts.imageId ?? null,
    config: cfg,
    ports,
    provisioning: defaultProvisioning(),
    displayToken: crypto.randomBytes(24).toString("hex"),
    diskGb: opts.diskGb ?? 64,
    createdAt: Date.now(),
  };

  withLock(() => {
    const f = readRegistryFile();
    f.vms.push(record);
    writeRegistryFile(f);
  });
  getRuntime(id); // initialize runtime slot
  return record;
}

export function deleteVm(id: string): boolean {
  if (id === DEFAULT_VM_ID) return false; // never delete the default VM
  return withLock(() => {
    const file = readRegistryFile();
    const before = file.vms.length;
    file.vms = file.vms.filter((v) => v.id !== id);
    writeRegistryFile(file);
    runtimes.delete(id);
    return file.vms.length < before;
  });
}

// Build a stable, validated slug id from a display name, avoiding collisions.
function makeVmId(name: string, existing: string[]): string {
  let base = name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  if (!base) base = "vm";
  if (!/^[a-z0-9]/.test(base)) base = "v" + base;
  let id = base;
  let n = 1;
  while (existing.includes(id)) id = `${base}-${++n}`;
  return id;
}

// ── Migration & bootstrap ─────────────────────────────────────────────────────
// On first load, ensure a "default" VM exists. If the legacy single-VM config
// file is present, migrate it; otherwise create a blank default. Ports are
// allocated but the default VM keeps the legacy ssh port (5985) for continuity.
export async function ensureDefaultVm(): Promise<void> {
  const file = readRegistryFile();
  if (file.vms.some((v) => v.id === DEFAULT_VM_ID)) return;

  let legacy: Partial<VmConfigData> = {};
  try {
    if (fs.existsSync(LEGACY_CONFIG_PATH)) {
      legacy = JSON.parse(fs.readFileSync(LEGACY_CONFIG_PATH, "utf-8"));
      logger.info("Migrating legacy single-VM config into the registry as 'default'");
    }
  } catch (err) {
    logger.error({ err }, "Failed to read legacy VM config during migration");
  }

  const ports = await allocatePorts(allClaimedPorts(file));
  ports.ssh = (typeof legacy.sshPort === "number" && legacy.sshPort > 0) ? legacy.sshPort : LEGACY_SSH_PORT;

  const cfg: VmConfigData = { ...defaultConfig(), ...legacy, sshPort: ports.ssh };
  const record: VmRecord = {
    id: DEFAULT_VM_ID,
    name: "Default VM",
    osKind: "windows", // the original tool targeted Windows
    config: cfg,
    ports,
    provisioning: { ...defaultProvisioning(), status: cfg.diskPath || cfg.isoPath ? "ready" : "none" },
    displayToken: crypto.randomBytes(24).toString("hex"),
    diskGb: 64,
    createdAt: Date.now(),
  };

  withLock(() => {
    const f = readRegistryFile();
    if (f.vms.some((v) => v.id === DEFAULT_VM_ID)) return;
    f.vms.unshift(record);
    writeRegistryFile(f);
  });
  getRuntime(DEFAULT_VM_ID);
}

export function vmDiskDir(id: string): string {
  return path.join(VM_DATA_DIR, id);
}

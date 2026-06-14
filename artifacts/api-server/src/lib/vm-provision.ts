import fs from "fs";
import path from "path";
import https from "https";
import http from "http";
import crypto from "crypto";
import { spawn } from "child_process";
import { EventEmitter } from "events";
import {
  getVm,
  setProvisioning,
  updateVmConfig,
  vmDiskDir,
  VM_DATA_DIR,
  type ProvisioningState,
} from "./vm-registry";
import { type OsKind, binaryExists } from "./vm-capabilities";
import { logger } from "./logger";

// ── Progress pub/sub ───────────────────────────────────────────────────────────
const bus = new EventEmitter();
bus.setMaxListeners(0);

export function subscribeProvisioning(vmId: string, cb: (s: ProvisioningState) => void): () => void {
  const handler = (state: ProvisioningState) => cb(state);
  bus.on(vmId, handler);
  return () => bus.off(vmId, handler);
}

function emit(vmId: string, patch: Partial<ProvisioningState>) {
  setProvisioning(vmId, patch);
  const vm = getVm(vmId);
  if (vm) bus.emit(vmId, vm.provisioning);
}

// ── OS image catalog ────────────────────────────────────────────────────────────
// Real, redistributable cloud image for Linux (hands-off). Windows/macOS ISOs are
// not freely redistributable, so those paths are user-ISO-driven and gated.
interface ImageSpec {
  url: string;
  filename: string;
  sha256?: string; // optional integrity check; verified when present
  kind: "qcow2-disk" | "iso";
}

const CATALOG: Partial<Record<OsKind, ImageSpec>> = {
  linux: {
    // Ubuntu 24.04 LTS cloud image (qcow2). Used directly as the boot disk.
    url: "https://cloud-images.ubuntu.com/releases/noble/release/ubuntu-24.04-server-cloudimg-amd64.img",
    filename: "ubuntu-24.04-server-cloudimg-amd64.img",
    kind: "qcow2-disk",
  },
};

const CACHE_DIR = path.join(VM_DATA_DIR, "_image-cache");

// ── Public entry point ───────────────────────────────────────────────────────────
export async function startProvisioning(vmId: string): Promise<void> {
  const vm = getVm(vmId);
  if (!vm) return;

  // Already has explicit media (manual disk/iso) — nothing to auto-provision.
  if (vm.config.diskPath && vm.provisioning.status === "ready") return;

  try {
    fs.mkdirSync(vmDiskDir(vmId), { recursive: true });
    fs.mkdirSync(CACHE_DIR, { recursive: true });

    if (vm.osKind === "linux") {
      await provisionLinux(vmId);
    } else if (vm.osKind === "windows") {
      await provisionWindows(vmId);
    } else if (vm.osKind === "macos") {
      await provisionMacOs(vmId);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, vm: vmId }, "Provisioning failed");
    emit(vmId, { status: "failed", error: msg, message: `Provisioning failed: ${msg}` });
  }
}

// ── Linux: cloud image + cloud-init first-boot config (hands-off) ─────────────────
async function provisionLinux(vmId: string): Promise<void> {
  const spec = CATALOG.linux!;
  const cached = path.join(CACHE_DIR, spec.filename);

  emit(vmId, { status: "downloading", progress: 0, error: null, message: "Downloading Ubuntu cloud image…", imageUrl: spec.url });
  if (!fs.existsSync(cached)) {
    await download(spec.url, cached, (pct) => emit(vmId, { status: "downloading", progress: pct, message: `Downloading Ubuntu cloud image… ${pct}%` }));
    if (spec.sha256) await verifySha256(cached, spec.sha256);
  } else {
    emit(vmId, { progress: 100, message: "Using cached Ubuntu cloud image." });
  }

  // Create a copy-on-write overlay disk backed by the cached image so multiple
  // VMs can share the immutable base without re-downloading.
  emit(vmId, { status: "creating-disk", progress: 0, message: "Creating VM disk…" });
  const diskPath = path.join(vmDiskDir(vmId), "disk.qcow2");
  const vm = getVm(vmId)!;
  // Standalone disk: copy the base then resize to requested size.
  await runQemuImg(["create", "-f", "qcow2", "-F", "qcow2", "-b", path.resolve(cached), diskPath, `${vm.diskGb}G`]);

  // Generate a cloud-init seed ISO that enables SSH for the agent on first boot.
  emit(vmId, { status: "installing", progress: 50, message: "Generating first-boot (cloud-init) configuration…" });
  const password = crypto.randomBytes(12).toString("base64url");
  const seedIso = await buildCloudInitSeed(vmId, password).catch((err) => {
    logger.warn({ err, vm: vmId }, "cloud-init seed generation skipped");
    return null;
  });

  updateVmConfig(vmId, {
    diskPath,
    isoPath: seedIso, // attached as a second CD so cloud-init applies it
    connectionMode: "ssh",
    sshUser: "foulfox",
    sshPassword: password,
  });

  if (seedIso) {
    emit(vmId, { status: "ready", progress: 100, error: null, message: "Linux VM ready. SSH is enabled on first boot for the agent." });
  } else {
    emit(vmId, { status: "ready", progress: 100, error: null, message: "Linux disk ready. Install cloud-utils/genisoimage on the host to auto-enable SSH; otherwise configure SSH manually." });
  }
}

// Build a NoCloud seed ISO (user-data + meta-data). Requires cloud-localds OR
// genisoimage/mkisofs. Returns the iso path, or throws if no tool is available.
async function buildCloudInitSeed(vmId: string, password: string): Promise<string> {
  const dir = vmDiskDir(vmId);
  const metaData = `instance-id: ${vmId}\nlocal-hostname: ${vmId}\n`;
  const userData = [
    "#cloud-config",
    "users:",
    "  - name: foulfox",
    "    sudo: ALL=(ALL) NOPASSWD:ALL",
    "    groups: sudo",
    "    shell: /bin/bash",
    "    lock_passwd: false",
    `    plain_text_passwd: ${password}`,
    "ssh_pwauth: true",
    "package_update: true",
    "packages:",
    "  - openssh-server",
    "runcmd:",
    "  - systemctl enable --now ssh",
    "",
  ].join("\n");

  const metaPath = path.join(dir, "meta-data");
  const userPath = path.join(dir, "user-data");
  fs.writeFileSync(metaPath, metaData);
  fs.writeFileSync(userPath, userData);
  const isoPath = path.join(dir, "seed.iso");

  if (await binaryExists("cloud-localds")) {
    await runTool("cloud-localds", [isoPath, userPath, metaPath]);
    return isoPath;
  }
  for (const tool of ["genisoimage", "mkisofs", "xorriso"]) {
    if (await binaryExists(tool)) {
      const args = tool === "xorriso"
        ? ["-as", "mkisofs", "-output", isoPath, "-volid", "cidata", "-joliet", "-rock", userPath, metaPath]
        : ["-output", isoPath, "-volid", "cidata", "-joliet", "-rock", userPath, metaPath];
      await runTool(tool, args);
      return isoPath;
    }
  }
  throw new Error("no ISO authoring tool (cloud-localds/genisoimage/mkisofs/xorriso) available");
}

// ── Windows: blank disk + unattend (ISO must be supplied by the user) ─────────────
async function provisionWindows(vmId: string): Promise<void> {
  const vm = getVm(vmId)!;
  emit(vmId, { status: "creating-disk", progress: 0, message: "Creating Windows VM disk…" });
  const diskPath = path.join(vmDiskDir(vmId), "disk.qcow2");
  if (!fs.existsSync(diskPath)) {
    await runQemuImg(["create", "-f", "qcow2", diskPath, `${vm.diskGb}G`]);
  }

  // Generate an unattended answer file that auto-enables SSH and RDP.
  emit(vmId, { status: "installing", progress: 40, message: "Generating unattended answer file (auto-SSH + RDP)…" });
  const answerPath = path.join(vmDiskDir(vmId), "autounattend.xml");
  fs.writeFileSync(answerPath, buildAutoUnattend());

  updateVmConfig(vmId, { diskPath, connectionMode: "ssh" });

  if (vm.config.isoPath && fs.existsSync(vm.config.isoPath)) {
    emit(vmId, { status: "ready", progress: 100, error: null, message: "Windows disk + unattend ready. Boot from the supplied ISO to run the unattended install (virtio drivers + SSH/RDP)." });
  } else {
    emit(vmId, {
      status: "ready",
      progress: 100,
      error: null,
      message: "Windows disk + unattended answer file generated. Windows ISOs are not freely redistributable — set the Windows ISO path in this VM's settings, then start the VM to run the hands-off install.",
    });
  }
}

// ── macOS: gated to Apple hardware only, honest refusal otherwise ──────────────────
async function provisionMacOs(vmId: string): Promise<void> {
  const isApple = process.platform === "darwin";
  if (!isApple) {
    emit(vmId, {
      status: "failed",
      progress: 0,
      error: "non-apple-host",
      message: "macOS guests are only available on genuine Apple hardware (Apple's software licence + Hypervisor.framework). This host is not Apple hardware, so macOS cannot be provisioned here.",
    });
    return;
  }
  emit(vmId, {
    status: "ready",
    progress: 100,
    error: null,
    message: "Apple host detected. Provide a macOS installer/recovery image in this VM's settings to complete setup (fully unattended macOS install is out of scope).",
  });
}

// ── Download with progress + integrity ────────────────────────────────────────────
function download(url: string, dest: string, onProgress: (pct: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const tmp = dest + ".part";
    const client = url.startsWith("https") ? https : http;
    const file = fs.createWriteStream(tmp);
    const req = client.get(url, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        fs.rmSync(tmp, { force: true });
        download(res.headers.location, dest, onProgress).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.rmSync(tmp, { force: true });
        reject(new Error(`download failed: HTTP ${res.statusCode}`));
        return;
      }
      const total = Number(res.headers["content-length"] || 0);
      let received = 0;
      let lastPct = -1;
      res.on("data", (chunk: Buffer) => {
        received += chunk.length;
        if (total > 0) {
          const pct = Math.min(99, Math.floor((received / total) * 100));
          if (pct !== lastPct) { lastPct = pct; onProgress(pct); }
        }
      });
      res.pipe(file);
      file.on("finish", () => file.close(() => {
        fs.renameSync(tmp, dest);
        onProgress(100);
        resolve();
      }));
    });
    req.on("error", (err) => { file.close(); fs.rmSync(tmp, { force: true }); reject(err); });
  });
}

function verifySha256(file: string, expected: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(file);
    stream.on("data", (d) => hash.update(d));
    stream.on("end", () => {
      const actual = hash.digest("hex");
      if (actual.toLowerCase() === expected.toLowerCase()) resolve();
      else reject(new Error(`checksum mismatch (expected ${expected}, got ${actual})`));
    });
    stream.on("error", reject);
  });
}

function runQemuImg(args: string[]): Promise<void> {
  return runTool("qemu-img", args);
}

function runTool(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    } catch (err) {
      reject(err);
      return;
    }
    let stderr = "";
    proc.stderr?.on("data", (d) => { stderr += d.toString(); });
    proc.on("error", (err: NodeJS.ErrnoException) => {
      reject(err.code === "ENOENT" ? new Error(`${cmd} is not installed`) : err);
    });
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `${cmd} exited ${code}`));
    });
  });
}

// Minimal Windows autounattend.xml that enables OpenSSH Server and RDP after
// install so the agent can connect. (Edition/key/partition specifics vary by ISO
// and are intentionally left to the supplied media's defaults.)
function buildAutoUnattend(): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<unattend xmlns="urn:schemas-microsoft-com:unattend">
  <settings pass="oobeSystem">
    <component name="Microsoft-Windows-Shell-Setup" processorArchitecture="amd64"
               publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">
      <OOBE>
        <HideEULAPage>true</HideEULAPage>
        <ProtectYourPC>3</ProtectYourPC>
        <NetworkLocation>Home</NetworkLocation>
      </OOBE>
      <FirstLogonCommands>
        <SynchronousCommand wcm:action="add" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State">
          <Order>1</Order>
          <CommandLine>powershell -NoProfile -Command "Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0; Set-Service sshd -StartupType Automatic; Start-Service sshd"</CommandLine>
        </SynchronousCommand>
        <SynchronousCommand wcm:action="add" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State">
          <Order>2</Order>
          <CommandLine>reg add "HKLM\\System\\CurrentControlSet\\Control\\Terminal Server" /v fDenyTSConnections /t REG_DWORD /d 0 /f</CommandLine>
        </SynchronousCommand>
        <SynchronousCommand wcm:action="add" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State">
          <Order>3</Order>
          <CommandLine>netsh advfirewall firewall set rule group="remote desktop" new enable=Yes</CommandLine>
        </SynchronousCommand>
      </FirstLogonCommands>
    </component>
  </settings>
</unattend>
`;
}

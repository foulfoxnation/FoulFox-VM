import fs from "fs";
import path from "path";
import https from "https";
import http from "http";
import crypto from "crypto";
import { spawn } from "child_process";
import { EventEmitter } from "events";
import {
  getVm,
  getRuntime,
  setProvisioning,
  updateVmConfig,
  vmDiskDir,
  VM_DATA_DIR,
  markCloneSource,
  unmarkCloneSource,
  type ProvisioningState,
} from "./vm-registry";
import { binaryExists } from "./vm-capabilities";
import { getOsImage, defaultImageForOs } from "./os-catalog";
import { resolveWindowsIso } from "./os-images/windows-msdl";
import { netQuietRemaining } from "./net-quiet";
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
// The selectable OS images live in os-catalog.ts (single source of truth shared
// with the UI). Linux images are ready-to-boot cloud qcow2s; Windows ISOs are
// resolved live from Microsoft at download time. Nothing here is user-supplied.

// Stable virtio-win driver ISO (storage/network drivers for Windows guests).
const VIRTIO_WIN_URL =
  "https://fedorapeople.org/groups/virt/virtio-win/direct-downloads/stable-virtio/virtio-win.iso";

const CACHE_DIR = path.join(VM_DATA_DIR, "_image-cache");

// Hold VM image downloads until the post-boot internet quiet window has passed
// (WiFi is usually still settling in the first minutes on real hardware, and a
// half-up network turns a multi-GB download into a misleading instant failure).
// Cached/frontloaded media never waits — only actual network fetches do. The
// countdown is surfaced through the VM's provisioning banner so the user sees
// WHY nothing is downloading yet. Dev workspaces are never quiet.
async function waitForNetQuiet(vmId: string, what: string, signal?: AbortSignal): Promise<void> {
  let remaining = netQuietRemaining();
  while (remaining > 0) {
    if (signal?.aborted) throw new CancelledError();
    emit(vmId, {
      status: "downloading",
      progress: 0,
      error: null,
      message: `Waiting for the network to settle after boot — ${what} starts in ~${remaining}s. Connect to WiFi now if you haven't.`,
    });
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, Math.min(remaining, 10) * 1000);
      signal?.addEventListener("abort", () => { clearTimeout(t); reject(new CancelledError()); }, { once: true });
    });
    remaining = netQuietRemaining();
  }
}

// ── Public entry point ───────────────────────────────────────────────────────────
// Per-VM in-flight lock: /vm/create, /vm/:id/provision and the start-route
// self-heal can all request provisioning; concurrent passes for the same VM
// would race on the shared disk/unattend/config artifacts. Callers awaiting a
// duplicate request simply join the in-flight pass.
const inFlight = new Map<string, Promise<void>>();
// Per-VM AbortControllers so cancelProvisioning() can kill an active download.
const inFlightAbort = new Map<string, AbortController>();

// Sentinel error thrown when a download is intentionally cancelled.
class CancelledError extends Error {
  constructor() { super("download cancelled by user"); this.name = "CancelledError"; }
}

export async function startProvisioning(vmId: string): Promise<void> {
  const existing = inFlight.get(vmId);
  if (existing) return existing;
  const run = doStartProvisioning(vmId).finally(() => {
    inFlight.delete(vmId);
    inFlightAbort.delete(vmId);
  });
  inFlight.set(vmId, run);
  return run;
}

// Cancel an active provisioning pass (e.g. a stuck download). Aborts the
// in-flight HTTP request, cleans up the partial file, and resets provisioning
// state to "none" so the Start button re-enables immediately.
export function cancelProvisioning(vmId: string): void {
  const ctrl = inFlightAbort.get(vmId);
  if (ctrl) {
    ctrl.abort();
  }
  // Remove any stale .part files in the cache dir so a retry starts fresh.
  try {
    const entries = fs.readdirSync(CACHE_DIR);
    for (const f of entries) {
      if (f.endsWith(".part")) fs.rmSync(path.join(CACHE_DIR, f), { force: true });
    }
  } catch { /* cache dir may not exist yet */ }
  emit(vmId, { status: "none", progress: 0, error: null, message: "" });
}

async function doStartProvisioning(vmId: string): Promise<void> {
  const vm = getVm(vmId);
  if (!vm) return;

  // Create a fresh abort controller for this provisioning pass so
  // cancelProvisioning() can kill the in-flight download at any point.
  const ctrl = new AbortController();
  inFlightAbort.set(vmId, ctrl);

  // Already has explicit media (manual disk/iso) and marked ready — usually
  // nothing to auto-provision. EXCEPTION: a Windows guest still needs its
  // unattended answer-file CD (the Win11 hardware-check bypass + auto SSH/RDP
  // live there). On the flashed appliance the default VM is loaded straight from
  // config with status "ready" but no unattend ISO, so fall through and build it.
  if (vm.config.diskPath && vm.provisioning.status === "ready") {
    const hasUnattend = !!vm.config.unattendIsoPath && fs.existsSync(vm.config.unattendIsoPath);
    const needsUnattend = vm.osKind === "windows" && !hasUnattend;
    if (!needsUnattend) return;
  }

  try {
    fs.mkdirSync(vmDiskDir(vmId), { recursive: true });
    fs.mkdirSync(CACHE_DIR, { recursive: true });

    const { signal } = ctrl;
    if (vm.osKind === "linux") {
      await provisionLinux(vmId, signal);
    } else if (vm.osKind === "windows") {
      await provisionWindows(vmId, signal);
    } else if (vm.osKind === "macos") {
      await provisionMacOs(vmId);
    }
  } catch (err) {
    if (err instanceof CancelledError) {
      // User cancelled — state was already reset to "none" by cancelProvisioning();
      // don't overwrite it with "failed" so the Start button stays enabled.
      logger.info({ vm: vmId }, "Provisioning cancelled by user");
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, vm: vmId }, "Provisioning failed");
    emit(vmId, { status: "failed", error: msg, message: `Provisioning failed: ${msg}` });
  }
}

// ── Linux: cloud image + cloud-init first-boot config (hands-off) ─────────────────
async function provisionLinux(vmId: string, signal?: AbortSignal): Promise<void> {
  const spec = getOsImage(getVm(vmId)?.imageId) ?? defaultImageForOs("linux");
  if (!spec || spec.resolver !== "cloud-image" || !spec.imageUrl || !spec.imageFilename) {
    throw new Error("No cloud image is configured for this Linux selection.");
  }
  const cached = path.join(CACHE_DIR, spec.imageFilename);

  emit(vmId, { status: "downloading", progress: 0, error: null, message: `Downloading ${spec.label} cloud image…`, imageUrl: spec.imageUrl });
  if (!fs.existsSync(cached)) {
    await waitForNetQuiet(vmId, `the ${spec.label} download`, signal);
    await download(spec.imageUrl, cached, (pct) => emit(vmId, { status: "downloading", progress: pct, message: `Downloading ${spec.label} cloud image… ${pct}%` }), signal);
  } else {
    emit(vmId, { progress: 100, message: `Using cached ${spec.label} cloud image.` });
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
  // Dedicated agent keypair: the public key is injected via cloud-init so the
  // agent logs in with the key (no password typing); the password remains as an
  // interactive-terminal fallback only.
  const agentKey = await ensureVmSshKey(vmId);
  const seedIso = await buildCloudInitSeed(vmId, password, agentKey?.pubKey ?? null).catch((err) => {
    logger.warn({ err, vm: vmId }, "cloud-init seed generation skipped");
    return null;
  });

  updateVmConfig(vmId, {
    diskPath,
    isoPath: seedIso, // attached as a second CD so cloud-init applies it
    connectionMode: "ssh",
    sshUser: "foulfox",
    sshPassword: password,
    sshKeyPath: agentKey?.keyPath ?? null,
  });

  if (seedIso) {
    emit(vmId, { status: "ready", progress: 100, error: null, message: agentKey ? "Linux VM ready. Key-based SSH is enabled on first boot for the agent." : "Linux VM ready. SSH is enabled on first boot for the agent." });
  } else {
    emit(vmId, { status: "ready", progress: 100, error: null, message: "Linux disk ready. Install cloud-utils/genisoimage on the host to auto-enable SSH; otherwise configure SSH manually." });
  }
}

// Build a NoCloud seed ISO (user-data + meta-data). Requires cloud-localds OR
// genisoimage/mkisofs. Returns the iso path, or throws if no tool is available.
async function buildCloudInitSeed(vmId: string, password: string, pubKey: string | null): Promise<string> {
  const dir = vmDiskDir(vmId);
  const metaData = `instance-id: ${vmId}\nlocal-hostname: ${vmId}\n`;
  const userLines = [
    "#cloud-config",
    "users:",
    "  - name: foulfox",
    "    sudo: ALL=(ALL) NOPASSWD:ALL",
    "    groups: sudo",
    "    shell: /bin/bash",
    "    lock_passwd: false",
    `    plain_text_passwd: ${password}`,
  ];
  if (pubKey) {
    // Authorize the agent's per-VM public key so non-interactive login needs no
    // password. cloud-init writes this into /home/foulfox/.ssh/authorized_keys.
    userLines.push("    ssh_authorized_keys:");
    userLines.push(`      - ${pubKey}`);
  }
  userLines.push(
    "ssh_pwauth: true",
    "package_update: true",
    "packages:",
    "  - openssh-server",
    "runcmd:",
    "  - systemctl enable --now ssh",
    "",
  );
  const userData = userLines.join("\n");

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

// ── Windows: auto-download the official ISO + virtio drivers (hands-off) ───────────
async function provisionWindows(vmId: string, signal?: AbortSignal): Promise<void> {
  const vm = getVm(vmId)!;
  const spec = getOsImage(vm.imageId);
  const label = spec?.label ?? "Windows";

  // 1. Honor a user-supplied ISO (USB frontload / VM settings) if present.
  let isoPath = vm.config.isoPath && fs.existsSync(vm.config.isoPath) ? vm.config.isoPath : null;

  // 1b. Auto-scan the frontload/isos staging directory for any .iso file —
  //     the user may have downloaded one via Firefox or copied it from a USB
  //     drive without explicitly setting it in VM settings. Prefer files whose
  //     name contains "win" or "windows". Persist the found path to VM config
  //     so future starts use it without re-scanning.
  if (!isoPath) {
    const frontloadRoot = process.env["FRONTLOAD_STAGING_DIR"]
      ? path.join(process.env["FRONTLOAD_STAGING_DIR"], "isos")
      : path.join(DATA_DIR, ".odysseus-vms", "frontload", "isos");
    try {
      if (fs.existsSync(frontloadRoot)) {
        const candidates = fs.readdirSync(frontloadRoot)
          .filter((f) => f.toLowerCase().endsWith(".iso"))
          .map((f) => path.join(frontloadRoot, f));
        // Prefer ISOs whose filename contains "win"/"windows", else take the first.
        const found =
          candidates.find((f) => /win/i.test(path.basename(f))) ??
          candidates[0] ??
          null;
        if (found) {
          isoPath = found;
          updateVmConfig(vmId, { isoPath: found });
          emit(vmId, {
            status: "downloading",
            progress: 100,
            error: null,
            message: `Using frontloaded ISO: ${path.basename(found)}`,
          });
          logger.info({ vm: vmId, iso: found }, "Using frontloaded Windows ISO");
        }
      }
    } catch (err) {
      logger.warn({ err, vm: vmId }, "Frontload ISO scan failed (continuing)");
    }
  }

  // 2. Otherwise resolve + download the official ISO straight from Microsoft so
  //    the user never needs a second machine. This endpoint is a moving target
  //    and Microsoft blocks some networks, so failure is expected and falls back
  //    to the frontload path rather than bricking the VM.
  if (!isoPath && spec?.resolver === "windows-msdl" && spec.productEditionId && spec.isoFilename) {
    const cachedIso = path.join(CACHE_DIR, spec.isoFilename);
    if (fs.existsSync(cachedIso)) {
      isoPath = cachedIso;
      emit(vmId, { status: "downloading", progress: 100, error: null, message: `Using cached ${label} ISO.` });
    } else {
      try {
        await waitForNetQuiet(vmId, `the ${label} download`, signal);
        emit(vmId, { status: "downloading", progress: 0, error: null, message: `Locating the latest ${label} ISO from Microsoft…`, imageUrl: null });
        const url = await resolveWindowsIso(spec.productEditionId);
        await download(url, cachedIso, (pct) => emit(vmId, { status: "downloading", progress: pct, message: `Downloading ${label} from Microsoft… ${pct}%` }), signal);
        isoPath = cachedIso;
      } catch (err) {
        if (err instanceof CancelledError) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({ err, vm: vmId }, "Windows auto-download failed; continuing without installer ISO");
        // Don't surface a hard failure: the disk and unattend CD are still built
        // below so the user can add a Windows ISO later without re-provisioning.
        // A "failed" toast here would alarm the user before they've even had a
        // chance to frontload an ISO, so we fall through and emit "ready" with
        // a clear action message instead.
      }
    }
  }

  // 3. Best-effort: fetch the stable virtio-win drivers so storage/network work
  //    in the guest. A failure here is non-fatal — Windows can still install.
  let virtioPath: string | null = vm.config.virtioIsoPath && fs.existsSync(vm.config.virtioIsoPath) ? vm.config.virtioIsoPath : null;
  if (!virtioPath) {
    const virtioCached = path.join(CACHE_DIR, "virtio-win.iso");
    if (fs.existsSync(virtioCached)) {
      virtioPath = virtioCached;
    } else {
      try {
        await waitForNetQuiet(vmId, "the virtio drivers download", signal);
        emit(vmId, { status: "downloading", progress: 0, message: "Downloading virtio drivers…" });
        await download(VIRTIO_WIN_URL, virtioCached, (pct) => emit(vmId, { status: "downloading", progress: pct, message: `Downloading virtio drivers… ${pct}%` }), signal);
        virtioPath = virtioCached;
      } catch (err) {
        if (err instanceof CancelledError) throw err;
        logger.warn({ err, vm: vmId }, "virtio-win download failed (continuing without it)");
      }
    }
  }

  // 4. Create the UEFI NVRAM copy (OVMF_VARS) for this VM so EFI boot entries
  //    persist across reboots. Without it QEMU uses the system template as
  //    read-only and loses boot entries on every restart.
  const OVMF_VARS_SOURCES = [
    "/usr/share/OVMF/OVMF_VARS.fd",     // Debian/Ubuntu (ovmf package)
    "/usr/share/edk2/x64/OVMF_VARS.fd", // Fedora/RHEL
  ];
  const ovmfVarsTemplate = OVMF_VARS_SOURCES.find(fs.existsSync);
  let ovmfVarsPath: string | null = null;
  if (ovmfVarsTemplate) {
    const varsDir = vmDiskDir(vmId);
    fs.mkdirSync(varsDir, { recursive: true });
    const destVars = path.join(varsDir, "OVMF_VARS.fd");
    if (!fs.existsSync(destVars)) {
      try {
        fs.copyFileSync(ovmfVarsTemplate, destVars);
        ovmfVarsPath = destVars;
        logger.info({ vm: vmId, destVars }, "OVMF_VARS.fd copied for per-VM UEFI NVRAM");
      } catch (err) {
        logger.warn({ err, vm: vmId }, "Could not copy OVMF_VARS.fd (UEFI boot entries won't persist)");
      }
    } else {
      ovmfVarsPath = destVars; // already exists from a previous provision pass
    }
  }

  // 5. Create the disk + unattended answer file (auto-enables SSH + RDP).
  emit(vmId, { status: "creating-disk", progress: 0, message: "Creating Windows VM disk…" });
  // Honor an existing disk path. The flashed appliance's foulfox-first-run
  // pre-creates the guest disk and writes it into the VM config; reusing it (vs.
  // the per-VM managed path) keeps the installed guest stable across reboots
  // instead of orphaning it behind a second disk file. API-created VMs have no
  // diskPath yet and fall back to the managed path.
  const diskPath = vm.config.diskPath ?? path.join(vmDiskDir(vmId), "disk.qcow2");
  fs.mkdirSync(path.dirname(diskPath), { recursive: true });
  if (!fs.existsSync(diskPath)) {
    await runQemuImg(["create", "-f", "qcow2", diskPath, `${vm.diskGb}G`]);
  }
  emit(vmId, { status: "installing", progress: 40, message: "Packaging unattended answer file (auto-SSH + RDP)…" });
  // Per-VM agent keypair + admin account so the agent can SSH in key-only with
  // no human typing a password. The password is a fallback for RDP/interactive.
  const agentKey = await ensureVmSshKey(vmId);
  const adminUser = "foulfox";
  const adminPassword = crypto.randomBytes(12).toString("base64url");
  const unattendIsoPath = await buildUnattendIso(vmId, {
    username: adminUser,
    password: adminPassword,
    pubKey: agentKey?.pubKey ?? null,
  });

  updateVmConfig(vmId, {
    diskPath,
    isoPath,
    virtioIsoPath: virtioPath,
    unattendIsoPath,
    ovmfVarsPath,
    connectionMode: "ssh",
    sshUser: adminUser,
    sshPassword: adminPassword,
    sshKeyPath: agentKey?.keyPath ?? null,
  });

  if (isoPath) {
    emit(vmId, {
      status: "ready",
      progress: 100,
      error: null,
      message: `${label} is ready. Start the VM to boot the installer; OpenSSH + RDP turn on automatically after setup and the virtio driver CD is attached. Enter your own Windows license key to activate.`,
    });
  } else {
    emit(vmId, {
      status: "ready",
      progress: 100,
      error: null,
      message: "Windows disk + unattended answer file generated. Add a Windows ISO via File Explorer → USB Frontload → ISOs (or this VM's settings), then start the VM.",
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

// ── Download with progress + abort support ────────────────────────────────────────
function download(url: string, dest: string, onProgress: (pct: number) => void, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new CancelledError()); return; }
    const tmp = dest + ".part";
    const client = url.startsWith("https") ? https : http;
    const file = fs.createWriteStream(tmp);

    const cleanup = () => { try { file.close(); } catch { /**/ } fs.rmSync(tmp, { force: true }); };
    const onAbort = () => { req.destroy(); cleanup(); reject(new CancelledError()); };
    signal?.addEventListener("abort", onAbort, { once: true });

    const req = client.get(url, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        signal?.removeEventListener("abort", onAbort);
        file.close();
        fs.rmSync(tmp, { force: true });
        download(res.headers.location, dest, onProgress, signal).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        signal?.removeEventListener("abort", onAbort);
        cleanup();
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
        signal?.removeEventListener("abort", onAbort);
        fs.renameSync(tmp, dest);
        onProgress(100);
        resolve();
      }));
    });
    req.on("error", (err) => {
      signal?.removeEventListener("abort", onAbort);
      cleanup();
      // req.destroy() raises an ECONNRESET — don't double-reject with it when
      // we've already rejected with CancelledError from the abort listener.
      if (!signal?.aborted) reject(err);
    });
  });
}

function runQemuImg(args: string[]): Promise<void> {
  return runTool("qemu-img", args);
}

// ── Clone an installed VM ─────────────────────────────────────────────────────
// Copies the source VM's disk into the target VM's directory as a flattened,
// fully independent qcow2 (qemu-img convert collapses any backing chain), plus
// the per-VM agent SSH keypair (the cloned guest already trusts the source's
// public key in authorized_keys). No installer pass is needed — the clone boots
// straight into the already-installed OS. Progress is reported through the
// normal provisioning SSE channel keyed on the TARGET VM id.
export async function startCloneProvisioning(sourceId: string, targetId: string): Promise<void> {
  const existing = inFlight.get(targetId);
  if (existing) return existing;
  const run = doClone(sourceId, targetId).finally(() => inFlight.delete(targetId));
  inFlight.set(targetId, run);
  return run;
}

async function doClone(sourceId: string, targetId: string): Promise<void> {
  const src = getVm(sourceId);
  const tgt = getVm(targetId);
  if (!src || !tgt) return;
  // Lock the source for the entire copy: startVm refuses clone sources, so the
  // disk cannot be mounted read-write by QEMU mid-convert (which would corrupt
  // the clone). Re-check the runtime state after taking the lock to close the
  // request-time-vs-copy-time race.
  markCloneSource(sourceId);
  try {
    const srcState = getRuntime(sourceId).state;
    if (srcState !== "stopped" && srcState !== "error") {
      throw new Error(`Source VM is ${srcState} — stop it fully before cloning.`);
    }
    const srcDisk = src.config.diskPath;
    if (!srcDisk || !fs.existsSync(srcDisk)) {
      throw new Error("Source VM has no disk image to clone.");
    }
    const dir = vmDiskDir(targetId);
    fs.mkdirSync(dir, { recursive: true });
    const dstDisk = path.join(dir, "disk.qcow2");

    emit(targetId, {
      status: "creating-disk",
      progress: 10,
      error: null,
      message: `Cloning disk from "${src.name}"… this copies the whole installed system and can take a few minutes.`,
    });
    await runQemuImg(["convert", "-O", "qcow2", srcDisk, dstDisk]);

    // Carry over the agent keypair so key-based SSH keeps working in the clone.
    let sshKeyPath: string | null = null;
    if (src.config.sshKeyPath && fs.existsSync(src.config.sshKeyPath)) {
      sshKeyPath = path.join(dir, "agent_ed25519");
      fs.copyFileSync(src.config.sshKeyPath, sshKeyPath);
      try { fs.chmodSync(sshKeyPath, 0o600); } catch { /* ignore */ }
      const srcPub = src.config.sshKeyPath + ".pub";
      if (fs.existsSync(srcPub)) fs.copyFileSync(srcPub, sshKeyPath + ".pub");
    }

    updateVmConfig(targetId, {
      diskPath: dstDisk,
      isoPath: null,          // installed system boots from disk; no installer CD
      unattendIsoPath: null,  // answer file already consumed during the original install
      virtioIsoPath: src.config.virtioIsoPath, // shared cache file, read-only CD
      connectionMode: src.config.connectionMode,
      sshUser: src.config.sshUser,
      sshPassword: src.config.sshPassword,
      sshKeyPath,
      displayMode: src.config.displayMode,
    });

    emit(targetId, {
      status: "ready",
      progress: 100,
      error: null,
      message: `Clone of "${src.name}" is ready. Start the VM to boot it.`,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, source: sourceId, target: targetId }, "VM clone failed");
    emit(targetId, { status: "failed", error: msg, message: `Clone failed: ${msg}` });
  } finally {
    unmarkCloneSource(sourceId);
  }
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

// Package the autounattend.xml into a small ISO. Windows Setup scans attached
// optical/removable media for an autounattend.xml at the root, so the answer
// file must live on a CD — a loose file in the VM directory is never read.
// Returns null when no ISO-authoring tool is available (the install still
// works, it just won't be unattended).
async function buildUnattendIso(
  vmId: string,
  opts: { username: string; password: string; pubKey: string | null },
): Promise<string | null> {
  const stage = path.join(vmDiskDir(vmId), "unattend-cd");
  fs.mkdirSync(stage, { recursive: true });
  fs.writeFileSync(path.join(stage, "autounattend.xml"), buildAutoUnattend(opts));
  const isoOut = path.join(vmDiskDir(vmId), "unattend.iso");
  for (const tool of ["genisoimage", "mkisofs", "xorriso"]) {
    if (await binaryExists(tool)) {
      const args =
        tool === "xorriso"
          ? ["-as", "mkisofs", "-output", isoOut, "-volid", "UNATTEND", "-joliet", "-rock", stage]
          : ["-output", isoOut, "-volid", "UNATTEND", "-joliet", "-rock", stage];
      await runTool(tool, args);
      return isoOut;
    }
  }
  logger.warn({ vm: vmId }, "no ISO authoring tool available — Windows install will not be unattended");
  return null;
}

// Windows autounattend.xml that makes the guest hands-off for the agent:
//   • creates a local Administrator account (so OOBE never blocks on account setup)
//   • auto-logs in once so the FirstLogonCommands actually run
//   • enables OpenSSH Server + RDP
//   • installs the agent's public key into administrators_authorized_keys with the
//     ACLs OpenSSH requires (Administrators + SYSTEM only, inheritance removed) —
//     for an admin user OpenSSH ignores ~/.ssh/authorized_keys and reads this file.
// Wrap a PowerShell script as a single XML/CMD-safe FirstLogonCommand. Using
// -EncodedCommand (base64 of UTF-16LE) means the script body can contain quotes,
// ampersands, and angle brackets without any XML or shell escaping corrupting
// the answer file — important for the multi-line browser-install scripts below.
function psEncoded(script: string): string {
  const b64 = Buffer.from(script, "utf16le").toString("base64");
  return `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${b64}`;
}

// The public key is base64-wrapped before being embedded in the PowerShell so no
// quoting/XML-escaping can corrupt it. (Edition/key/partition specifics vary by
// ISO and are intentionally left to the supplied media's defaults.)
function buildAutoUnattend(opts: { username: string; password: string; pubKey: string | null }): string {
  const { username, password, pubKey } = opts;
  const keyB64 = pubKey ? Buffer.from(pubKey, "utf-8").toString("base64") : null;
  const keyCommand = keyB64
    ? `        <SynchronousCommand wcm:action="add">
          <Order>2</Order>
          <CommandLine>powershell -NoProfile -ExecutionPolicy Bypass -Command "$d='C:\\ProgramData\\ssh'; New-Item -ItemType Directory -Force -Path $d | Out-Null; $k=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${keyB64}')); $f=Join-Path $d 'administrators_authorized_keys'; Set-Content -Path $f -Value $k -Encoding ascii; icacls $f /inheritance:r /grant 'Administrators:F' /grant 'SYSTEM:F'"</CommandLine>
        </SynchronousCommand>
`
    : "";

  // ── Browser automation (Windows scraper / Playwright-over-CDP) ───────────────
  // Install Chrome + Node + Playwright in the guest and expose Chrome's DevTools
  // endpoint so a host-side Playwright (over the QEMU CDP host-forward) OR an
  // in-guest Playwright can drive a REAL desktop browser. These run once, after
  // auto-logon, with outbound internet via QEMU user-mode NAT. Each script is
  // wrapped with -EncodedCommand so quotes/&/<> can never corrupt the answer
  // file, and each ends `exit 0` so a failed download never aborts OOBE.
  // NOTE: only exercisable on a KVM-capable host — a guest cannot boot where
  // /dev/kvm is absent, so this is implemented correct-by-design, not runtime-tested.
  const sync = (order: number, cmd: string): string =>
    `        <SynchronousCommand wcm:action="add">
          <Order>${order}</Order>
          <CommandLine>${cmd}</CommandLine>
        </SynchronousCommand>
`;
  // Node.js LTS (pinned permanent dist URL — bump the version as needed).
  const nodeInstallScript = String.raw`$ErrorActionPreference='SilentlyContinue'
$ProgressPreference='SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12
$u='https://nodejs.org/dist/v20.18.0/node-v20.18.0-x64.msi'
$o=Join-Path $env:TEMP 'node-lts-x64.msi'
try { Invoke-WebRequest -Uri $u -OutFile $o -UseBasicParsing } catch {}
if (Test-Path $o) { Start-Process msiexec.exe -ArgumentList '/i', $o, '/qn', '/norestart' -Wait }
exit 0`;
  // Google Chrome stable (Google's permanent latest-stable enterprise MSI URL).
  const chromeInstallScript = String.raw`$ErrorActionPreference='SilentlyContinue'
$ProgressPreference='SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12
$u='https://dl.google.com/dl/chrome/install/googlechromestandaloneenterprise64.msi'
$o=Join-Path $env:TEMP 'chrome-enterprise-x64.msi'
try { Invoke-WebRequest -Uri $u -OutFile $o -UseBasicParsing } catch {}
if (Test-Path $o) { Start-Process msiexec.exe -ArgumentList '/i', $o, '/qn', '/norestart' -Wait }
exit 0`;
  // Playwright (npm global). The Node MSI updates the machine PATH but not this
  // already-running session, so refresh PATH and call npm by full path. Pulling
  // Playwright's own chromium is best-effort (the CDP path drives system Chrome).
  const playwrightInstallScript = String.raw`$ErrorActionPreference='SilentlyContinue'
$ProgressPreference='SilentlyContinue'
$env:Path=[Environment]::GetEnvironmentVariable('Path','Machine')+';'+[Environment]::GetEnvironmentVariable('Path','User')
$npm=Join-Path $env:ProgramFiles 'nodejs\npm.cmd'
if (Test-Path $npm) {
  & $npm install -g playwright
  $pw=Join-Path $env:APPDATA 'npm\playwright.cmd'
  if (Test-Path $pw) { & $pw install chromium }
}
exit 0`;
  // Expose CDP: open the firewall for 9222, bridge guest-NIC:9222 -> loopback:9222
  // (the QEMU host-forward targets the guest NIC IP 10.0.2.15, but Chrome's
  // DevTools port binds loopback only), then (re)launch HEADED Chrome with remote
  // debugging at every logon. Headed (not --headless) preserves the real-desktop
  // anti-detection benefit. We do NOT pass --remote-allow-origins=*: Playwright's
  // Node connectOverCDP sends no Origin header, so Chrome M111+ still accepts it,
  // while the wildcard would let any browser page attach (DNS-rebind / cross-origin
  // CDP hijack). Chrome's debug port also binds guest loopback (127.0.0.1) and the
  // QEMU host-forward binds host loopback, so the only reachable surface is the
  // host itself. NOTE: across reboots this needs persistent auto-logon (LogonCount
  // is 1 today) — tracked as a follow-up.
  const cdpSetupScript = String.raw`$ErrorActionPreference='SilentlyContinue'
New-NetFirewallRule -Name 'FoulFox-CDP-In' -DisplayName 'FoulFox Chrome DevTools (CDP)' -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 9222 -ErrorAction SilentlyContinue
netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=9222 connectaddress=127.0.0.1 connectport=9222
$chrome=Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'
if (Test-Path $chrome) {
  $a=New-ScheduledTaskAction -Execute $chrome -Argument '--remote-debugging-port=9222 --remote-debugging-address=127.0.0.1 --user-data-dir=C:\cdp-profile --no-first-run --no-default-browser-check'
  $t=New-ScheduledTaskTrigger -AtLogOn
  $p=New-ScheduledTaskPrincipal -UserId $env:USERNAME -RunLevel Highest
  Register-ScheduledTask -TaskName 'FoulFoxCDP' -Action $a -Trigger $t -Principal $p -Force
  Start-ScheduledTask -TaskName 'FoulFoxCDP'
}
exit 0`;
  const browserAutomationCommands =
    sync(5, psEncoded(nodeInstallScript)) +
    sync(6, psEncoded(chromeInstallScript)) +
    sync(7, psEncoded(playwrightInstallScript)) +
    sync(8, psEncoded(cdpSetupScript));

  // ── Developer tools ──────────────────────────────────────────────────────────
  // Git for Windows, VS Code + dev extensions, GitHub CLI, .NET 8 SDK,
  // Unity Hub, and Epic Games Launcher (for Unreal Engine). All scripts end
  // with `exit 0` so a slow or failed download never stalls the OOBE sequence.
  // These are also exposed via /api/vm/:id/dev-setup for existing VMs.

  // Git for Windows — winget first (Windows 11 built-in), direct exe fallback.
  const gitInstallScript = String.raw`$ErrorActionPreference='SilentlyContinue'
$ProgressPreference='SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12
$wg=Get-Command winget -ErrorAction SilentlyContinue
if ($wg) {
  & $wg install --id Git.Git -e --silent --accept-package-agreements --accept-source-agreements 2>$null
} else {
  $u='https://github.com/git-for-windows/git/releases/download/v2.47.1.windows.1/Git-2.47.1-64-bit.exe'
  $o=Join-Path $env:TEMP 'git-win-setup.exe'
  try { Invoke-WebRequest -Uri $u -OutFile $o -UseBasicParsing } catch {}
  if (Test-Path $o) { Start-Process $o -ArgumentList '/VERYSILENT','/NORESTART','/COMPONENTS=icons,ext\reg\shellhere,assoc,assoc_sh' -Wait }
}
exit 0`;

  // VS Code (Microsoft's permanent latest-stable redirect URL — no version
  // pinning needed) + a curated set of dev extensions installed post-setup.
  const vscodeInstallScript = String.raw`$ErrorActionPreference='SilentlyContinue'
$ProgressPreference='SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12
$u='https://update.code.visualstudio.com/latest/win32-x64-user/stable'
$o=Join-Path $env:TEMP 'vscode-user-setup.exe'
try { Invoke-WebRequest -Uri $u -OutFile $o -UseBasicParsing } catch {}
if (Test-Path $o) {
  Start-Process $o -ArgumentList '/VERYSILENT','/NORESTART','/MERGETASKS=!runcode,addcontextmenufiles,addcontextmenufolders,associatewithfiles,addtopath' -Wait
}
$env:Path=[Environment]::GetEnvironmentVariable('Path','Machine')+';'+[Environment]::GetEnvironmentVariable('Path','User')
$code=@(
  "$env:LOCALAPPDATA\Programs\Microsoft VS Code\bin\code.cmd",
  'C:\Program Files\Microsoft VS Code\bin\code.cmd'
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($code) {
  $exts=@(
    'ms-python.python',
    'ms-dotnettools.csharp',
    'ms-dotnettools.vscode-dotnet-runtime',
    'dbaeumer.vscode-eslint',
    'esbenp.prettier-vscode',
    'eamodio.gitlens',
    'github.vscode-pull-request-github',
    'ms-vscode-remote.remote-ssh',
    'unity.com-unity-technologies-vscode-unity',
    'ms-vscode.live-server',
    'visualstudioexptteam.vscodeintellicode'
  )
  foreach ($e in $exts) { & $code --install-extension $e --force 2>$null }
}
exit 0`;

  // GitHub CLI + .NET 8 SDK + Epic Games Launcher (Unreal Engine hub) via
  // winget. Best-effort: winget needs App Installer warm-up on some editions.
  const devInfraScript = String.raw`$ErrorActionPreference='SilentlyContinue'
$ProgressPreference='SilentlyContinue'
$wg=Get-Command winget -ErrorAction SilentlyContinue
if ($wg) {
  & $wg install --id GitHub.cli                 -e --silent --accept-package-agreements --accept-source-agreements 2>$null
  & $wg install --id Microsoft.DotNet.SDK.8     -e --silent --accept-package-agreements --accept-source-agreements 2>$null
  & $wg install --id EpicGames.EpicGamesLauncher -e --silent --accept-package-agreements --accept-source-agreements 2>$null
}
exit 0`;

  // Unity Hub — the small launcher that lets users download and manage Unity
  // editor versions. Unity Editor itself (3–5 GB) is user-initiated from
  // within the Hub after setup.
  const unityHubScript = String.raw`$ErrorActionPreference='SilentlyContinue'
$ProgressPreference='SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12
$u='https://public-cdn.cloud.unity3d.com/hub/prod/UnityHubSetup.exe'
$o=Join-Path $env:TEMP 'UnityHubSetup.exe'
try { Invoke-WebRequest -Uri $u -OutFile $o -UseBasicParsing } catch {}
if (Test-Path $o) { Start-Process $o -ArgumentList '--silent' -Wait }
exit 0`;

  const devToolsCommands =
    sync(9,  psEncoded(gitInstallScript)) +
    sync(10, psEncoded(vscodeInstallScript)) +
    sync(11, psEncoded(devInfraScript)) +
    sync(12, psEncoded(unityHubScript));

  return `<?xml version="1.0" encoding="utf-8"?>
<unattend xmlns="urn:schemas-microsoft-com:unattend" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State">
  <settings pass="windowsPE">
    <component name="Microsoft-Windows-Setup" processorArchitecture="amd64"
               publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">

      <!-- ── Skip the product-key screen and EULA (key entered later or skipped) ── -->
      <UserData>
        <AcceptEula>true</AcceptEula>
        <ProductKey>
          <!-- Empty = skip key entry screen; Windows activates after install if a
               digital licence is linked to the Microsoft account, or the user can
               enter a key from Settings > Activation. -->
          <WillShowUI>Never</WillShowUI>
        </ProductKey>
      </UserData>

      <!-- ── Partition Disk 0 (the QEMU virtual AHCI disk) for UEFI ─────────────
           IMPORTANT: Disk 0 inside this VM is the 64 GB virtual qcow2 disk
           created by FoulFox — it is NOT the physical host drive. The FoulFox OS
           lives on a completely separate device and is never visible to the VM.
           WillWipeDisk wipes only this virtual disk. Layout:
             Part 1 — 512 MB  FAT32 EFI System Partition  (UEFI boot)
             Part 2 — 16 MB   Microsoft Reserved           (GPT housekeeping)
             Part 3 — rest     NTFS Windows OS              (C:\)
      ── -->
      <DiskConfiguration>
        <WillShowUI>OnError</WillShowUI>
        <Disk wcm:action="add">
          <DiskID>0</DiskID>
          <WillWipeDisk>true</WillWipeDisk>
          <CreatePartitions>
            <CreatePartition wcm:action="add">
              <Order>1</Order>
              <Type>EFI</Type>
              <Size>512</Size>
            </CreatePartition>
            <CreatePartition wcm:action="add">
              <Order>2</Order>
              <Type>MSR</Type>
              <Size>16</Size>
            </CreatePartition>
            <CreatePartition wcm:action="add">
              <Order>3</Order>
              <Type>Primary</Type>
              <Extend>true</Extend>
            </CreatePartition>
          </CreatePartitions>
          <ModifyPartitions>
            <ModifyPartition wcm:action="add">
              <Order>1</Order>
              <PartitionID>1</PartitionID>
              <Label>System</Label>
              <Format>FAT32</Format>
            </ModifyPartition>
            <ModifyPartition wcm:action="add">
              <Order>2</Order>
              <PartitionID>2</PartitionID>
            </ModifyPartition>
            <ModifyPartition wcm:action="add">
              <Order>3</Order>
              <PartitionID>3</PartitionID>
              <Label>Windows</Label>
              <Format>NTFS</Format>
              <Letter>C</Letter>
            </ModifyPartition>
          </ModifyPartitions>
        </Disk>
      </DiskConfiguration>

      <!-- ── Install the OS image to the partition we just created ──────────────
           No <MetaData> means "use the first/default edition" — compatible with
           both single-edition (Win11 Home) and multi-edition (Pro/Enterprise) ISOs.
      ── -->
      <ImageInstall>
        <OSImage>
          <InstallTo>
            <DiskID>0</DiskID>
            <PartitionID>3</PartitionID>
          </InstallTo>
          <WillShowUI>OnError</WillShowUI>
          <InstallToAvailablePartition>false</InstallToAvailablePartition>
        </OSImage>
      </ImageInstall>

      <!-- ── Win11 hardware-check bypass (TPM / SecureBoot / RAM / CPU) ─────── -->
      <RunSynchronous>
        <RunSynchronousCommand wcm:action="add">
          <Order>1</Order>
          <Path>reg add HKLM\\System\\Setup\\LabConfig /f</Path>
        </RunSynchronousCommand>
        <RunSynchronousCommand wcm:action="add">
          <Order>2</Order>
          <Path>reg add HKLM\\System\\Setup\\LabConfig /v BypassTPMCheck /t REG_DWORD /d 1 /f</Path>
        </RunSynchronousCommand>
        <RunSynchronousCommand wcm:action="add">
          <Order>3</Order>
          <Path>reg add HKLM\\System\\Setup\\LabConfig /v BypassSecureBootCheck /t REG_DWORD /d 1 /f</Path>
        </RunSynchronousCommand>
        <RunSynchronousCommand wcm:action="add">
          <Order>4</Order>
          <Path>reg add HKLM\\System\\Setup\\LabConfig /v BypassRAMCheck /t REG_DWORD /d 1 /f</Path>
        </RunSynchronousCommand>
        <RunSynchronousCommand wcm:action="add">
          <Order>5</Order>
          <Path>reg add HKLM\\System\\Setup\\LabConfig /v BypassStorageCheck /t REG_DWORD /d 1 /f</Path>
        </RunSynchronousCommand>
        <RunSynchronousCommand wcm:action="add">
          <Order>6</Order>
          <Path>reg add HKLM\\System\\Setup\\LabConfig /v BypassCPUCheck /t REG_DWORD /d 1 /f</Path>
        </RunSynchronousCommand>
      </RunSynchronous>
    </component>
  </settings>
  <settings pass="oobeSystem">
    <component name="Microsoft-Windows-Shell-Setup" processorArchitecture="amd64"
               publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">
      <UserAccounts>
        <LocalAccounts>
          <LocalAccount wcm:action="add">
            <Name>${username}</Name>
            <Group>Administrators</Group>
            <Password>
              <Value>${password}</Value>
              <PlainText>true</PlainText>
            </Password>
          </LocalAccount>
        </LocalAccounts>
      </UserAccounts>
      <AutoLogon>
        <Username>${username}</Username>
        <Enabled>true</Enabled>
        <LogonCount>99</LogonCount>
        <Password>
          <Value>${password}</Value>
          <PlainText>true</PlainText>
        </Password>
      </AutoLogon>
      <OOBE>
        <HideEULAPage>true</HideEULAPage>
        <HideLocalAccountScreen>true</HideLocalAccountScreen>
        <HideOnlineAccountScreens>true</HideOnlineAccountScreens>
        <HideOEMRegistrationScreen>true</HideOEMRegistrationScreen>
        <ProtectYourPC>3</ProtectYourPC>
        <NetworkLocation>Home</NetworkLocation>
      </OOBE>
      <FirstLogonCommands>
        <SynchronousCommand wcm:action="add">
          <Order>1</Order>
          <CommandLine>powershell -NoProfile -Command "Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0; Set-Service sshd -StartupType Automatic; Start-Service sshd; New-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -DisplayName 'OpenSSH Server (sshd)' -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 -ErrorAction SilentlyContinue"</CommandLine>
        </SynchronousCommand>
${keyCommand}        <SynchronousCommand wcm:action="add">
          <Order>3</Order>
          <CommandLine>reg add "HKLM\\System\\CurrentControlSet\\Control\\Terminal Server" /v fDenyTSConnections /t REG_DWORD /d 0 /f</CommandLine>
        </SynchronousCommand>
        <SynchronousCommand wcm:action="add">
          <Order>4</Order>
          <CommandLine>netsh advfirewall firewall set rule group="remote desktop" new enable=Yes</CommandLine>
        </SynchronousCommand>
${browserAutomationCommands}${devToolsCommands}${sync(50, psEncoded(`
# Permanent auto-login via registry so the agent gets a desktop after every reboot.
# This runs once under the autounattend auto-logon and makes every subsequent boot
# skip the lock/login screen — essential for unattended agent operation.
$reg = 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon'
Set-ItemProperty -Path $reg -Name AutoAdminLogon   -Value '1'         -Type String
Set-ItemProperty -Path $reg -Name DefaultUserName  -Value '${username}' -Type String
Set-ItemProperty -Path $reg -Name DefaultPassword  -Value '${password}' -Type String
Set-ItemProperty -Path $reg -Name DefaultDomainName -Value '.'         -Type String
# Also disable the lock screen and sleep-induced lock so idle time doesn't lock the agent out.
powercfg /change standby-timeout-ac 0
powercfg /change monitor-timeout-ac 0
reg add 'HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\Personalization' /v NoLockScreen /t REG_DWORD /d 1 /f
exit 0
`.trim()))}      </FirstLogonCommands>
    </component>
  </settings>
</unattend>
`;
}

// Standalone PowerShell script that installs the same developer tools the
// autounattend FirstLogonCommands install on new VMs — for use on existing
// Windows guests that were provisioned before dev tools were added.
// Served by GET /api/vm/:id/dev-setup as a .ps1 download.
export function buildWindowsDevSetupScript(): string {
  // PowerShell uses backtick as its escape character (`n = newline).
  // We can't embed a raw backtick inside a JS template literal, so we
  // build that one line via concatenation and splice it into the script.
  const psNewline = String.fromCharCode(96) + "n"; // `n
  return `#Requires -RunAsAdministrator
<#
  FoulFox Windows Developer Setup
  --------------------------------
  Installs: Git for Windows, VS Code + dev extensions, GitHub CLI,
  .NET 8 SDK, Epic Games Launcher (for Unreal Engine), Unity Hub.

  Run inside the Windows VM as Administrator:
    Set-ExecutionPolicy Bypass -Scope Process -Force
    irm http://<foulfox-host>/api/vm/default/dev-setup | iex
#>
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference    = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Step($msg) { Write-Host "${psNewline}==> $msg" -ForegroundColor Cyan }

# ── Git for Windows ────────────────────────────────────────────────────────────
Step 'Installing Git for Windows'
$wg = Get-Command winget -ErrorAction SilentlyContinue
if ($wg) {
  & $wg install --id Git.Git -e --silent --accept-package-agreements --accept-source-agreements 2>$null
} else {
  $u = 'https://github.com/git-for-windows/git/releases/download/v2.47.1.windows.1/Git-2.47.1-64-bit.exe'
  $o = Join-Path $env:TEMP 'git-win-setup.exe'
  try { Invoke-WebRequest -Uri $u -OutFile $o -UseBasicParsing } catch {}
  if (Test-Path $o) { Start-Process $o -ArgumentList '/VERYSILENT','/NORESTART','/COMPONENTS=icons,ext\reg\shellhere,assoc,assoc_sh' -Wait }
}

# ── VS Code + extensions ───────────────────────────────────────────────────────
Step 'Installing VS Code'
$u = 'https://update.code.visualstudio.com/latest/win32-x64-user/stable'
$o = Join-Path $env:TEMP 'vscode-user-setup.exe'
try { Invoke-WebRequest -Uri $u -OutFile $o -UseBasicParsing } catch {}
if (Test-Path $o) {
  Start-Process $o -ArgumentList '/VERYSILENT','/NORESTART','/MERGETASKS=!runcode,addcontextmenufiles,addcontextmenufolders,associatewithfiles,addtopath' -Wait
}
$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
$code = @(
  "$env:LOCALAPPDATA\Programs\Microsoft VS Code\bin\code.cmd",
  'C:\Program Files\Microsoft VS Code\bin\code.cmd'
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($code) {
  Step 'Installing VS Code extensions'
  $exts = @(
    'ms-python.python',
    'ms-dotnettools.csharp',
    'ms-dotnettools.vscode-dotnet-runtime',
    'dbaeumer.vscode-eslint',
    'esbenp.prettier-vscode',
    'eamodio.gitlens',
    'github.vscode-pull-request-github',
    'ms-vscode-remote.remote-ssh',
    'unity.com-unity-technologies-vscode-unity',
    'ms-vscode.live-server',
    'visualstudioexptteam.vscodeintellicode'
  )
  foreach ($e in $exts) {
    Write-Host "  + $e"
    & $code --install-extension $e --force 2>$null
  }
}

# ── GitHub CLI + .NET 8 SDK + Epic Games Launcher ─────────────────────────────
Step 'Installing GitHub CLI, .NET 8 SDK, Epic Games Launcher (winget)'
if ($wg) {
  & $wg install --id GitHub.cli                  -e --silent --accept-package-agreements --accept-source-agreements 2>$null
  & $wg install --id Microsoft.DotNet.SDK.8      -e --silent --accept-package-agreements --accept-source-agreements 2>$null
  & $wg install --id EpicGames.EpicGamesLauncher -e --silent --accept-package-agreements --accept-source-agreements 2>$null
} else {
  Write-Host '  winget not available — skipping GitHub CLI / .NET SDK / Epic Launcher'
}

# ── Unity Hub ─────────────────────────────────────────────────────────────────
Step 'Installing Unity Hub'
$u = 'https://public-cdn.cloud.unity3d.com/hub/prod/UnityHubSetup.exe'
$o = Join-Path $env:TEMP 'UnityHubSetup.exe'
try { Invoke-WebRequest -Uri $u -OutFile $o -UseBasicParsing } catch {}
if (Test-Path $o) { Start-Process $o -ArgumentList '--silent' -Wait }

Write-Host ''
Write-Host '==> FoulFox dev setup complete.' -ForegroundColor Green
Write-Host '    Git, VS Code, GitHub CLI, .NET 8 SDK, Epic Games Launcher, Unity Hub'
Write-Host '    Open Unity Hub to download a Unity editor version.'
Write-Host '    Open Epic Games Launcher to install Unreal Engine.'
`;
}

// Generate (or reuse) a dedicated ed25519 keypair for this VM's agent login.
// The private key stays on the host (referenced by vm.config.sshKeyPath); the
// Startup helper: generate SSH keypairs for any VMs that were provisioned
// without one (e.g. VMs created before keygen was added, or Windows VMs whose
// provisioning pathway didn't call ensureVmSshKey). Safe to call on every boot
// — it is a no-op when the key files already exist. The new key path is
// persisted into the VM config so ssh/exec routes can use it immediately.
export async function backfillVmSshKeys(): Promise<void> {
  const { listVms, updateVmConfig } = await import("./vm-registry");
  const vms = listVms();
  for (const vm of vms) {
    if (vm.config.sshKeyPath) continue; // already has a key
    logger.info({ vm: vm.id }, "backfilling agent SSH keypair");
    const result = await ensureVmSshKey(vm.id);
    if (result) {
      updateVmConfig(vm.id, { sshKeyPath: result.keyPath });
      logger.info({ vm: vm.id, keyPath: result.keyPath }, "agent SSH keypair ready");
    }
  }
}

// Generate (or reuse) a dedicated ed25519 keypair for this VM's agent login.
// The private key stays on the host (referenced by vm.config.sshKeyPath); the
// public key is injected into the guest at provision time. Returns null if
// ssh-keygen is unavailable so provisioning degrades to password/manual setup.
async function ensureVmSshKey(vmId: string): Promise<{ keyPath: string; pubKey: string } | null> {
  const keyPath = path.join(vmDiskDir(vmId), "agent_ed25519");
  const pubPath = keyPath + ".pub";
  try {
    if (!fs.existsSync(keyPath) || !fs.existsSync(pubPath)) {
      // Clear any half-written remnants so ssh-keygen never prompts to overwrite.
      fs.rmSync(keyPath, { force: true });
      fs.rmSync(pubPath, { force: true });
      await runTool("ssh-keygen", ["-t", "ed25519", "-N", "", "-C", `foulfox-agent@${vmId}`, "-f", keyPath]);
    }
    const pubKey = fs.readFileSync(pubPath, "utf-8").trim();
    try { fs.chmodSync(keyPath, 0o600); } catch { /* ignore */ }
    return { keyPath, pubKey };
  } catch (err) {
    logger.warn({ err, vm: vmId }, "agent SSH keypair generation skipped");
    return null;
  }
}

// Typed client for the multi-VM endpoints. These return plain JSON (matching the
// backend's hand-rolled multi-VM routes), so we use raw fetch via apiUrl/apiWsUrl
// rather than the generated api-client (which only covers the legacy default VM).
import { apiUrl, apiWsUrl } from "./api-url";

export const DEFAULT_VM_ID = "default";

export type OsKind = "linux" | "windows" | "macos";
export type VmState = "stopped" | "starting" | "running" | "stopping" | "error";
export type ProvisioningStatus =
  | "none"
  | "downloading"
  | "creating-disk"
  | "installing"
  | "ready"
  | "failed";

export interface ProvisioningState {
  status: ProvisioningStatus;
  progress: number; // 0..100
  message: string;
  error: string | null;
  imageUrl?: string | null;
}

export interface VmPorts {
  ssh: number;
  rdp: number;
  vnc: number;
  vncWs: number;
  monitor: number;
}

export interface VmSummary {
  id: string;
  name: string;
  osKind: OsKind;
  state: VmState;
  pid: number | null;
  uptime: number | null;
  isoPath: string | null;
  diskPath: string | null;
  ramGb: number;
  cpuCores: number;
  gpuPassthrough: string | null;
  connectionMode: string;
  sshPort: number;
  ports: VmPorts;
  provisioning: ProvisioningState;
  displayToken: string;
}

export interface OsSupport {
  supported: boolean;
  reason: string;
}

export interface VmCapabilities {
  canBootVm: boolean;
  kvm: boolean;
  kvmReason: string;
  qemuSystem: boolean;
  qemuImg: boolean;
  platform: string;
  arch: string;
  message: string;
  accelerator: { accel: string; hardware: boolean; reason: string };
  appleHost: boolean;
  totalRamGb: number;
  cpuCount: number;
  osSupport: Record<OsKind, OsSupport>;
}

export type VmLifecycleAction = "start" | "stop" | "restart";

function jsonHeaders(token?: string | null): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  // Mutations require the shell session token (GET endpoints pass without it).
  if (token) h["X-Shell-Token"] = token;
  return h;
}

async function parseError(res: Response): Promise<string> {
  try {
    const j = await res.json();
    return j?.error || j?.message || `Request failed (${res.status})`;
  } catch {
    return `Request failed (${res.status})`;
  }
}

export async function listVms(): Promise<VmSummary[]> {
  const res = await fetch(apiUrl("/api/vm/list"));
  if (!res.ok) throw new Error(await parseError(res));
  const j = await res.json();
  return (j.vms ?? []) as VmSummary[];
}

export async function fetchCapabilities(): Promise<VmCapabilities> {
  const res = await fetch(apiUrl("/api/vm/capabilities"));
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

// One selectable OS in the picker. Mirrors the backend's UI-safe projection
// (no raw download URLs) plus per-host capability gating.
export interface OsImage {
  id: string;
  family: OsKind;
  label: string;
  version: string;
  stability: string;
  blurb: string;
  autoDownload: boolean;
  defaultRamGb: number;
  defaultDiskGb: number;
  supported: boolean;
  reason: string;
}

export async function fetchOsImages(): Promise<OsImage[]> {
  const res = await fetch(apiUrl("/api/vm/os-images"));
  if (!res.ok) throw new Error(await parseError(res));
  const j = await res.json();
  return (j.images ?? []) as OsImage[];
}

// Where the bootable FoulFox OS appliance .iso can be downloaded from. Populated
// from the api-server's env (explicit URL or a GitHub repo's rolling release).
// When unavailable, the Download tab shows one-time setup steps instead.
export interface OsReleaseInfo {
  available: boolean;
  isoUrl: string | null;
  sha256Url: string | null;
  repo: string | null;
  source: "explicit" | "github" | null;
  version: string | null;
}

export async function fetchOsRelease(): Promise<OsReleaseInfo> {
  const res = await fetch(apiUrl("/api/os/release-info"));
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export interface CreateVmInput {
  name: string;
  osKind: OsKind;
  imageId?: string;
  ramGb?: number;
  cpuCores?: number;
  diskGb?: number;
}

export async function createVm(input: CreateVmInput, token?: string | null): Promise<VmSummary> {
  const res = await fetch(apiUrl("/api/vm/create"), {
    method: "POST",
    headers: jsonHeaders(token),
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await parseError(res));
  const j = await res.json();
  return j.vm as VmSummary;
}

export async function vmLifecycle(
  id: string,
  action: VmLifecycleAction,
  token?: string | null,
): Promise<{ success: boolean; message: string; state: string }> {
  const res = await fetch(apiUrl(`/api/vm/${encodeURIComponent(id)}/${action}`), {
    method: "POST",
    headers: jsonHeaders(token),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export async function deleteVm(id: string, token?: string | null): Promise<void> {
  const res = await fetch(apiUrl(`/api/vm/${encodeURIComponent(id)}`), {
    method: "DELETE",
    headers: jsonHeaders(token),
  });
  if (!res.ok) throw new Error(await parseError(res));
}

export async function retryProvision(id: string, token?: string | null): Promise<void> {
  const res = await fetch(apiUrl(`/api/vm/${encodeURIComponent(id)}/provision`), {
    method: "POST",
    headers: jsonHeaders(token),
  });
  if (!res.ok) throw new Error(await parseError(res));
}

// websockify-style raw-RFB relay to the VM's QEMU VNC port, gated by per-VM token.
export function displayWsUrl(vm: VmSummary): string {
  return apiWsUrl(
    `/api/vm/ws/display?vm=${encodeURIComponent(vm.id)}&token=${encodeURIComponent(vm.displayToken)}`,
  );
}

// SSE endpoint streaming ProvisioningState frames.
export function provisionStreamUrl(id: string): string {
  return apiUrl(`/api/vm/${encodeURIComponent(id)}/provision/stream`);
}

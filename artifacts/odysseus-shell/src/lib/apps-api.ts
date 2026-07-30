// Client for the FoulFox App fetch/install API (/api/apps/*).

import { apiUrl } from "./api-url";
import { authedFetch } from "./shell-token";

export type AppStatus = "installing" | "installed" | "error";
export type AppCapability = "agent.task" | "vm.computer_use";
export const ALL_CAPABILITIES: AppCapability[] = ["agent.task", "vm.computer_use"];

export type InstallPhase =
  | "cloning"
  | "extracting"
  | "parsing"
  | "installing"
  | "building"
  | "done"
  | "error";

export type RunPhase = "stopped" | "starting" | "running" | "crashed";

export interface RunSummary {
  appId: string;
  phase: RunPhase;
  pid: number | null;
  port: number | null;
  startedAt: number | null;
  healthyAt: number | null;
  restarts: number;
  lastExit: string | null;
}

export interface AppWindow {
  title?: string;
  width?: number;
  height?: number;
}

export interface InstalledApp {
  id: string;
  isDefault?: boolean;
  name: string;
  version: string;
  description: string;
  icon: string | null;
  runtime: "node" | "python";
  status: AppStatus;
  error: string | null;
  capabilities: AppCapability[];
  grantedCapabilities: AppCapability[];
  repoUrl: string;
  uiPath: string;
  hasWindow: boolean;
  autostart: boolean;
  window?: AppWindow | null;
  run: RunSummary;
  createdAt: number;
  installedAt: number | null;
  updatedAt: number;
}

export interface InstallJob {
  jobId: string;
  phase: InstallPhase;
  appId: string | null;
  appName: string | null;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
  log: string;
}

export function appIconUrl(id: string): string {
  return apiUrl(`/api/apps/${encodeURIComponent(id)}/icon`);
}

function jsonHeaders(): Record<string, string> {
  return { "Content-Type": "application/json" };
}

async function parseError(res: Response): Promise<string> {
  try {
    const j = await res.json();
    return j?.error || j?.message || `Request failed (${res.status})`;
  } catch {
    return `Request failed (${res.status})`;
  }
}

export async function listApps(): Promise<InstalledApp[]> {
  const res = await fetch(apiUrl("/api/apps"));
  if (!res.ok) throw new Error(await parseError(res));
  const j = await res.json();
  return Array.isArray(j?.apps) ? j.apps : [];
}

export async function startAppInstall(
  repoUrl: string,
  capabilities: AppCapability[],
): Promise<{ jobId: string; status: string }> {
  const res = await authedFetch("/api/apps/install", {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ repoUrl, capabilities }),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

// Upload a .zip from the browser (raw body = the zip). Capabilities ride in the
// query string because the body is the file itself.
export async function startAppZipUpload(
  file: File,
  capabilities: AppCapability[],
): Promise<{ jobId: string; status: string }> {
  const params = new URLSearchParams({
    name: file.name,
    capabilities: capabilities.join(","),
  });
  const res = await authedFetch(`/api/apps/install-zip?${params}`, {
    method: "POST",
    headers: { "Content-Type": "application/zip" },
    body: file,
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

// Install a .zip that is already on this machine (e.g. a plugged-in flash drive).
export async function startAppFileInstall(
  path: string,
  capabilities: AppCapability[],
): Promise<{ jobId: string; status: string }> {
  const res = await authedFetch("/api/apps/install-file", {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ path, capabilities }),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

// ── Flash-drive browsing (reuses the host files API) ──────────────────────────
export interface DriveInfo {
  name: string;
  path: string;
  label: string | null;
  fsType: string | null;
  sizeBytes: number | null;
  removable: boolean;
}

export interface DirEntry {
  name: string;
  path: string;
  type: "file" | "directory" | "symlink" | "other";
  sizeBytes: number | null;
  modifiedMs: number | null;
}

export interface DirListing {
  path: string;
  parent: string | null;
  entries: DirEntry[];
}

export async function listDrives(): Promise<DriveInfo[]> {
  const res = await authedFetch("/api/files/drives", { headers: jsonHeaders() });
  if (!res.ok) throw new Error(await parseError(res));
  const j = await res.json();
  return Array.isArray(j) ? j : [];
}

export async function listDirectory(path: string): Promise<DirListing> {
  const res = await authedFetch(`/api/files/list?path=${encodeURIComponent(path)}`, {
    headers: jsonHeaders(),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export async function fetchInstallJob(jobId: string): Promise<InstallJob> {
  const res = await fetch(apiUrl(`/api/apps/install/${encodeURIComponent(jobId)}`));
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export async function uninstallApp(id: string): Promise<{ ok: boolean }> {
  const res = await authedFetch(`/api/apps/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: jsonHeaders(),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export async function startAppRun(
  id: string,
): Promise<{ ok: boolean; run: RunSummary }> {
  const res = await authedFetch(`/api/apps/${encodeURIComponent(id)}/start`, {
    method: "POST",
    headers: jsonHeaders(),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export async function stopAppRun(
  id: string,
): Promise<{ ok: boolean; run: RunSummary }> {
  const res = await authedFetch(`/api/apps/${encodeURIComponent(id)}/stop`, {
    method: "POST",
    headers: jsonHeaders(),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export async function fetchRunLog(id: string): Promise<string> {
  const res = await fetch(apiUrl(`/api/apps/${encodeURIComponent(id)}/run-log`));
  if (!res.ok) throw new Error(await parseError(res));
  return res.text();
}

// The proxied UI path the shell embeds in an iframe. On the appliance the
// server reports a dedicated loopback origin for app UIs (privilege
// separation: app JS must never be same-origin with the shell API); in dev it
// reports null and the same-origin path is used with an opaque-sandbox iframe.
export function appUiUrl(id: string, uiBase: string | null): string {
  const p = `/api/apps/${encodeURIComponent(id)}/ui/`;
  return uiBase ? `${uiBase}${p}` : apiUrl(p);
}

export async function fetchAppUiBase(): Promise<string | null> {
  try {
    const res = await fetch(apiUrl("/api/apps/ui-base"));
    if (!res.ok) return null;
    const data = (await res.json()) as { base?: string | null };
    return data.base ?? null;
  } catch {
    return null;
  }
}

export async function reinstallApp(
  id: string,
): Promise<{ jobId: string; status: string }> {
  const res = await authedFetch(`/api/apps/${encodeURIComponent(id)}/reinstall`, {
    method: "POST",
    headers: jsonHeaders(),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export async function fetchAppLogs(id: string): Promise<string> {
  const res = await fetch(apiUrl(`/api/apps/${encodeURIComponent(id)}/logs`));
  if (!res.ok) throw new Error(await parseError(res));
  return res.text();
}

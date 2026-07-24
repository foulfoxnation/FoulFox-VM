// Client for the FoulFox App fetch/install API (/api/apps/*).

import { apiUrl } from "./api-url";

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

function jsonHeaders(token?: string | null): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
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

export async function listApps(): Promise<InstalledApp[]> {
  const res = await fetch(apiUrl("/api/apps"));
  if (!res.ok) throw new Error(await parseError(res));
  const j = await res.json();
  return Array.isArray(j?.apps) ? j.apps : [];
}

export async function startAppInstall(
  repoUrl: string,
  capabilities: AppCapability[],
  token?: string | null,
): Promise<{ jobId: string; status: string }> {
  const res = await fetch(apiUrl("/api/apps/install"), {
    method: "POST",
    headers: jsonHeaders(token),
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
  token?: string | null,
): Promise<{ jobId: string; status: string }> {
  const params = new URLSearchParams({
    name: file.name,
    capabilities: capabilities.join(","),
  });
  const headers: Record<string, string> = { "Content-Type": "application/zip" };
  if (token) headers["X-Shell-Token"] = token;
  const res = await fetch(apiUrl(`/api/apps/install-zip?${params}`), {
    method: "POST",
    headers,
    body: file,
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

// Install a .zip that is already on this machine (e.g. a plugged-in flash drive).
export async function startAppFileInstall(
  path: string,
  capabilities: AppCapability[],
  token?: string | null,
): Promise<{ jobId: string; status: string }> {
  const res = await fetch(apiUrl("/api/apps/install-file"), {
    method: "POST",
    headers: jsonHeaders(token),
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

export async function listDrives(token?: string | null): Promise<DriveInfo[]> {
  const res = await fetch(apiUrl("/api/files/drives"), { headers: jsonHeaders(token) });
  if (!res.ok) throw new Error(await parseError(res));
  const j = await res.json();
  return Array.isArray(j) ? j : [];
}

export async function listDirectory(path: string, token?: string | null): Promise<DirListing> {
  const res = await fetch(apiUrl(`/api/files/list?path=${encodeURIComponent(path)}`), {
    headers: jsonHeaders(token),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export async function fetchInstallJob(jobId: string): Promise<InstallJob> {
  const res = await fetch(apiUrl(`/api/apps/install/${encodeURIComponent(jobId)}`));
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export async function uninstallApp(id: string, token?: string | null): Promise<{ ok: boolean }> {
  const res = await fetch(apiUrl(`/api/apps/${encodeURIComponent(id)}`), {
    method: "DELETE",
    headers: jsonHeaders(token),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export async function startAppRun(
  id: string,
  token?: string | null,
): Promise<{ ok: boolean; run: RunSummary }> {
  const res = await fetch(apiUrl(`/api/apps/${encodeURIComponent(id)}/start`), {
    method: "POST",
    headers: jsonHeaders(token),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export async function stopAppRun(
  id: string,
  token?: string | null,
): Promise<{ ok: boolean; run: RunSummary }> {
  const res = await fetch(apiUrl(`/api/apps/${encodeURIComponent(id)}/stop`), {
    method: "POST",
    headers: jsonHeaders(token),
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

export async function fetchAppLogs(id: string): Promise<string> {
  const res = await fetch(apiUrl(`/api/apps/${encodeURIComponent(id)}/logs`));
  if (!res.ok) throw new Error(await parseError(res));
  return res.text();
}

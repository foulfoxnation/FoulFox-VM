// Client for the FoulFox App fetch/install API (/api/apps/*).

import { apiUrl } from "./api-url";

export type AppStatus = "installing" | "installed" | "error";
export type AppCapability = "agent.task" | "vm.computer_use";
export const ALL_CAPABILITIES: AppCapability[] = ["agent.task", "vm.computer_use"];

export type InstallPhase =
  | "cloning"
  | "parsing"
  | "installing"
  | "building"
  | "done"
  | "error";

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

export async function fetchAppLogs(id: string): Promise<string> {
  const res = await fetch(apiUrl(`/api/apps/${encodeURIComponent(id)}/logs`));
  if (!res.ok) throw new Error(await parseError(res));
  return res.text();
}

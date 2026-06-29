// Persistent registry of installed FoulFox Apps.
//
// Mirrors the JSON-on-disk approach of vm-registry.ts (atomic tmp+rename writes
// under a best-effort file lock) rather than Postgres: host-side appliance state
// must survive on a writable partition without a database, and the rest of the
// host subsystem already follows this pattern.
//
// On-disk layout under ODYSSEUS_DATA_DIR/apps:
//   registry.json        the list of AppRecords (this file)
//   <id>/repo            the cloned repository (disposable, re-cloned on update)
//   <id>/data            the app's persistent data dir (FOULFOX_APP_DATA_DIR)
//   <id>/install.log     captured install/build output
//   .staging/<jobId>     transient clone target before relocation

import fs from "fs";
import path from "path";
import { logger } from "./logger";
import type { AppCapability, FoxAppManifest } from "./app-manifest";

export type AppStatus = "installing" | "installed" | "error";

export interface AppRecord {
  id: string;
  name: string;
  version: string;
  description: string;
  icon: string | null;
  repoUrl: string; // canonical https clone URL
  runtime: FoxAppManifest["runtime"];
  capabilities: AppCapability[]; // requested by the manifest
  grantedCapabilities: AppCapability[]; // approved by the user at install
  status: AppStatus;
  error: string | null;
  manifest: FoxAppManifest; // full normalized manifest for the run phase
  createdAt: number;
  installedAt: number | null;
  updatedAt: number;
}

interface RegistryFile {
  version: 1;
  apps: AppRecord[];
}

const HOME = process.env.HOME || "/tmp";
// Same persistence rule as vm-registry: prefer the appliance's writable data
// partition; fall back to $HOME in dev / desktop builds.
const DATA_DIR = process.env["ODYSSEUS_DATA_DIR"] || HOME;

export const APPS_DIR = path.join(DATA_DIR, "apps");
export const STAGING_DIR = path.join(APPS_DIR, ".staging");
const REGISTRY_PATH = path.join(APPS_DIR, "registry.json");
const LOCK_PATH = REGISTRY_PATH + ".lock";

export function appDir(id: string): string {
  return path.join(APPS_DIR, id);
}
export function appRepoDir(id: string): string {
  return path.join(appDir(id), "repo");
}
export function appDataDir(id: string): string {
  return path.join(appDir(id), "data");
}
export function appInstallLogPath(id: string): string {
  return path.join(appDir(id), "install.log");
}

// Best-effort cross-instance file lock (single-process safe), copied from the
// VM registry: retry briefly then steal a stale (>10s) lock so a crashed writer
// can't deadlock us.
function withLock<T>(fn: () => T): T {
  fs.mkdirSync(APPS_DIR, { recursive: true });
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
      try {
        const stat = fs.statSync(LOCK_PATH);
        if (Date.now() - stat.mtimeMs > 10000) {
          fs.rmSync(LOCK_PATH, { force: true });
          continue;
        }
      } catch {
        /* ignore */
      }
      const until = Date.now() + 25;
      while (Date.now() < until) {
        /* brief spin */
      }
    }
  }
  try {
    return fn();
  } finally {
    if (held) {
      try {
        fs.rmSync(LOCK_PATH, { force: true });
      } catch {
        /* ignore */
      }
    }
  }
}

function readRegistryFile(): RegistryFile {
  try {
    if (fs.existsSync(REGISTRY_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf-8"));
      if (parsed && Array.isArray(parsed.apps)) return parsed as RegistryFile;
    }
  } catch (err) {
    logger.error({ err }, "Failed to read app registry; starting empty");
  }
  return { version: 1, apps: [] };
}

function writeRegistryFile(data: RegistryFile): void {
  fs.mkdirSync(APPS_DIR, { recursive: true });
  const tmp = REGISTRY_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, REGISTRY_PATH);
}

export function listApps(): AppRecord[] {
  return readRegistryFile().apps;
}

export function getApp(id: string): AppRecord | undefined {
  return readRegistryFile().apps.find((a) => a.id === id);
}

// Insert or replace a record (keyed by id) under the registry lock.
export function saveApp(record: AppRecord): void {
  withLock(() => {
    const file = readRegistryFile();
    const i = file.apps.findIndex((a) => a.id === record.id);
    if (i >= 0) file.apps[i] = record;
    else file.apps.push(record);
    writeRegistryFile(file);
  });
}

export function updateApp(id: string, mutate: (a: AppRecord) => void): AppRecord | undefined {
  return withLock(() => {
    const file = readRegistryFile();
    const a = file.apps.find((x) => x.id === id);
    if (!a) return undefined;
    mutate(a);
    a.updatedAt = Date.now();
    writeRegistryFile(file);
    return a;
  });
}

export function deleteApp(id: string): boolean {
  return withLock(() => {
    const file = readRegistryFile();
    const before = file.apps.length;
    file.apps = file.apps.filter((a) => a.id !== id);
    writeRegistryFile(file);
    return file.apps.length < before;
  });
}

import fs from "fs";
import path from "path";
import { type ChildProcess } from "child_process";

export type VmState = "stopped" | "starting" | "running" | "stopping" | "error";
export type ConnectionMode = "serial" | "ssh";

export interface VmConfigData {
  isoPath: string | null;
  diskPath: string | null;
  ramGb: number;
  cpuCores: number;
  gpuPassthrough: string | null;
  connectionMode: ConnectionMode;
  sshPort: number;
  sshUser: string | null;
  sshPassword: string | null;
}

const CONFIG_PATH = path.join(process.env.HOME || "/tmp", ".odysseus-vm-config.json");

const DEFAULT_CONFIG: VmConfigData = {
  isoPath: null,
  diskPath: null,
  ramGb: 8,
  cpuCores: 4,
  gpuPassthrough: null,
  connectionMode: "ssh",
  sshPort: 5985,
  sshUser: null,
  sshPassword: null,
};

export function loadVmConfig(): VmConfigData {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")) };
    }
  } catch {
    // ignore
  }
  return { ...DEFAULT_CONFIG };
}

export function saveVmConfig(config: VmConfigData): void {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// Shared mutable VM runtime state (single-process module singleton)
export const vmRuntime = {
  process: null as ChildProcess | null,
  state: "stopped" as VmState,
  startTime: null as number | null,
};

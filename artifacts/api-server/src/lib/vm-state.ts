// Backwards-compatibility shim.
//
// The single-VM in-memory singleton was replaced by the persistent multi-VM
// registry (vm-registry.ts). This module preserves the original exports
// (`vmRuntime`, `loadVmConfig`, `saveVmConfig`) so existing callers — notably
// shell.ts and the default-VM route wrappers — keep working unchanged. They all
// operate on the registry's "default" VM.

import {
  DEFAULT_VM_ID,
  getRuntime,
  getVmConfig,
  updateVmConfig,
  type VmConfigData,
  type VmState,
  type ConnectionMode,
} from "./vm-registry";

export type { VmConfigData, VmState, ConnectionMode };

export type DisplayMode = "headless" | "spice" | "vnc";

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
  sshKeyPath: null,
  virtioIsoPath: null,
  unattendIsoPath: null,
  displayMode: "headless",
  spicePort: 5930,
  vncDisplay: 1,
  usbPassthrough: [],
};

export function loadVmConfig(): VmConfigData {
  return getVmConfig(DEFAULT_VM_ID) ?? { ...DEFAULT_CONFIG };
}

export function saveVmConfig(config: VmConfigData): void {
  updateVmConfig(DEFAULT_VM_ID, config);
}

// The default VM's runtime object. getRuntime returns a stable reference, so
// mutations made by vm-launch (state/process/startTime) are observed here.
export const vmRuntime = getRuntime(DEFAULT_VM_ID);

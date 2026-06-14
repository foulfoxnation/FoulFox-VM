import net from "net";

// Per-VM localhost port set. Every VM gets a unique, non-colliding set so
// multiple VMs can run concurrently. All ports bind to 127.0.0.1 only.
export interface VmPorts {
  ssh: number;        // host-forwarded guest :22
  rdp: number;        // host-forwarded guest :3389 (Windows)
  vnc: number;        // QEMU VNC display (raw RFB over TCP)
  vncWs: number;      // QEMU VNC websocket (consumed by noVNC in the browser)
  monitor: number;    // QMP / monitor TCP (lifecycle + snapshot control)
}

// Base ranges chosen to avoid the dev-server ports and the legacy fixed ports
// (5985 ssh, 3389 rdp, 4444 serial). Each VM consumes one slot per range.
const RANGES = {
  ssh: { start: 21000, span: 200 },
  rdp: { start: 22000, span: 200 },
  vnc: { start: 23000, span: 200 },
  vncWs: { start: 24000, span: 200 },
  monitor: { start: 25000, span: 200 },
} as const;

// Hard guardrails so a runaway "+" can't exhaust the host.
export const MAX_VMS = 8;

export interface ResourceGuards {
  maxVms: number;
  maxTotalRamGb: number;
  maxTotalCpuCores: number;
  maxTotalDiskGb: number;
}

export function defaultResourceGuards(totalRamGb: number, cpuCount: number): ResourceGuards {
  // Never let VMs claim more than ~75% of host RAM / all-but-one cores.
  return {
    maxVms: MAX_VMS,
    maxTotalRamGb: Math.max(2, Math.floor(totalRamGb * 0.75)),
    maxTotalCpuCores: Math.max(1, cpuCount),
    maxTotalDiskGb: 512,
  };
}

// Is a localhost TCP port free right now? Resolves true if we can bind it.
export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "127.0.0.1");
  });
}

// Pick the first free port in a range that is not already claimed by `used`.
async function pickInRange(start: number, span: number, used: Set<number>): Promise<number> {
  for (let p = start; p < start + span; p++) {
    if (used.has(p)) continue;
    if (await isPortFree(p)) return p;
  }
  throw new Error(`No free port available in range ${start}-${start + span}`);
}

// Allocate a full, collision-free port set given the ports already claimed by
// every other VM in the registry. Caller persists the result on the VM record.
export async function allocatePorts(claimed: Iterable<number>): Promise<VmPorts> {
  const used = new Set<number>(claimed);
  const ssh = await pickInRange(RANGES.ssh.start, RANGES.ssh.span, used); used.add(ssh);
  const rdp = await pickInRange(RANGES.rdp.start, RANGES.rdp.span, used); used.add(rdp);
  const vnc = await pickInRange(RANGES.vnc.start, RANGES.vnc.span, used); used.add(vnc);
  const vncWs = await pickInRange(RANGES.vncWs.start, RANGES.vncWs.span, used); used.add(vncWs);
  const monitor = await pickInRange(RANGES.monitor.start, RANGES.monitor.span, used); used.add(monitor);
  return { ssh, rdp, vnc, vncWs, monitor };
}

// Flatten a port set to a list for collision tracking across VMs.
export function portValues(p: VmPorts): number[] {
  return [p.ssh, p.rdp, p.vnc, p.vncWs, p.monitor];
}

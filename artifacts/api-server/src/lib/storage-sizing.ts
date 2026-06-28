// ── Hardware-tiered VM sizing (single source of truth) ───────────────────────
// FoulFox OS, every VM disk, and the user's installable apps all share ONE
// physical disk. This module turns detected host capabilities into a *conservative
// on a small machine, larger on a capable one* recommendation for the primary
// Windows VM (disk + RAM + CPU). It is intentionally dependency-free so it can be
// reused verbatim by the HTTP endpoint, the first-run CLI, and unit checks.
//
// Invariants kept in lockstep with the routes/vm.ts createVm guardrail:
//   • Hold back `reserveGb` (FOULFOX_DISK_RESERVE_GB, default 30) for OS + apps.
//   • The recommended VM disk never exceeds the VM budget (total − reserve).
//   • VM RAM never exceeds 50% of host RAM.
//   • At least one CPU is left for the host on multi-core machines.
// Detection "fails open" to 0 (unknown); we then fall back to safe static
// defaults rather than guessing high.

export const DEFAULT_DISK_RESERVE_GB = 30;

// Safe static fallbacks used when a dimension is unknown (detected as 0).
const FALLBACK_DISK_GB = 64;
const FALLBACK_RAM_GB = 8;
const FALLBACK_CPU = 2;

// Windows 11 wants ~64GB; below this it boots but is cramped.
const WIN_COMFORTABLE_DISK_GB = 64;
const WIN_MIN_DISK_GB = 40;

// Keep at most this fraction of the VM budget for the *primary* VM, leaving
// headroom for snapshots, a second VM, and growth. Only binds on small disks.
const PRIMARY_VM_BUDGET_FRACTION = 0.75;

export type SizingTier = "unknown" | "compact" | "standard" | "large" | "xlarge";

export interface SizingInputs {
  totalDiskGb: number;
  freeDiskGb: number;
  totalRamGb: number;
  cpuCount: number;
  /** OS + apps reserve held back from the disk. Defaults to DEFAULT_DISK_RESERVE_GB. */
  reserveGb?: number;
}

export interface VmSizingPlan {
  tier: SizingTier;
  diskGb: number;
  ramGb: number;
  cpuCores: number;
  reserveGb: number;
  vmBudgetGb: number;
  diskKnown: boolean;
  // Echo of the detected hardware so the UI can show "we saw X, recommend Y".
  totalDiskGb: number;
  freeDiskGb: number;
  totalRamGb: number;
  cpuCount: number;
  notes: string[];
}

function clampInt(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

/** Resolve the OS+apps reserve from the environment, clamped to the disk size. */
export function resolveReserveGb(totalDiskGb: number): number {
  const raw = Number(process.env["FOULFOX_DISK_RESERVE_GB"]);
  const ceiling = totalDiskGb > 0 ? totalDiskGb : 4096;
  if (!Number.isFinite(raw) || raw < 0) return Math.min(DEFAULT_DISK_RESERVE_GB, ceiling);
  return Math.min(Math.floor(raw), ceiling);
}

function diskTier(totalDiskGb: number): SizingTier {
  if (totalDiskGb <= 0) return "unknown";
  if (totalDiskGb < 160) return "compact";
  if (totalDiskGb < 640) return "standard";
  if (totalDiskGb < 1100) return "large";
  return "xlarge";
}

// Target VM disk by physical-disk class (before budget clamping).
function diskTarget(totalDiskGb: number): number {
  if (totalDiskGb < 160) return 64;   // ~128GB micro PC
  if (totalDiskGb < 320) return 128;  // ~256GB
  if (totalDiskGb < 640) return 200;  // ~512GB
  if (totalDiskGb < 1100) return 384; // ~1TB
  return 512;                          // >1TB — stretch its legs
}

function recommendRamGb(totalRamGb: number): number {
  if (totalRamGb <= 0) return FALLBACK_RAM_GB;
  const cap = Math.max(2, Math.floor(totalRamGb * 0.5)); // never take >50% of host
  const target =
    totalRamGb <= 8 ? 4 : totalRamGb <= 16 ? 8 : totalRamGb <= 32 ? 16 : 24;
  return clampInt(Math.min(target, cap), 2, cap);
}

function recommendCpuCores(cpuCount: number): number {
  if (cpuCount <= 0) return FALLBACK_CPU;
  // Give both cores on a dual-core box; otherwise leave one for the host, cap 8.
  const cap = cpuCount <= 2 ? cpuCount : Math.min(cpuCount - 1, 8);
  return Math.max(1, cap);
}

/**
 * Compute a hardware-appropriate sizing recommendation for the primary VM.
 * Pure: same inputs always yield the same plan.
 */
export function recommendVmSizing(inputs: SizingInputs): VmSizingPlan {
  const totalDiskGb = Math.max(0, Math.floor(inputs.totalDiskGb || 0));
  const freeDiskGb = Math.max(0, Math.floor(inputs.freeDiskGb || 0));
  const totalRamGb = Math.max(0, Math.floor(inputs.totalRamGb || 0));
  const cpuCount = Math.max(0, Math.floor(inputs.cpuCount || 0));
  const reserveGb = inputs.reserveGb ?? DEFAULT_DISK_RESERVE_GB;

  const diskKnown = totalDiskGb > 0;
  const vmBudgetGb = diskKnown ? Math.max(0, totalDiskGb - reserveGb) : 0;
  const ramGb = recommendRamGb(totalRamGb);
  const cpuCores = recommendCpuCores(cpuCount);
  const tier = diskTier(totalDiskGb);
  const notes: string[] = [];

  let diskGb: number;
  if (!diskKnown) {
    diskGb = FALLBACK_DISK_GB;
    notes.push(
      `Disk size could not be detected — using a safe ${FALLBACK_DISK_GB}GB default for the Windows VM.`,
    );
  } else if (vmBudgetGb < WIN_MIN_DISK_GB) {
    // Not enough room for a comfortable Windows VM after the reserve.
    diskGb = clampInt(vmBudgetGb, 8, Math.max(8, vmBudgetGb));
    notes.push(
      `Only ${vmBudgetGb}GB is available for VMs after holding ${reserveGb}GB back for FoulFox OS + your apps — too small for a comfortable Windows VM. Use a larger drive or lower the reserve.`,
    );
  } else {
    const target = diskTarget(totalDiskGb);
    const budgetCap = Math.floor(vmBudgetGb * PRIMARY_VM_BUDGET_FRACTION);
    diskGb = clampInt(Math.min(target, budgetCap), WIN_COMFORTABLE_DISK_GB, vmBudgetGb);
    notes.push(
      `Detected a ${totalDiskGb}GB drive; holding ${reserveGb}GB back for FoulFox OS + your apps leaves a ${vmBudgetGb}GB VM budget.`,
    );
    notes.push(`Allocating ${diskGb}GB to the Windows VM (${tier} tier).`);
  }

  notes.push(
    `RAM: ${ramGb}GB to the VM${totalRamGb > 0 ? ` of ${totalRamGb}GB host` : ""} (host keeps the rest). CPU: ${cpuCores}${cpuCount > 0 ? ` of ${cpuCount}` : ""} cores.`,
  );

  return {
    tier,
    diskGb,
    ramGb,
    cpuCores,
    reserveGb,
    vmBudgetGb,
    diskKnown,
    totalDiskGb,
    freeDiskGb,
    totalRamGb,
    cpuCount,
    notes,
  };
}

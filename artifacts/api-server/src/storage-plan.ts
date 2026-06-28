// ── first-run sizing CLI ──────────────────────────────────────────────────────
// A tiny standalone entry (bundled to dist/storage-plan.mjs) so the appliance's
// foulfox-first-run can compute hardware-adaptive VM sizing BEFORE it creates the
// qcow2 — using the exact same planner as the HTTP API (single source of truth).
//
//   node storage-plan.mjs          → shell-evalable: FOULFOX_PLAN_DISK_GB=64 ...
//   node storage-plan.mjs --json   → the full VmSizingPlan as JSON
//
// first-run sources the shell form and falls back to its static env defaults if
// this CLI is missing or errors, so adaptive sizing can never block boot.

import { detectHostCapabilities } from "./lib/vm-capabilities";
import { recommendVmSizing, resolveReserveGb } from "./lib/storage-sizing";

async function main(): Promise<void> {
  const caps = await detectHostCapabilities();
  const reserveGb = resolveReserveGb(caps.totalDiskGb);
  const plan = recommendVmSizing({
    totalDiskGb: caps.totalDiskGb,
    freeDiskGb: caps.freeDiskGb,
    totalRamGb: caps.totalRamGb,
    cpuCount: caps.cpuCount,
    reserveGb,
  });

  if (process.argv.includes("--json")) {
    process.stdout.write(JSON.stringify(plan) + "\n");
    return;
  }

  process.stdout.write(
    [
      `FOULFOX_PLAN_DISK_GB=${plan.diskGb}`,
      `FOULFOX_PLAN_RAM_GB=${plan.ramGb}`,
      `FOULFOX_PLAN_CPU_CORES=${plan.cpuCores}`,
      `FOULFOX_PLAN_TIER=${plan.tier}`,
      `FOULFOX_PLAN_DISK_KNOWN=${plan.diskKnown ? 1 : 0}`,
      "",
    ].join("\n"),
  );
}

main().catch((err) => {
  process.stderr.write(`storage-plan failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

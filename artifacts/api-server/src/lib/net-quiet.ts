// ── Post-boot internet quiet period ───────────────────────────────────────────
// On the FoulFox OS appliance, all outbound-internet activity (GitHub release
// probes, update-manifest fetches, build dispatches, update applies) is held
// back for the first few minutes after power-on. Boot-time WiFi is often still
// settling on real hardware, and half-up networking turns these probes into
// slow timeouts and misleading "unreachable" errors while the machine is still
// starting local services. Local-only traffic (Ollama, the agent, VM bridges)
// is never affected.
//
// The window is measured from SYSTEM boot (os.uptime()), not process start, so
// a service restart mid-session doesn't re-arm the quiet period. Dev
// workspaces (no appliance marker) are never quiet. Tunable via
// FOULFOX_NET_QUIET_SECONDS in foulfox.env; 0 disables.
import fs from "fs";
import os from "os";

const APPLIANCE_MARKER = "/usr/local/bin/foulfox-first-run";
const DEFAULT_QUIET_SECONDS = 180;

function quietWindowSeconds(): number {
  const raw = process.env["FOULFOX_NET_QUIET_SECONDS"]?.trim();
  if (raw === undefined || raw === "") return DEFAULT_QUIET_SECONDS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_QUIET_SECONDS;
}

/** Seconds of quiet period remaining; 0 when internet activity is allowed. */
export function netQuietRemaining(): number {
  if (!fs.existsSync(APPLIANCE_MARKER)) return 0; // dev workspace: never quiet
  const remaining = quietWindowSeconds() - os.uptime();
  return remaining > 0 ? Math.ceil(remaining) : 0;
}

/** Human message for UIs while the quiet period is active. */
export function netQuietMessage(remaining: number): string {
  return `Starting up — internet activity is paused for the first ${quietWindowSeconds()} seconds after boot (about ${remaining}s left).`;
}

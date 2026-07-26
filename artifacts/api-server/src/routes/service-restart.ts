import { Router, type IRouter, type Request, type Response } from "express";
import { execFile } from "child_process";
import { existsSync } from "fs";
import { logger } from "../lib/logger";

// ── Service restart API ────────────────────────────────────────────────────────
// Lets the shell UI restart installation-related services after WiFi connects.
// On the physical appliance these are systemd units; the sudoers rule in
// /etc/sudoers.d/foulfox-service-restart grants the passwordless sudo needed.
//
// Routes (all under /api, protected by localhostOnly + requireStateChangeToken):
//   POST /api/os/restart-services   — restart Odysseus + re-run first-run provisioner

const router: IRouter = Router();

function sudoRun(cmd: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; stderr: string }> {
  return new Promise((resolve) => {
    execFile("sudo", ["-n", cmd, ...args], { timeout: timeoutMs }, (err, _stdout, stderr) => {
      if (err) {
        resolve({ ok: false, stderr: stderr || err.message });
      } else {
        resolve({ ok: true, stderr: "" });
      }
    });
  });
}

// Like sudoRun but keeps stdout, and treats a non-zero exit as informational —
// `systemctl status` exits 3 for a stopped unit yet its output is exactly what
// the diagnostics view needs.
function sudoCapture(cmd: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile("sudo", ["-n", cmd, ...args], { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (_err, stdout, stderr) => {
      resolve({ stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });
}

router.post("/os/restart-services", async (_req: Request, res: Response) => {
  logger.info("restart-services: requested");

  const results: Record<string, { ok: boolean; stderr: string }> = {};

  // Restart the local AI runtime first (Ollama) so the agent finds a working
  // model endpoint when it comes back up, then the Odysseus agent itself.
  // Both are independent units — restarting them does not touch the api-server.
  const ollama = await sudoRun("systemctl", ["restart", "ollama"], 15_000);
  results["ollama"] = ollama;
  if (!ollama.ok) {
    logger.warn({ stderr: ollama.stderr }, "restart-services: ollama restart failed (may not be on appliance)");
  }

  const odysseus = await sudoRun("systemctl", ["restart", "odysseus-service"], 15_000);
  results["odysseus-service"] = odysseus;
  if (!odysseus.ok) {
    logger.warn({ stderr: odysseus.stderr }, "restart-services: odysseus-service restart failed (may not be on appliance)");
  }

  // Re-run the idempotent first-run provisioner DIRECTLY (not via
  // `systemctl restart foulfox-prepare`): foulfox-api Requires= that unit, so
  // restarting it makes systemd stop the api-server too and never start it
  // again — killing the shell the user is looking at ("127.0.0.1 refused to
  // connect"). The script sources its own env and is safe to re-run; it can
  // now re-download missing driver ISOs since the network is available.
  // Run it in the background so the response returns immediately (the
  // download can take minutes) — report it as started, not finished.
  // Only claim success when the script actually exists (i.e. we are on the
  // appliance); in the dev workspace this keeps the UI toast honest.
  const FIRST_RUN = "/usr/local/bin/foulfox-first-run";
  if (existsSync(FIRST_RUN)) {
    results["foulfox-first-run"] = { ok: true, stderr: "started in background" };
    sudoRun(FIRST_RUN, [], 900_000).then((r) => {
      if (!r.ok) {
        logger.warn({ stderr: r.stderr }, "restart-services: foulfox-first-run failed");
      } else {
        logger.info("restart-services: foulfox-first-run completed");
      }
    });
  } else {
    results["foulfox-first-run"] = { ok: false, stderr: "provisioner not present (not on appliance)" };
    logger.info("restart-services: foulfox-first-run not present, skipping (dev environment)");
  }

  const anyOk = Object.values(results).some((r) => r.ok);
  logger.info({ results }, "restart-services: done (provisioner running in background)");
  res.json({ ok: anyOk, results });
});

// ── Appliance diagnostics ─────────────────────────────────────────────────────
// Read-only view of WHY the agent is offline: unit status + recent journal for
// the Odysseus agent, the first-run provisioner, and Ollama. The exact argument
// lists below are pinned in /etc/sudoers.d/foulfox-service-restart — keep them
// byte-identical or sudo -n will refuse. In the dev workspace (no provisioner
// script) we report appliance:false so the UI can say diagnostics aren't
// available here instead of showing empty sections.
router.get("/os/diagnostics", async (_req: Request, res: Response) => {
  const FIRST_RUN = "/usr/local/bin/foulfox-first-run";
  if (!existsSync(FIRST_RUN)) {
    res.json({ appliance: false, sections: [] });
    return;
  }

  const sections: Array<{ title: string; text: string }> = [];

  const status = await sudoCapture(
    "systemctl", ["status", "odysseus-service", "foulfox-prepare", "ollama", "--no-pager", "-l"], 10_000);
  sections.push({ title: "Service status", text: (status.stdout || status.stderr).trim() });

  const agentLog = await sudoCapture(
    "journalctl", ["-u", "odysseus-service", "-n", "120", "--no-pager", "-o", "cat"], 10_000);
  sections.push({ title: "FoulFox agent log (odysseus-service)", text: (agentLog.stdout || agentLog.stderr).trim() });

  const prepLog = await sudoCapture(
    "journalctl", ["-u", "foulfox-prepare", "-n", "60", "--no-pager", "-o", "cat"], 10_000);
  sections.push({ title: "First-run provisioner log (foulfox-prepare)", text: (prepLog.stdout || prepLog.stderr).trim() });

  const ollamaLog = await sudoCapture(
    "journalctl", ["-u", "ollama", "-n", "40", "--no-pager", "-o", "cat"], 10_000);
  sections.push({ title: "Local AI log (ollama)", text: (ollamaLog.stdout || ollamaLog.stderr).trim() });

  res.json({ appliance: true, sections });
});

export default router;

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

router.post("/os/restart-services", async (_req: Request, res: Response) => {
  logger.info("restart-services: requested");

  const results: Record<string, { ok: boolean; stderr: string }> = {};

  // Restart the Odysseus AI service (independent unit — does not touch us).
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

export default router;

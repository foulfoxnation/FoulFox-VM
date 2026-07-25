import { Router, type IRouter, type Request, type Response } from "express";
import { execFile } from "child_process";
import { logger } from "../lib/logger";

// ── Service restart API ────────────────────────────────────────────────────────
// Lets the shell UI restart installation-related services after WiFi connects.
// On the physical appliance these are systemd units; the sudoers rule in
// /etc/sudoers.d/foulfox-service-restart grants the passwordless sudo needed.
//
// Routes (all under /api, protected by localhostOnly + requireStateChangeToken):
//   POST /api/os/restart-services   — restart Odysseus + re-run first-run provisioner

const router: IRouter = Router();

function sudoSystemctl(args: string[]): Promise<{ ok: boolean; stderr: string }> {
  return new Promise((resolve) => {
    execFile("sudo", ["-n", "systemctl", ...args], { timeout: 15_000 }, (err, _stdout, stderr) => {
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

  // Re-run the idempotent first-run provisioner first so it can re-download
  // missing driver ISOs now that network is available, then restart Odysseus.
  const prepare = await sudoSystemctl(["restart", "foulfox-prepare"]);
  results["foulfox-prepare"] = prepare;
  if (!prepare.ok) {
    logger.warn({ stderr: prepare.stderr }, "restart-services: foulfox-prepare restart failed (may not be on appliance)");
  }

  const odysseus = await sudoSystemctl(["restart", "odysseus-service"]);
  results["odysseus-service"] = odysseus;
  if (!odysseus.ok) {
    logger.warn({ stderr: odysseus.stderr }, "restart-services: odysseus-service restart failed (may not be on appliance)");
  }

  const anyOk = Object.values(results).some((r) => r.ok);
  logger.info({ results }, "restart-services: done");
  res.json({ ok: anyOk, results });
});

export default router;

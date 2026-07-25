import { Router, type IRouter, type Request, type Response } from "express";
import { execFile } from "child_process";
import { logger } from "../lib/logger";

// ── Power API ──────────────────────────────────────────────────────────────────
// Triggers host power actions (shutdown / restart / sleep) via systemctl.
// All commands run as root via sudo; sudoers entry restricts to these three.
//
// Routes (all under /api/power, protected by localhostOnly + requireStateChangeToken in app.ts):
//   POST /api/power/shutdown
//   POST /api/power/restart
//   POST /api/power/sleep

const router: IRouter = Router();

const ACTIONS: Record<string, string[]> = {
  shutdown: ["sudo", "systemctl", "poweroff"],
  restart:  ["sudo", "systemctl", "reboot"],
  sleep:    ["sudo", "systemctl", "suspend"],
};

function runPowerAction(action: string, res: Response) {
  const cmd = ACTIONS[action];
  if (!cmd) {
    res.status(400).json({ error: "Unknown power action" });
    return;
  }

  logger.info({ action }, "power action requested");

  // Respond immediately — the machine may go down before we could reply otherwise.
  res.json({ ok: true, action });

  const [bin, ...args] = cmd;
  execFile(bin, args, (err) => {
    if (err) logger.error({ action, err }, "power action failed");
  });
}

router.post("/api/power/shutdown", (req: Request, res: Response) => {
  runPowerAction("shutdown", res);
});

router.post("/api/power/restart", (req: Request, res: Response) => {
  runPowerAction("restart", res);
});

router.post("/api/power/sleep", (req: Request, res: Response) => {
  runPowerAction("sleep", res);
});

export default router;

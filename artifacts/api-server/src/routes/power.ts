import { Router, type IRouter, type Request, type Response } from "express";
import { execFile } from "child_process";
import { logger } from "../lib/logger";

// ── Power API ──────────────────────────────────────────────────────────────────
// Triggers host power actions (shutdown / restart / sleep) via systemctl.
// All commands run as root via sudo; sudoers entry restricts to these commands.
//
// Design notes (learned on real hardware):
// - `sudo` is always invoked with `-n` so a missing/ignored sudoers rule fails
//   fast instead of hanging forever on a password prompt nobody can answer.
// - logind "block" inhibitors (NetworkManager, packagekit, a stuck session…)
//   make plain `systemctl poweroff` refuse; the `-i` variant ignores them, so
//   we try the plain form first, then `-i`.
// - We wait for the command result (they exit in well under a second after
//   scheduling the action) and report REAL success/failure to the shell, so
//   the UI can no longer show "Shutting down…" when nothing happened.
//
// Routes (all under /api/power, protected by localhostOnly + requireStateChangeToken in app.ts):
//   POST /api/power/shutdown
//   POST /api/power/restart
//   POST /api/power/sleep

const router: IRouter = Router();

const ACTIONS: Record<string, string[][]> = {
  shutdown: [
    ["sudo", "-n", "systemctl", "poweroff"],
    ["sudo", "-n", "systemctl", "-i", "poweroff"],
  ],
  restart: [
    ["sudo", "-n", "systemctl", "reboot"],
    ["sudo", "-n", "systemctl", "-i", "reboot"],
  ],
  sleep: [
    ["sudo", "-n", "systemctl", "suspend"],
    ["sudo", "-n", "systemctl", "-i", "suspend"],
  ],
};

function tryCommand(cmd: string[]): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const [bin, ...args] = cmd;
    execFile(bin, args, { timeout: 10_000 }, (err, _stdout, stderr) => {
      if (err) {
        const detail = (stderr || err.message || "").trim().slice(0, 400);
        resolve({ ok: false, error: detail || "command failed" });
      } else {
        resolve({ ok: true });
      }
    });
  });
}

async function runPowerAction(action: string, res: Response): Promise<void> {
  const candidates = ACTIONS[action];
  if (!candidates) {
    res.status(400).json({ error: "Unknown power action" });
    return;
  }

  logger.info({ action }, "power action requested");

  let lastError = "";
  for (const cmd of candidates) {
    const r = await tryCommand(cmd);
    if (r.ok) {
      logger.info({ action, cmd: cmd.join(" ") }, "power action accepted");
      res.json({ ok: true, action });
      return;
    }
    lastError = r.error || "command failed";
    logger.error({ action, cmd: cmd.join(" "), error: lastError }, "power command failed");
  }

  res.status(500).json({ ok: false, action, error: lastError });
}

router.post("/power/shutdown", (_req: Request, res: Response) => {
  void runPowerAction("shutdown", res);
});

router.post("/power/restart", (_req: Request, res: Response) => {
  void runPowerAction("restart", res);
});

router.post("/power/sleep", (_req: Request, res: Response) => {
  void runPowerAction("sleep", res);
});

export default router;

import { Router, type IRouter, type Request, type Response } from "express";
import { execFile } from "child_process";
import { promisify } from "util";
import { commandExists, unavailable } from "../lib/peripherals";

const router: IRouter = Router();
const execFileAsync = promisify(execFile);

// ── Open-window tray (appliance) ─────────────────────────────────────────────
// The kiosk shell is fullscreen, so a minimized Firefox/Discord window has no
// visible affordance to bring it back. These routes let the shell render a
// tray of the open X windows and re-activate one on click.
//
//   GET  /windows           → { available, windows: [{ id, cls, title }] }
//   POST /windows/activate  → { id } raises + unminimizes the window
//   POST /windows/minimize  → { id } iconifies the window
//
// Backed by wmctrl (baked into the OS image). Honest failure in dev: no
// wmctrl / no X display → available:false, actions 503.

const WINDOW_ID_RE = /^0x[0-9a-fA-F]{1,16}$/;

// Windows that are part of the kiosk chrome itself — never shown in the tray.
const HIDDEN_CLASS_FRAGMENTS = ["foulfoxkiosk", "foulfoxsplash"];

function displayEnv(): NodeJS.ProcessEnv {
  return { ...process.env, DISPLAY: process.env["DISPLAY"] ?? ":0" };
}

async function trayAvailable(): Promise<boolean> {
  if (!(await commandExists("wmctrl"))) return false;
  const { existsSync } = await import("fs");
  return !!process.env["DISPLAY"] || existsSync("/tmp/.X11-unix/X0");
}

router.get("/windows", async (_req: Request, res: Response) => {
  if (!(await trayAvailable())) {
    res.json({ available: false, windows: [] });
    return;
  }
  try {
    // -l list, -x include WM_CLASS. Format per line:
    //   0x04000007  0 navigator.Firefox-esr  hostname  Page title …
    const { stdout } = await execFileAsync("wmctrl", ["-lx"], {
      env: displayEnv(),
      timeout: 5000,
    });
    const windows: Array<{ id: string; cls: string; title: string }> = [];
    for (const line of stdout.split("\n")) {
      const m = line.match(/^(0x[0-9a-fA-F]+)\s+(-?\d+)\s+(\S+)\s+\S+\s*(.*)$/);
      if (!m) continue;
      const [, id, desktop, cls, title] = m;
      // desktop === "-1" → panels/docks; skip. Skip our own kiosk windows.
      if (desktop === "-1") continue;
      const clsLower = cls.toLowerCase();
      if (HIDDEN_CLASS_FRAGMENTS.some((f) => clsLower.includes(f))) continue;
      windows.push({ id, cls, title: title.trim() });
    }
    res.json({ available: true, windows });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

async function windowAction(req: Request, res: Response, args: (id: string) => string[]) {
  const id = typeof req.body?.id === "string" ? req.body.id : "";
  if (!WINDOW_ID_RE.test(id)) {
    res.status(400).json({ error: "Expected { id: '0x…' } (a window id from GET /windows)." });
    return;
  }
  if (!(await trayAvailable())) {
    res.status(503).json(unavailable("Window control is only available on the booted FoulFox OS appliance."));
    return;
  }
  try {
    await execFileAsync("wmctrl", args(id), { env: displayEnv(), timeout: 5000 });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
}

// Raise + focus (unminimizes if iconified).
router.post("/windows/activate", (req, res) => windowAction(req, res, (id) => ["-i", "-a", id]));

// Iconify (minimize) — lets the tray also send a window away.
router.post("/windows/minimize", (req, res) =>
  windowAction(req, res, (id) => ["-i", "-r", id, "-b", "add,hidden"]),
);

export default router;

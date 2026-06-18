import { Router, type IRouter, type Request, type Response } from "express";
import { run, commandExists, serviceActive, unavailable } from "../lib/peripherals";

const router: IRouter = Router();

// ── Bluetooth (pairing + management) ──────────────────────────────────────────
// Drives BlueZ through `bluetoothctl`, which accepts a single command per
// invocation and exits — so every call is a clean argv array (no interactive
// session, no shell). MAC addresses are validated against a strict pattern
// before they ever reach a command.
//
// On the appliance bluetooth.service is enabled and the foulfox user can talk to
// org.bluez (see the D-Bus policy in the OS image). In dev bluetoothctl is
// absent, so capabilities reports unavailable.

const MAC = /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/;

async function btReady(): Promise<{ available: boolean; reason: string }> {
  if (!(await commandExists("bluetoothctl"))) {
    return { available: false, reason: "bluetoothctl not installed (available on the booted FoulFox OS appliance)." };
  }
  if (!(await serviceActive("bluetooth"))) {
    return { available: false, reason: "The Bluetooth service is not running (available on the booted FoulFox OS appliance)." };
  }
  return { available: true, reason: "" };
}

function parseDevices(stdout: string): Array<{ mac: string; name: string }> {
  // "Device AA:BB:CC:DD:EE:FF My Headphones"
  return stdout
    .split("\n")
    .map((l) => l.match(/^Device\s+([0-9A-Fa-f:]{17})\s+(.*)$/))
    .filter((m): m is RegExpMatchArray => !!m)
    .map((m) => ({ mac: m[1].toUpperCase(), name: m[2].trim() || m[1] }));
}

router.get("/bluetooth/capabilities", async (_req: Request, res: Response) => {
  const bluetoothctl = await commandExists("bluetoothctl");
  const active = bluetoothctl ? await serviceActive("bluetooth") : false;
  res.json({ available: bluetoothctl && active, bluetoothctl, service: active });
});

// Adapter state + known/paired devices.
router.get("/bluetooth/status", async (_req: Request, res: Response) => {
  const ready = await btReady();
  if (!ready.available) { res.status(503).json(unavailable(ready.reason)); return; }

  const show = await run("bluetoothctl", ["show"]);
  const powered = /Powered:\s*yes/i.test(show.stdout);
  const discovering = /Discovering:\s*yes/i.test(show.stdout);
  const nameMatch = show.stdout.match(/Name:\s*(.+)/);
  const adapter = nameMatch ? nameMatch[1].trim() : null;

  const all = await run("bluetoothctl", ["devices"]);
  const paired = await run("bluetoothctl", ["devices", "Paired"]);
  const pairedSet = new Set(parseDevices(paired.stdout).map((d) => d.mac));
  const devices = parseDevices(all.stdout).map((d) => ({ ...d, paired: pairedSet.has(d.mac) }));

  res.json({ available: true, powered, discovering, adapter, devices });
});

// Power the adapter on/off (POST — shell token via app.ts).
router.post("/bluetooth/power", async (req: Request, res: Response) => {
  const ready = await btReady();
  if (!ready.available) { res.status(503).json(unavailable(ready.reason)); return; }
  const on = req.body?.on !== false;
  const r = await run("bluetoothctl", ["power", on ? "on" : "off"]);
  if (!r.ok) { res.status(400).json({ error: (r.stderr || r.stdout || "power failed").trim() }); return; }
  res.json({ ok: true, powered: on });
});

// Discover devices for a bounded window, then return what was found.
router.post("/bluetooth/scan", async (req: Request, res: Response) => {
  const ready = await btReady();
  if (!ready.available) { res.status(503).json(unavailable(ready.reason)); return; }
  const seconds = Math.min(30, Math.max(3, Number(req.body?.seconds) || 10));
  // `--timeout N scan on` runs discovery for N seconds then exits.
  await run("bluetoothctl", ["--timeout", String(seconds), "scan", "on"], { timeoutMs: (seconds + 8) * 1000 });
  const all = await run("bluetoothctl", ["devices"]);
  res.json({ ok: true, devices: parseDevices(all.stdout) });
});

// pair / connect / trust / remove — each takes a validated MAC.
for (const action of ["pair", "connect", "trust", "remove"] as const) {
  router.post(`/bluetooth/${action}`, async (req: Request, res: Response) => {
    const ready = await btReady();
    if (!ready.available) { res.status(503).json(unavailable(ready.reason)); return; }
    const mac = String(req.body?.mac || "").trim();
    if (!MAC.test(mac)) { res.status(400).json({ error: "A valid MAC address is required" }); return; }
    const r = await run("bluetoothctl", [action, mac], { timeoutMs: 30000 });
    if (!r.ok) { res.status(400).json({ error: (r.stderr || r.stdout || `${action} failed`).trim() }); return; }
    res.json({ ok: true, message: `${action} ${mac} ok` });
  });
}

export default router;

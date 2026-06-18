import { Router, type IRouter, type Request, type Response } from "express";
import { run, commandExists, serviceActive, parseNmcliLine, unavailable } from "../lib/peripherals";

const router: IRouter = Router();

// ── Networking (ethernet + wifi) ──────────────────────────────────────────────
// Wired networking auto-DHCPs via NetworkManager with no UI needed; this group
// drives wifi (scan / connect / forget) and reports link status. Everything goes
// through `nmcli` with argv arrays so an SSID/password can't inject arguments.
//
// On the booted appliance NetworkManager is enabled and the foulfox user can
// control it (see the polkit rule in the OS image). In the dev workspace nmcli
// is absent, so capabilities reports unavailable and the panel says so.

async function nmcliReady(): Promise<{ available: boolean; reason: string }> {
  if (!(await commandExists("nmcli"))) {
    return { available: false, reason: "nmcli not installed (available on the booted FoulFox OS appliance)." };
  }
  if (!(await serviceActive("NetworkManager"))) {
    return { available: false, reason: "NetworkManager is not running (available on the booted FoulFox OS appliance)." };
  }
  return { available: true, reason: "" };
}

router.get("/network/capabilities", async (_req: Request, res: Response) => {
  const nmcli = await commandExists("nmcli");
  const active = nmcli ? await serviceActive("NetworkManager") : false;
  res.json({ available: nmcli && active, nmcli, networkManager: active });
});

// Devices + current wifi connection.
router.get("/network/status", async (_req: Request, res: Response) => {
  const ready = await nmcliReady();
  if (!ready.available) { res.status(503).json(unavailable(ready.reason)); return; }

  const dev = await run("nmcli", ["-t", "-f", "DEVICE,TYPE,STATE,CONNECTION", "device"]);
  const devices = dev.stdout
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [device, type, state, connection] = parseNmcliLine(l);
      return { device, type, state, connection: connection || null };
    })
    .filter((d) => d.type !== "loopback");

  // Active wifi (if any): the row with IN-USE = '*'.
  const wifi = await run("nmcli", ["-t", "-f", "IN-USE,SSID,SIGNAL", "device", "wifi"]);
  let active: { ssid: string; signal: number } | null = null;
  for (const l of wifi.stdout.split("\n").filter(Boolean)) {
    const [inUse, ssid, signal] = parseNmcliLine(l);
    if (inUse === "*" && ssid) { active = { ssid, signal: parseInt(signal, 10) || 0 }; break; }
  }

  res.json({ available: true, devices, wifi: active });
});

// Scan for wifi networks (read-only — a rescan is harmless, so this is a GET).
router.get("/network/wifi/scan", async (_req: Request, res: Response) => {
  const ready = await nmcliReady();
  if (!ready.available) { res.status(503).json(unavailable(ready.reason)); return; }

  const r = await run(
    "nmcli",
    ["-t", "-f", "IN-USE,SSID,SIGNAL,SECURITY", "device", "wifi", "list", "--rescan", "yes"],
    { timeoutMs: 25000 },
  );
  if (!r.ok && !r.stdout) {
    res.status(500).json({ error: r.stderr || r.error || "Wifi scan failed" });
    return;
  }
  // Dedup by SSID, keeping the strongest signal; drop hidden (empty) SSIDs.
  const seen = new Map<string, { ssid: string; signal: number; security: string; inUse: boolean }>();
  for (const l of r.stdout.split("\n").filter(Boolean)) {
    const [inUse, ssid, signalStr, security] = parseNmcliLine(l);
    if (!ssid) continue;
    const signal = parseInt(signalStr, 10) || 0;
    const prev = seen.get(ssid);
    if (!prev || signal > prev.signal) {
      seen.set(ssid, { ssid, signal, security: security || "", inUse: inUse === "*" });
    }
  }
  const networks = [...seen.values()].sort((a, b) => b.signal - a.signal);
  res.json({ available: true, networks });
});

// Connect to a wifi network (POST — requires the shell token via app.ts).
router.post("/network/wifi/connect", async (req: Request, res: Response) => {
  const ready = await nmcliReady();
  if (!ready.available) { res.status(503).json(unavailable(ready.reason)); return; }

  const ssid = typeof req.body?.ssid === "string" ? req.body.ssid : "";
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  if (!ssid) { res.status(400).json({ error: "Missing ssid" }); return; }

  const args = ["device", "wifi", "connect", ssid];
  if (password) args.push("password", password);
  const r = await run("nmcli", args, { timeoutMs: 45000 });
  if (!r.ok) {
    res.status(400).json({ error: (r.stderr || r.stdout || r.error || "Connection failed").trim() });
    return;
  }
  res.json({ ok: true, message: `Connected to ${ssid}` });
});

// Forget a saved network (POST — requires the shell token via app.ts).
router.post("/network/wifi/forget", async (req: Request, res: Response) => {
  const ready = await nmcliReady();
  if (!ready.available) { res.status(503).json(unavailable(ready.reason)); return; }

  const ssid = typeof req.body?.ssid === "string" ? req.body.ssid : "";
  if (!ssid) { res.status(400).json({ error: "Missing ssid" }); return; }

  const r = await run("nmcli", ["connection", "delete", "id", ssid], { timeoutMs: 15000 });
  if (!r.ok) {
    res.status(400).json({ error: (r.stderr || r.error || "Forget failed").trim() });
    return;
  }
  res.json({ ok: true, message: `Forgot ${ssid}` });
});

export default router;

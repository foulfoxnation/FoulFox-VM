import { Router, type IRouter, type Request, type Response } from "express";
import fs from "fs";
import { run, commandExists, unavailable } from "../lib/peripherals";
import { getVm, getRuntime } from "../lib/vm-registry";
import { qmpExecute } from "../lib/vm-qmp";

const router: IRouter = Router();

// ── USB devices (host hotplug + VM passthrough) ───────────────────────────────
// USB storage hotplug on the host is handled by the kernel + udisks2 (no code
// here). This group lists host USB devices (`lsusb`) and attaches/detaches one
// to a running VM via QEMU's QMP monitor (`device_add/del usb-host`) on the
// qemu-xhci controller the launcher already adds. The udev rule in the OS image
// gives the foulfox user (plugdev) the device-node access QEMU needs.
//
// In dev there is no KVM so no VM is ever "running" and attach fails honestly;
// `lsusb` may or may not be present (capabilities reports which).

const DEC3 = /^\d{1,3}$/;

router.get("/usb/capabilities", async (_req: Request, res: Response) => {
  const lsusb = await commandExists("lsusb");
  const devBusUsb = fs.existsSync("/dev/bus/usb");
  res.json({ available: lsusb, lsusb, devBusUsb });
});

// List host USB devices.
router.get("/usb/list", async (_req: Request, res: Response) => {
  if (!(await commandExists("lsusb"))) {
    res.status(503).json(unavailable("lsusb not installed (available on the booted FoulFox OS appliance)."));
    return;
  }
  const r = await run("lsusb", []);
  if (!r.ok && !r.stdout) {
    res.status(500).json({ error: r.stderr || r.error || "lsusb failed" });
    return;
  }
  // "Bus 001 Device 004: ID 046d:c52b Logitech, Inc. Unifying Receiver"
  const re = /^Bus (\d+) Device (\d+): ID ([0-9a-fA-F]{4}):([0-9a-fA-F]{4})\s*(.*)$/;
  const devices = r.stdout
    .split("\n")
    .map((l) => l.match(re))
    .filter((m): m is RegExpMatchArray => !!m)
    .map((m) => ({
      bus: m[1],
      device: m[2],
      vendorId: m[3].toLowerCase(),
      productId: m[4].toLowerCase(),
      name: m[5].trim() || `${m[3]}:${m[4]}`,
      isHub: /hub$/i.test(m[5].trim()),
    }));
  res.json({ available: true, devices });
});

// Attach a host USB device to a running VM (POST — shell token via app.ts).
router.post("/usb/attach", async (req: Request, res: Response) => {
  const vmId = typeof req.body?.vmId === "string" ? req.body.vmId : "";
  const bus = String(req.body?.bus || "");
  const device = String(req.body?.device || "");
  if (!vmId || !DEC3.test(bus) || !DEC3.test(device)) {
    res.status(400).json({ error: "vmId, bus and device (from the USB list) are required" });
    return;
  }
  const vm = getVm(vmId);
  if (!vm) { res.status(404).json({ error: "VM not found" }); return; }
  if (getRuntime(vmId).state !== "running") {
    res.status(409).json({ error: `'${vm.name}' is not running — start it before attaching a USB device.` });
    return;
  }

  // Address the exact connected device by host bus/address so two identical
  // vendor/product devices can't collide; the id carries the same coordinates
  // so a later detach is unambiguous.
  const id = `usb-${bus}-${device}`;
  const r = await qmpExecute(vm.ports.monitor, "device_add", {
    driver: "usb-host",
    id,
    hostbus: parseInt(bus, 10),
    hostaddr: parseInt(device, 10),
    bus: "xhci.0",
  });
  if (!r.ok) { res.status(502).json({ error: r.error || "QMP device_add failed" }); return; }
  res.json({ ok: true, id, message: `Attached USB device (bus ${bus} addr ${device}) to ${vm.name}` });
});

// Detach a previously-attached USB device (POST — shell token via app.ts).
router.post("/usb/detach", async (req: Request, res: Response) => {
  const vmId = typeof req.body?.vmId === "string" ? req.body.vmId : "";
  const bus = String(req.body?.bus || "");
  const device = String(req.body?.device || "");
  const explicitId = typeof req.body?.id === "string" ? req.body.id : "";
  const id = explicitId || (DEC3.test(bus) && DEC3.test(device) ? `usb-${bus}-${device}` : "");
  if (!vmId || !id) { res.status(400).json({ error: "vmId and the device id (or bus+device) are required" }); return; }

  const vm = getVm(vmId);
  if (!vm) { res.status(404).json({ error: "VM not found" }); return; }
  if (getRuntime(vmId).state !== "running") {
    res.status(409).json({ error: `'${vm.name}' is not running.` });
    return;
  }

  const r = await qmpExecute(vm.ports.monitor, "device_del", { id });
  if (!r.ok) { res.status(502).json({ error: r.error || "QMP device_del failed" }); return; }
  res.json({ ok: true, message: `Detached ${id} from ${vm.name}` });
});

export default router;

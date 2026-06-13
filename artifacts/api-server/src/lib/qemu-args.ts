import { type VmConfigData } from "./vm-state";

// Single source of truth for the QEMU argument vector, shared by the dev API
// (/vm/start, /vm/restart) and the FoulFox OS appliance.
//
// The default display mode is "headless", so the dev workspace produces exactly
// the same arguments as before. The appliance sets `displayMode` to "spice"
// (or "vnc") through its on-disk VM config so a fullscreen viewer can attach on
// the booted machine, and points `virtioIsoPath` at the virtio-win driver ISO.
//
// Security: SPICE/VNC bind to 127.0.0.1 only. USB host passthrough is opt-in
// per device ("vendorid:productid") and never blanket-grabs the host keyboard
// or mouse — doing so would steal input away from the appliance kiosk.
export function buildQemuArgs(config: VmConfigData): string[] {
  const args: string[] = [
    "-enable-kvm",
    "-m", `${config.ramGb}G`,
    "-smp", `cores=${config.cpuCores}`,
    "-cpu", "host",
    "-machine", "type=q35,accel=kvm",
    "-net", "nic,model=virtio",
    "-net", `user,hostfwd=tcp::${config.sshPort}-:22,hostfwd=tcp::3389-:3389`,
    "-device", "virtio-vga",
  ];

  const displayMode = config.displayMode ?? "headless";
  if (displayMode === "spice") {
    const spicePort = config.spicePort ?? 5930;
    args.push("-display", "none");
    args.push("-spice", `addr=127.0.0.1,port=${spicePort},disable-ticketing=on`);
    // SPICE guest-agent channel: clipboard sharing + dynamic resolution.
    args.push("-device", "virtio-serial-pci");
    args.push("-chardev", "spicevmc,id=spicechannel0,name=vdagent");
    args.push("-device", "virtserialport,chardev=spicechannel0,name=com.redhat.spice.0");
  } else if (displayMode === "vnc") {
    const vncDisplay = config.vncDisplay ?? 1;
    args.push("-vnc", `127.0.0.1:${vncDisplay}`);
  } else {
    args.push("-display", "none");
  }

  // A USB tablet provides an absolute pointer so the SPICE/VNC cursor tracks
  // correctly. Only attach it when there is actually a display to drive.
  if (displayMode !== "headless") {
    args.push("-device", "qemu-xhci,id=xhci");
    args.push("-device", "usb-tablet");
  }

  // Explicit USB host passthrough, one device at a time as "vendorid:productid".
  for (const dev of config.usbPassthrough ?? []) {
    const m = /^([0-9a-fA-F]{4}):([0-9a-fA-F]{4})$/.exec(dev.trim());
    if (m) {
      args.push("-device", `usb-host,vendorid=0x${m[1]},productid=0x${m[2]}`);
    }
  }

  // QEMU monitor on stdio for snapshot commands (savevm/loadvm/delvm).
  args.push("-monitor", "stdio");

  if (config.gpuPassthrough) {
    args.push("-device", `vfio-pci,host=${config.gpuPassthrough}`);
  }
  if (config.diskPath) {
    // IDE boot disk for universal bootability: a fresh Windows install boots
    // without pre-loaded virtio storage drivers. virtio NIC/VGA still apply.
    args.push("-hda", config.diskPath);
  }
  if (config.isoPath) {
    args.push("-cdrom", config.isoPath);
    if (!config.diskPath) args.push("-boot", "d");
  }
  // virtio-win driver ISO as a second optical drive so Windows can install the
  // virtio NIC/display/balloon drivers. `-cdrom` already claims ide index 2,
  // so attach this at ide index 3.
  if (config.virtioIsoPath) {
    args.push("-drive", `file=${config.virtioIsoPath},if=ide,index=3,media=cdrom,readonly=on`);
  }
  if (config.connectionMode === "serial") {
    args.push("-serial", "telnet:localhost:4444,server,nowait");
  }

  return args;
}

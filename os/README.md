# FoulFox OS

A bootable Linux appliance that turns any PC into a **FoulFox VM** machine: it
boots straight into the FoulFox shell (Odysseus AI agent + VM controls + a File
Explorer), brings up networking and drivers automatically, and runs a
user-supplied **Windows guest** in a hardware-accelerated KVM virtual machine —
fullscreen, with USB passthrough.

This directory contains the **image recipe** (everything needed to build the OS)
plus the build/flash/boot documentation. The image is authored here and built on
a Linux host; the appliance itself is validated by booting it on real hardware.

```
os/
├── README.md                     ← you are here
├── docs/
│   ├── build.md                  ← build the ISO on a Linux host
│   ├── flash.md                  ← write the ISO to USB (Windows / macOS / Linux)
│   ├── first-boot.md             ← boot + first-run guide (incl. frontload)
│   └── troubleshooting.md        ← networking, KVM, display, USB, drivers
├── scripts/
│   ├── build-image.sh            ← one-command build (stage app + live-build)
│   ├── stage-app.sh              ← build the web stack + stage into the image
│   └── validate-layout.sh        ← verify the recipe tree (no boot needed)
└── live-build/                   ← the live-build recipe
    ├── auto/{config,build,clean}
    └── config/
        ├── package-lists/foulfox.list.chroot
        ├── includes.chroot/      ← files baked into the image
        │   ├── etc/foulfox/foulfox.env
        │   ├── etc/systemd/system/*.service
        │   └── usr/local/bin/foulfox-*
        └── hooks/normal/*.hook.chroot
```

## How it boots

1. **systemd** brings up `NetworkManager` (wired + Wi-Fi, broad firmware).
2. `foulfox-prepare.service` runs the first-run provisioner: creates runtime
   dirs, finds a Windows ISO + the virtio driver ISO (frontloaded or on USB),
   creates the guest disk, and writes the VM config.
3. `odysseus-service.service` starts the Odysseus FastAPI agent on loopback.
4. `foulfox-api.service` starts the Express api-server, which serves the built
   shell, the `/api` routes, and the Odysseus proxy from a single origin.
5. The kiosk session autologs in and opens the FoulFox shell fullscreen in
   Chromium.
6. `foulfox-vm-autostart.service` starts the Windows VM (if configured); a
   fullscreen SPICE viewer attaches automatically.

## The frontload fallback

When automatic setup can't fetch what it needs (no network, a Windows ISO you
must supply, niche driver files), insert a USB stick and use the **File
Explorer** tab in the shell to copy files into the staging area
(`/var/lib/foulfox/frontload/{isos,drivers,files}`). The first-run provisioner
and the VM launcher read from there. This is the manual escape hatch for every
"it didn't auto-detect" situation.

## Build it

```bash
# On an amd64 Debian/Ubuntu host:
sudo apt install live-build
corepack enable && corepack prepare pnpm@latest --activate

os/scripts/build-image.sh        # stages the app, then runs live-build
```

See **docs/build.md** for details and **docs/flash.md** to write it to USB.

## Windows licensing

FoulFox OS never bundles Windows. You supply your own Windows installation ISO
and a valid license; the appliance installs it into the guest disk on first run.

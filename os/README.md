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
│   ├── cloud-build.md            ← click-to-build the ISO on GitHub (no Linux box)
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

## Picking an OS in the shell (no second machine)

The shell's **New virtual machine** picker is the primary path: choose an OS and
the appliance downloads the most stable release automatically — no second
computer or pre-made install media required.

- **Linux** (Ubuntu 24.04 LTS, Debian 12): a ready-to-boot cloud image is
  fetched and the disk is built hands-off (SSH enabled on first boot).
- **Windows** (11, or 10 22H2): the official ISO is downloaded straight from
  Microsoft along with the stable virtio driver ISO. You bring your own Windows
  license key to activate.
- **macOS**: offered only on genuine Apple hardware (Apple's licence +
  Hypervisor.framework).

## The frontload fallback

Auto-download needs network access, and Microsoft sometimes blocks downloads
from certain networks. When automatic setup can't fetch what it needs (no
network, a blocked Windows download, niche driver files), insert a USB stick and
use the **File Explorer** tab in the shell to copy files into the staging area
(`/var/lib/foulfox/frontload/{isos,drivers,files}`). The first-run provisioner
and the VM launcher read from there. This is the manual escape hatch for every
"it didn't auto-download" situation.

## Build it

### In the cloud (recommended — no Linux machine needed)

Push this repo to GitHub and use the **Build FoulFox OS ISO** GitHub Action: click
**Run workflow** any time and it builds the latest committed code into a
downloadable `.iso`. See **docs/cloud-build.md**.

### On your own Linux host

```bash
# On an amd64 Debian/Ubuntu host:
sudo apt install live-build
corepack enable && corepack prepare pnpm@latest --activate

os/scripts/build-image.sh        # stages the app, then runs live-build
```

See **docs/build.md** for details and **docs/flash.md** to write it to USB.

## Windows licensing

FoulFox OS never bundles Windows. The in-app picker downloads Microsoft's
official, freely-redistributable Windows **installation media** for you, but a
Windows license is still yours to provide: enter your own product key to
activate. (If the automatic download is blocked on your network, frontload your
own installation ISO instead — see "The frontload fallback".)

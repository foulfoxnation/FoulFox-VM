# Booting FoulFox OS for the first time

## 1. Boot from the USB stick

1. Insert the FoulFox OS USB stick into the target PC.
2. Power on and open the **boot menu** (commonly `F12`, `F10`, `Esc`, or `F9` —
   it's shown briefly on the splash screen). On some machines you set the boot
   order in BIOS/UEFI setup (`Del` or `F2`).
3. Choose the USB stick (it may appear as "USB HDD", the stick's brand, or
   "UEFI: <stick>").

### Enable hardware virtualization (one-time BIOS setting)
The Windows guest uses KVM hardware acceleration. If it isn't already on, enter
BIOS/UEFI setup and enable:
- **Intel**: "Intel VT-x" / "Virtualization Technology"
- **AMD**: "SVM Mode" / "AMD-V"

Save and reboot. (Without this, the VM can't start with acceleration — see
troubleshooting.md.)

> **Secure Boot:** if the USB stick won't boot, temporarily disable Secure Boot
> in BIOS/UEFI. You can re-enable it after install if your hardware allows.

## 2. What happens automatically

FoulFox OS boots straight into the kiosk — you'll see the **FoulFox VM** shell
fullscreen. In the background it:

- connects to the network (plug in Ethernet for the smoothest first run; Wi-Fi
  is available from the shell once up),
- starts the Odysseus AI agent and the api-server,
- provisions the VM (creates the guest disk, looks for a Windows ISO + the
  virtio driver ISO),
- autostarts the Windows VM **if** an ISO or installed disk is present.

## 3. Choose an operating system

Open the shell's **New virtual machine** picker, choose an OS, and the appliance
downloads the most stable release automatically — **no second machine or
pre-made install media required**.

- **Linux** (Ubuntu 24.04 LTS, Debian 12): a ready-to-boot cloud image is
  fetched and the disk is built hands-off.
- **Windows** (11, or 10 22H2): the official ISO is downloaded straight from
  Microsoft along with the stable virtio drivers. **Bring your own Windows
  license key** to activate — FoulFox never bundles a license.
- **macOS**: only on genuine Apple hardware.

Watch the picker's progress bar; when it reads *ready*, start the VM.

### Fallback: frontload from USB (works offline / when a download is blocked)
Auto-download needs network access, and Microsoft sometimes blocks downloads
from datacenter or filtered networks. If the picker reports the download is
unavailable, supply the media yourself:

1. Put your Windows installation `.iso` on a second USB stick (or the same data
   partition).
2. Insert it. In the shell, open the **File Explorer** tab.
3. Your stick appears under detected drives. Browse to the `.iso`, select it,
   and **copy it into staging** → the `isos` area.
4. (Optional) also copy a `virtio-win*.iso` into the `drivers` area; with a
   network the appliance downloads this automatically.
5. Re-scan for the ISO so the VM config picks it up: **reboot**, or from a
   console (Ctrl+Alt+F2) run `sudo systemctl restart foulfox-prepare`. The
   appliance then creates the guest disk, points the VM at your ISO, and the
   Windows installer boots. (A VM-controls "restart" alone reuses the old
   config and won't pick up a newly-added ISO.)

## 4. Install Windows into the guest

1. The VM boots the Windows installer to a fullscreen SPICE window.
2. Proceed normally. When asked **"Where do you want to install Windows?"**:
   - If you attached the **virtio** driver ISO, click **Load driver**, browse
     the virtio CD, and load the storage (`vioscsi`/`viostor`) driver so the
     virtual disk appears. (If you used the default IDE disk it will already be
     visible — virtio drivers are still worth installing afterward for
     networking and performance.)
3. Finish setup and sign in.
4. Back in Windows, open the virtio CD and run the installer to add the network,
   display, and balloon drivers.

## 5. Switching between the shell and Windows

The kiosk runs the FoulFox shell **and** the fullscreen Windows viewer as
separate windows. Use **Alt+Tab** to switch between them. The shell's VM
controls let you start, stop, restart, and snapshot the guest.

## 6. Persistence (do this before installing Windows)

The image boots with a persistence label (`foulfox-persist`), but a plain flash
(dd/Etcher/Rufus) does **not** create that partition. Without it, **everything
runs in a RAM overlay**: the multi-GB Windows ISO and the 128 GB guest disk are
written to memory, so they are **lost on every reboot** and can **exhaust RAM
mid-install**. The appliance detects this and shows a warning in the kiosk plus a
`PERSISTENCE-WARNING.txt` note — it never repartitions your stick for you.

To make storage durable, add a second partition to the USB stick labeled exactly
`foulfox-persist` (an `ext4` partition containing a one-line `persistence.conf`
of `/ union`). See **flash.md → "Make storage persistent"** for the steps. Do
this before installing Windows so the guest disk survives reboots.

See troubleshooting.md if anything above doesn't behave as expected.

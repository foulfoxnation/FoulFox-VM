# FoulFox OS troubleshooting

The kiosk shows the FoulFox shell, but you can drop to a text console with
**Ctrl+Alt+F2** (and back to the kiosk with **Ctrl+Alt+F1** or `F7`). Log in as
`foulfox`. Useful commands:

```bash
# Service status + logs
systemctl status foulfox-api odysseus-service foulfox-vm-autostart
journalctl -u foulfox-api -b --no-pager
journalctl -u odysseus-service -b --no-pager
journalctl -u foulfox-prepare -b --no-pager

# VM config the api-server is using
cat /var/lib/foulfox/.odysseus-vm-config.json

# What's been frontloaded
ls -R /var/lib/foulfox/frontload
```

---

## The USB stick won't boot
- Open the firmware boot menu and pick the stick explicitly (it may be listed
  under "UEFI:").
- Disable **Secure Boot** in BIOS/UEFI and retry.
- Re-flash the stick — an interrupted write produces a non-booting image
  (flash.md). Verify your download/build wasn't truncated.
- Try a different USB port (rear ports / USB 2.0 ports can be more reliable for
  booting).

## The VM won't start / "no acceleration"
- Enable **Intel VT-x** or **AMD SVM** in BIOS/UEFI (first-boot.md, step 1).
- Confirm KVM is present:
  ```bash
  ls -l /dev/kvm
  ```
  If it's missing, virtualization is still disabled in firmware, or the CPU
  lacks it. The shell's VM page also reports KVM availability.
- Confirm the `foulfox` user is in the `kvm` group:
  ```bash
  id foulfox        # should list "kvm"
  ```
- Lower `VM_RAM_GB` in `/etc/foulfox/foulfox.env` if the host doesn't have
  enough RAM, then `sudo systemctl restart foulfox-prepare foulfox-api`.

## No network
- Plug in **Ethernet** for the most reliable first run.
- For Wi-Fi, use the network controls in the shell, or from a console:
  ```bash
  nmcli device wifi list
  nmcli device wifi connect "<SSID>" password "<password>"
  ```
- Missing Wi-Fi hardware usually means a firmware gap. The image ships the
  common non-free firmware bundles; exotic adapters may need a firmware file
  frontloaded into `/lib/firmware` (copy it via the File Explorer, then reboot).

## The Windows installer can't see the disk
- Click **Load driver** and load the storage driver from the **virtio** CD
  (`vioscsi` or `viostor` for your Windows version), or
- ensure a guest disk exists and is attached — the default disk is IDE and
  should be visible without extra drivers. Check:
  ```bash
  cat /var/lib/foulfox/.odysseus-vm-config.json   # diskPath should be set
  ls -lh /var/lib/foulfox/vm/
  ```

## No Windows ISO detected / automatic download failed
- First try the in-app picker: the **New virtual machine** dialog downloads the
  official Windows ISO from Microsoft for you. If it reports the download is
  unavailable, Microsoft has likely blocked your network (common on datacenter
  or filtered connections) — use the frontload fallback below.
- Frontload it: insert the USB stick, open the **File Explorer** tab, and copy
  the `.iso` into the staging `isos` area (first-boot.md, step 3).
- Verify it landed:
  ```bash
  ls -lh /var/lib/foulfox/frontload/isos
  ```
- Re-run provisioning and restart the VM:
  ```bash
  sudo systemctl restart foulfox-prepare
  # then start the VM from the shell, or:
  sudo systemctl restart foulfox-vm-autostart
  ```

## The Windows window doesn't appear
- The fullscreen viewer attaches only once the VM's SPICE port is up. Give it a
  few seconds after starting the VM.
- Check the VM is running from the shell's VM controls, or:
  ```bash
  ss -ltn | grep 5930        # the SPICE port from foulfox.env
  ```
- Switch windows with **Alt+Tab** (the shell and the viewer are separate
  windows).

## USB devices don't reach Windows
- Keyboard and mouse are handled by the viewer automatically.
- To pass a specific device through, add its `vendorid:productid` to the VM
  config's `usbPassthrough` list (find IDs with `lsusb`), then restart the VM.
  Don't pass through the host keyboard/mouse — that would steal input from the
  kiosk.

## The shell (browser) is blank
- Check the api-server is serving:
  ```bash
  curl -s http://127.0.0.1:8080/api/health
  curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/
  ```
- Inspect logs: `journalctl -u foulfox-api -b --no-pager`.
- Confirm the staged shell exists:
  ```bash
  ls /opt/foulfox/app/artifacts/odysseus-shell/dist/public/index.html
  ```

## Changes don't persist across reboots
- Create a persistence partition labeled `foulfox-persist` (first-boot.md,
  step 6). Without it, every boot is a fresh session.

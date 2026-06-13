# Flashing FoulFox OS to a USB stick

You need the ISO from **build.md** and a USB stick of **8 GB or larger**.
Flashing **erases everything** on the target stick — double-check the device.

The ISO is a hybrid image: writing it raw to the whole USB device (not a
partition) produces a bootable stick on BIOS and UEFI machines.

---

## Windows

### Option A — balenaEtcher (easiest)
1. Install [balenaEtcher](https://etcher.balena.io/).
2. **Flash from file** → pick the FoulFox OS `.iso`.
3. **Select target** → your USB stick.
4. **Flash**, then wait for validation to finish.

### Option B — Rufus
1. Install [Rufus](https://rufus.ie/).
2. **Device** → your USB stick.
3. **Boot selection** → SELECT → the `.iso`.
4. If prompted "ISOHybrid image detected", choose **Write in DD Image mode**.
5. **Start**.

---

## macOS

Use the built-in `dd`.

1. Identify the disk **before** inserting the stick, then again after, to find
   the new device:
   ```bash
   diskutil list
   ```
   Your USB stick will look like `/dev/disk4` (use the **whole** disk, not
   `disk4s1`).
2. Unmount it (replace `N`):
   ```bash
   diskutil unmountDisk /dev/diskN
   ```
3. Write the image (`rdisk` is the faster raw device):
   ```bash
   sudo dd if=/path/to/foulfox-os.iso of=/dev/rdiskN bs=4m status=progress
   ```
4. Eject:
   ```bash
   diskutil eject /dev/diskN
   ```

> Triple-check `N`. Writing to the wrong disk will erase it.

---

## Linux

### GNOME Disks (GUI)
Open **Disks**, select the USB stick, ⋮ menu → **Restore Disk Image…** → pick
the `.iso` → **Start Restoring**.

### dd (CLI)
1. Find the device (look for your USB stick's size):
   ```bash
   lsblk -dpno NAME,SIZE,MODEL
   ```
   e.g. `/dev/sdb`.
2. Make sure none of its partitions are mounted:
   ```bash
   sudo umount /dev/sdb*    # ignore "not mounted" errors
   ```
3. Write it (use the **whole** device, no partition number):
   ```bash
   sudo dd if=/path/to/foulfox-os.iso of=/dev/sdb bs=4M status=progress oflag=sync
   ```
4. Flush + safely remove:
   ```bash
   sync
   ```

---

## Next

Continue to **first-boot.md** to boot the stick and complete first run.

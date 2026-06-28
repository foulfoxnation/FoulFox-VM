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

## Make storage persistent (required to install Windows)

A raw flash leaves the rest of the stick unpartitioned. Without a persistence
partition, FoulFox OS runs entirely in RAM — the Windows ISO and the guest disk
are **lost on reboot** and can **exhaust memory during install**. Installing
Windows is not realistic without this, so add a second partition labeled exactly
`foulfox-persist`.

Use a stick comfortably larger than your guest disk (the default guest disk is
64 GB, so 128 GB+ is ideal). Do this from a Linux machine (or another FoulFox
boot — Ctrl+Alt+F2 for a console):

**Easiest — GParted / GNOME Disks (GUI):** open the flashed stick, select the
unallocated space after the image, create a new **ext4** partition, and set its
label to exactly `foulfox-persist`. Then do step 3 below for the config file.

**CLI alternative (parted):**

1. Find the stick and inspect its free space — note the **Start** of the free
   region reported (e.g. `2150MiB`):
   ```bash
   lsblk
   sudo parted /dev/sdb unit MiB print free
   ```
2. Create an ext4 partition spanning that free space to the end of the disk,
   then format it with the exact label. Replace `START` with the free-region
   **Start** value parted printed in step 1 — it already includes the unit, so
   write it verbatim (e.g. `2150MiB`, not `2150MiBMiB`). Replace `N` with the new
   partition number:
   ```bash
   sudo parted /dev/sdb --script -- mkpart primary ext4 START 100%
   sudo partprobe /dev/sdb
   sudo mkfs.ext4 -L foulfox-persist /dev/sdbN
   ```
3. Add the persistence config so the whole system overlays onto it:
   ```bash
   sudo mount /dev/sdbN /mnt
   echo "/ union" | sudo tee /mnt/persistence.conf
   sudo umount /mnt
   ```

On reboot, FoulFox OS finds the label automatically and stores everything there.

> On Windows/macOS, the built-in tools won't set a Linux ext4 label easily —
> create the `foulfox-persist` partition from a Linux machine or from a first
> FoulFox boot (Ctrl+Alt+F2 for a console).

---

## Next

Continue to **first-boot.md** to boot the stick and complete first run.

# Car Pi storage protection

The normal installation uses a read-only SD root with a RAM overlay, a read-only
firmware partition, and a separate writable ext4 data partition. This reduces OS
filesystem damage from sudden power cuts. Writes in progress on writable data and
the SD card's internal controller still depend on steady power; a shutdown battery
is the stronger option when losing the last writes is unacceptable.

For the current 128 GB card, the OS allocation is 32 GiB, firmware is 512 MiB,
and the remaining approximately 86 GiB holds persistent data. `/home`, `/opt`,
both apps' state and credentials, and NetworkManager state bind to that data
partition. Existing OS copies are retained initially for recovery.

`overlayroot=tmpfs:recurse=0` is intentional: the default recursive setting can
also overlay the data partition and make saved changes disappear on reboot.
Swap uses compressed RAM only. Logs stay in RAM. Scheduled apt jobs are disabled;
perform OS updates on steady power in maintenance mode.

After installation:

```sh
sudo pi-storage status
sudo pi-storage maintenance
sudo reboot
# After reboot, unlock the firmware partition for kernel updates:
sudo pi-storage maintenance
sudo apt-get update
sudo apt-get full-upgrade
sudo pi-storage protect
sudo reboot
```

Changes to system files outside the persistent paths disappear after a protected
boot. Use maintenance for package installation, service definitions and OS
configuration. Downloads, saved chats, provider logins, app code and home files
persist during normal use.

`pi-storage-migrate` is a guarded migration for the inspected machine layout,
not a general installer. It requires a verified, bootable USB clone and private
machine identifiers and partition backups in `/var/lib/pi-storage-migration`.
Do not run it against another layout. The USB clone boots using the SD firmware
with `root=PARTUUID=<USB root partition>`; it does not need to modify existing
files on the USB's XBOX partition or change EEPROM boot order.

If migration fails, it retains the USB root and its log rather than rebooting.
The original partition table, firmware configuration and a resize undo file
remain on USB. Keep the USB connected and power stable until verification ends.

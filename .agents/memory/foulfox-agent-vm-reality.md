---
name: FoulFox agent-in-VM reality (auth, display, privilege)
description: What actually works vs. the aspirational scope for the agent operating inside the Windows/Linux guest — auth, display path, and privilege model.
---

# Agent-in-VM exec auth: now wired via per-VM SSH key (key mode only)

Non-interactive VM exec (`POST /api/shell/exec` → `shell.ts`) and the health
probe now go through the shared `buildSshArgs` (`lib/vm-ssh.ts`): when the VM has
a per-VM key it spawns `ssh -i <key> -o IdentitiesOnly=yes [-o BatchMode=yes]
-l <user> localhost <cmd>`. Provisioning generates an ed25519 key
(`ensureVmSshKey`), stores its path in `vm.config.sshKeyPath`, and injects the
pubkey (Linux cloud-init `ssh_authorized_keys`; Windows unattend creates an admin
account + writes `administrators_authorized_keys` with icacls + opens the sshd
firewall). `authMode(vm)` → "key" | "password" | "none".
**Still true:** `config.sshPassword` is cosmetic — no `sshpass`/askpass anywhere,
so **password mode is NOT a working non-interactive path**; only key mode is.
The interactive node-pty terminal still allows a human password fallback (no
BatchMode).
**Caveat:** VMs provisioned *before* this feature (e.g. the seeded `default` VM)
have `sshKeyPath: null` → `authMode "none"` → must be re-provisioned to get a key.
**Untested:** host has no KVM, so guest boot + actual key login is unverified;
confirmed only via typecheck + endpoint probes returning honest failures.

# Display path: noVNC works, the appliance SPICE viewer does not

Live `vm-launch.ts` emits **VNC** (websocket-bridged by `vm-display.ts`
websockify → rendered by `VmDisplay.tsx` noVNC in the shell). It emits **no
`-spice`** — SPICE args live only in the dead, tree-shaken `qemu-args.ts`. But
the appliance kiosk script `foulfox-open-vm-viewer` waits on SPICE port 5930 and
runs `remote-viewer --full-screen spice://127.0.0.1:5930`.
**Effect:** on the flashed appliance the fullscreen remote-viewer never attaches
(no SPICE server is started); the in-browser noVNC tab is the only functional VM
display.
**How to apply:** either add a SPICE branch to live `vm-launch.ts` (port 5930) or
drop the SPICE viewer and rely on the noVNC tab. Don't trust `qemu-args.ts`.

# Privilege model: KVM access, not root

The live-build enable-services hook adds `foulfox` to `kvm plugdev netdev video`
(+ `autologin`) only — **not `sudo`**, and there's no sudoers drop-in. So
"kernel-level permissions / agent upgrades its own OS" is aspirational: the agent
runs as an unprivileged user with KVM device access, not root.

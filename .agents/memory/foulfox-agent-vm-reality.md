---
name: FoulFox agent-in-VM reality (auth, display, privilege)
description: What actually works vs. the aspirational scope for the agent operating inside the Windows/Linux guest — auth, display path, and privilege model.
---

# Agent-in-VM exec is NOT wired end-to-end (auth gap)

The agent's non-interactive VM exec (`_vm_shell_exec` → `POST /api/shell/exec`
→ `shell.ts`) spawns a bare `ssh -o StrictHostKeyChecking=no -o
UserKnownHostsFile=/dev/null -p <port> <user>@localhost <command>` with **no
PTY, no `-i` key, no `sshpass`/askpass**. `config.sshPassword` is written by
`provisionLinux` (random pw) and surfaced in SettingsModal but is **never passed
to the ssh command** (repo-wide: no sshpass/askpass, no key injection into
guests). Windows `autounattend.xml` only enables OpenSSH.Server + RDP — it
creates no known account/password/key.
**Effect:** the agent cannot authenticate to *either* Linux or Windows guests
non-interactively. Only the interactive node-pty terminal works (a human types
the password at the prompt).
**Why:** the `sshPassword` field is cosmetic plumbing; nothing consumes it.
**How to apply:** to make agent-in-VM exec real, inject a per-VM SSH **key** in
both Linux cloud-init (`ssh_authorized_keys`) and Windows unattend
(administrators_authorized_keys), store the private key path in vm config, and
have `sshArgsFor` use `-i <key> -o BatchMode=yes`. Password auth via spawn() is a
dead end without a PTY + askpass.

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

---
name: FoulFox VM agent access
description: How agents authenticate into guest VMs and the dev-host limits on testing them.
---

# FoulFox VM agent access

Agents reach a guest over a localhost-forwarded port (QEMU hostfwd). Each VM gets
its own ed25519 keypair at provision time; the private key path lives in
`vm.config.sshKeyPath` and the public key is injected into the guest (Linux
cloud-init `authorized_keys`; Windows `administrators_authorized_keys`).

## Invariants (keep future SSH work consistent)
- Build ssh as an **argv**, never a shell string. Pass the username via `-l <user>`
  and a literal `localhost` destination — never `user@host`.
  **Why:** a configured username like `-oProxyCommand=...` in `user@host` form is
  parsed by ssh as an option (local command execution). `-l` + a validated
  username (`^[A-Za-z_][A-Za-z0-9_.-]*$`) closes this.
- When a per-VM key exists, authenticate with it ONLY (`-i key -o IdentitiesOnly=yes`)
  so an ambient ssh-agent identity can't interfere.
- Non-interactive agent/health checks must require `authMode === "key"` and fail
  honestly otherwise. **Why:** password/none modes with BatchMode could still
  succeed via an ambient agent identity and report a false "healthy".

## Dev-host testing limit
- This Replit host has **no KVM/Hyper-V/HVF**, so guest VMs cannot be booted here.
  Verify VM/SSH changes via `tsc --noEmit` + hitting the API endpoints (e.g.
  `/api/vm/list`, `/api/vm/:id/agent-health` return honest failures when the VM is
  down). Real boot-testing of Linux + Windows guests must happen on a virt-capable
  host.

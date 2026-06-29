---
name: VM guest CDP / loopback-service exposure
description: How to expose a loopback-only in-guest service (e.g. Chrome DevTools) to the host through QEMU user-mode networking, plus Windows unattend gotchas.
---

# Exposing a loopback-only guest service through QEMU user networking

QEMU user-mode (SLIRP) `hostfwd` delivers forwarded connections to the **guest NIC IP (10.0.2.15)**, NOT the guest's loopback. A service that binds only `127.0.0.1` inside the guest is therefore unreachable via `hostfwd` on its own.

**Rule:** to expose a loopback-only in-guest service, run a bridge *inside* the guest from `0.0.0.0:<port>` to `127.0.0.1:<port>`, then `hostfwd` the host port to it. On Windows: `netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 ... connectaddress=127.0.0.1 ...` (plus a firewall allow rule).

**Why keep the service on loopback (Chrome CDP case):** binding Chrome's `--remote-debugging-port` to `0.0.0.0` is refused/unreliable on some builds, and CDP is unauthenticated — keep Chrome on `127.0.0.1` and bridge with portproxy. Keep the host `hostfwd` bound to `127.0.0.1` so CDP never leaves the host. Launch Chrome HEADED (not `--headless`) to preserve the real-desktop anti-detection benefit.

**Do NOT pass `--remote-allow-origins=*`.** Playwright's Node `connectOverCDP` opens the DevTools WebSocket with no `Origin` header, which Chrome M111+ accepts regardless of the allowlist — so the wildcard is unnecessary for automation. It is also actively harmful: with `*`, any web page the browser loads can attach to the local CDP endpoint (DNS-rebind / cross-origin CDP hijack of an unauthenticated, full-control protocol). Omit the flag entirely (Chrome's default rejects disallowed Origins, allows missing Origin).

**Guest portproxy must stay `0.0.0.0` (not `127.0.0.1`).** SLIRP delivers `hostfwd` traffic to the guest NIC, so a `127.0.0.1`-only bridge would never receive it and CDP breaks. The `0.0.0.0` listen is NAT-isolated (no inbound route to the guest except the loopback-bound host `hostfwd`), so the real network boundary is the host `hostfwd` (already `127.0.0.1`), not the guest bridge. "Tighten listenaddress to 127.0.0.1" only applies to the host side.

## Windows unattend FirstLogonCommands gotchas
- Wrap multi-line PowerShell as `powershell -EncodedCommand <base64 of UTF-16LE>` so quotes / `&` / `<>` in the script can't corrupt the XML answer file.
- An MSI updates the **machine** PATH but NOT the already-running FirstLogon session — refresh PATH or call tools by full path (e.g. `C:\Program Files\nodejs\npm.cmd`).
- `AutoLogon LogonCount=1`: an `AtLogOn` scheduled task only fires on the first auto-logon (or a manual login), NOT across unattended reboots. Persistent autologon is needed for 24/7 headed-browser operation.
- In TS, write these scripts with `String.raw` — Windows backslash paths (`nodejs\npm.cmd`, `C:\cdp-profile`) would otherwise be mangled by template-literal escapes (`\n` → newline).

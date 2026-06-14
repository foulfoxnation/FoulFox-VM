import { spawn } from "child_process";
import { type VmRecord, getRuntime } from "./vm-registry";
import { logger } from "./logger";

// ── Per-VM SSH auth, shared by the terminal/exec routes and the health check ──
// Agents reach a guest over a localhost-forwarded port (see vm-launch hostfwd).
// Each VM gets its own ed25519 keypair at provision time; the private key path
// lives in vm.config.sshKeyPath and the public key is injected into the guest
// (Linux cloud-init authorized_keys / Windows administrators_authorized_keys).

export interface SshAuth {
  sshPort: number;
  sshUser: string | null;
  sshKeyPath: string | null;
}

export type AuthMode = "key" | "password" | "none";

export function authFor(vm: VmRecord): SshAuth {
  return {
    sshPort: vm.config.sshPort,
    sshUser: vm.config.sshUser,
    sshKeyPath: vm.config.sshKeyPath,
  };
}

export function authMode(vm: VmRecord): AuthMode {
  if (vm.config.sshKeyPath) return "key";
  if (vm.config.sshPassword) return "password";
  return "none";
}

// A safe local-account name: must start with a letter/underscore and contain
// only letters, digits, '_', '-', '.'. This accepts every real Linux/Windows
// account ("ubuntu", "foulfox") while rejecting anything that could be abused.
const SAFE_SSH_USER = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

// Validate a configured SSH username. Returns the name if safe, otherwise null
// (and logs). Critical because a crafted username like "-oProxyCommand=..." must
// never reach ssh as something it could parse as an option.
export function sanitizeSshUser(user: string | null | undefined): string | null {
  if (!user) return null;
  if (SAFE_SSH_USER.test(user)) return user;
  logger.warn({ user }, "Ignoring unsafe SSH username (does not match allowed pattern)");
  return null;
}

// Build the ssh argv (never a shell string). Host-key checking is disabled
// because the forwarded port is a fresh localhost endpoint per boot with no
// stable host key — safe here since the connection never leaves loopback. When
// a per-VM key exists we authenticate with it ONLY (IdentitiesOnly) so a loaded
// ssh-agent can't interfere. `batch` (one-shot exec) makes a failed key auth
// fail fast instead of hanging on a password prompt; the interactive terminal
// omits it so a human can still type a password as a fallback.
//
// The username is passed via `-l <user>` (not "user@host") and validated, and
// the destination is always the literal "localhost" — so a configured username
// can never be parsed by ssh as an option (no ProxyCommand-style injection).
export function buildSshArgs(auth: SshAuth, opts?: { batch?: boolean }): string[] {
  const port = Number(auth.sshPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid SSH port: ${String(auth.sshPort)}`);
  }
  const args = [
    "-o", "StrictHostKeyChecking=no",
    "-o", "UserKnownHostsFile=/dev/null",
    "-o", "ConnectTimeout=5",
  ];
  if (auth.sshKeyPath) {
    args.push("-i", auth.sshKeyPath, "-o", "IdentitiesOnly=yes");
  }
  if (opts?.batch) args.push("-o", "BatchMode=yes");
  args.push("-p", String(port));
  const user = sanitizeSshUser(auth.sshUser);
  if (user) args.push("-l", user);
  args.push("localhost");
  return args;
}

export interface AgentHealth {
  ok: boolean;          // a command ran and returned the expected marker
  reachable: boolean;   // the SSH port answered (auth may still have failed)
  authMode: AuthMode;
  detail: string;
}

// Verify an agent can actually run a command in the guest with no human input.
// Runs `echo <marker>` over key-based SSH and confirms the marker comes back.
export function checkAgentHealth(vm: VmRecord, timeoutMs = 8000): Promise<AgentHealth> {
  const mode = authMode(vm);
  const rt = getRuntime(vm.id);
  if (rt.state !== "running") {
    return Promise.resolve({ ok: false, reachable: false, authMode: mode, detail: "VM is not running." });
  }
  if (vm.config.connectionMode !== "ssh") {
    return Promise.resolve({ ok: false, reachable: false, authMode: mode, detail: "VM is not in SSH connection mode." });
  }
  // Only a per-VM key proves hands-off agent access. Password/none modes must
  // fail honestly here rather than letting an ambient ssh-agent identity (which
  // is NOT the per-VM key) make the probe report a false success.
  if (mode !== "key") {
    return Promise.resolve({ ok: false, reachable: false, authMode: mode, detail: "No per-VM SSH key configured (re-provision to generate one)." });
  }

  const marker = "__foulfox_agent_ok__";
  let args: string[];
  try {
    args = [...buildSshArgs(authFor(vm), { batch: true }), `echo ${marker}`];
  } catch (err) {
    return Promise.resolve({ ok: false, reachable: false, authMode: mode, detail: (err as Error).message });
  }

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let done = false;
    const finish = (h: AgentHealth) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(h);
    };

    const child = spawn("ssh", args, { stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
      finish({ ok: false, reachable: false, authMode: mode, detail: "Connection timed out." });
    }, timeoutMs);

    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("error", (err) => finish({ ok: false, reachable: false, authMode: mode, detail: err.message }));
    child.on("close", (code) => {
      if (stdout.includes(marker)) {
        finish({ ok: true, reachable: true, authMode: mode, detail: "Key-based SSH login succeeded." });
        return;
      }
      // Auth/permission errors mean the port answered but the key was rejected.
      const reachable = /permission denied|publickey|password|authentication/i.test(stderr);
      finish({ ok: false, reachable, authMode: mode, detail: stderr.trim() || `ssh exited with code ${code}` });
    });
  });
}

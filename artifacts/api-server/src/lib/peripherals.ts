import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { logger } from "./logger";

// Shared helpers for the hardware/peripheral route groups (network, usb,
// bluetooth, browser-launch). Everything here shells out with ARGV ARRAYS via
// child_process.spawn — never a shell string — so device names, SSIDs, MAC
// addresses, etc. can never inject extra arguments or shell metacharacters.
//
// These features only fully work on the booted FoulFox OS appliance. In the
// Replit dev workspace the tools/daemons are absent, so every capability check
// degrades to an honest `{ available: false, reason }` instead of pretending.

export interface RunResult {
  ok: boolean; // process spawned and exited 0
  code: number | null;
  stdout: string;
  stderr: string;
  error?: string; // spawn error (ENOENT, etc.) or timeout note
  timedOut: boolean;
}

const DEFAULT_TIMEOUT_MS = 15000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024; // 2 MiB cap per stream

// Run a command as an argv array. Never rejects — failures resolve as
// `{ ok:false, error }` so callers translate them into honest HTTP responses.
export function run(
  cmd: string,
  args: string[],
  opts?: { timeoutMs?: number; input?: string },
): Promise<RunResult> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let settled = false;

    const finish = (r: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };

    let child;
    try {
      child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      finish({
        ok: false,
        code: null,
        stdout: "",
        stderr: "",
        error: e instanceof Error ? e.message : String(e),
        timedOut: false,
      });
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
    }, timeoutMs);

    child.stdout?.on("data", (d: Buffer) => {
      stdoutBytes += d.length;
      if (stdoutBytes <= MAX_OUTPUT_BYTES) stdout += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderrBytes += d.length;
      if (stderrBytes <= MAX_OUTPUT_BYTES) stderr += d.toString();
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      finish({ ok: false, code: null, stdout, stderr, error: err.message, timedOut });
    });

    child.on("close", (code) => {
      finish({
        ok: code === 0 && !timedOut,
        code,
        stdout,
        stderr,
        error: timedOut ? `Command '${cmd}' timed out after ${timeoutMs}ms` : undefined,
        timedOut,
      });
    });

    if (opts?.input !== undefined) {
      try {
        child.stdin?.write(opts.input);
        child.stdin?.end();
      } catch { /* ignore */ }
    } else {
      try { child.stdin?.end(); } catch { /* ignore */ }
    }
  });
}

// Is an executable resolvable on PATH? Shell-free: scan $PATH and test X_OK.
// Results are cached for the process lifetime (PATH + installed tools are stable
// on a booted appliance).
const commandCache = new Map<string, boolean>();

export async function commandExists(cmd: string): Promise<boolean> {
  if (commandCache.has(cmd)) return commandCache.get(cmd)!;
  // Reject anything with a path separator — we only resolve bare command names.
  let found = false;
  if (!cmd.includes("/")) {
    const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
    for (const dir of dirs) {
      const full = path.join(dir, cmd);
      try {
        await fs.promises.access(full, fs.constants.X_OK);
        found = true;
        break;
      } catch { /* keep scanning */ }
    }
  }
  commandCache.set(cmd, found);
  return found;
}

// Is a systemd service currently active? Returns false (not an error) when
// systemctl is missing or the service is unknown — exactly what the dev
// workspace needs so capability probes degrade gracefully.
export async function serviceActive(name: string): Promise<boolean> {
  if (!(await commandExists("systemctl"))) return false;
  const r = await run("systemctl", ["is-active", name], { timeoutMs: 4000 });
  return r.stdout.trim() === "active";
}

// ── nmcli terse-output parsing ────────────────────────────────────────────────
// `nmcli -t` emits ':'-separated fields and escapes literal colons as '\:'.
// Split a single terse line into fields, honoring the backslash escaping.
export function parseNmcliLine(line: string): string[] {
  const fields: string[] = [];
  let cur = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "\\" && i + 1 < line.length) {
      cur += line[i + 1];
      i++;
    } else if (ch === ":") {
      fields.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

// Log + standard JSON for an unavailable capability so dev responses are uniform.
export function unavailable(reason: string): { available: false; reason: string } {
  logger.debug({ reason }, "peripheral capability unavailable");
  return { available: false, reason };
}

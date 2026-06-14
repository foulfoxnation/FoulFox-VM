import net from "net";

// Minimal one-shot QMP (QEMU Machine Protocol) client.
//
// QEMU exposes a QMP monitor on a localhost TCP socket (started with
// `server,nowait`, so it accepts a fresh connection at any time). For every
// command we open a new connection, perform the capabilities handshake, send a
// single command, read its reply, and close. This deliberately keeps the
// lifecycle/snapshot stdio human-monitor (writeMonitor) untouched and avoids any
// long-lived shared socket state that would need reconnection bookkeeping.
//
// QMP framing is newline-delimited JSON. On connect the server sends a greeting
// `{"QMP": {...}}`; we must send `{"execute":"qmp_capabilities"}` to leave
// negotiation mode before any real command. Asynchronous `{"event": ...}`
// objects can arrive at any time and must be skipped while we wait for the
// `{"return": ...}` / `{"error": ...}` that answers our command.

export interface QmpResult {
  ok: boolean;
  return?: unknown;
  error?: string;
}

const COMMAND_TIMEOUT_MS = 15000;

// Execute a single QMP command against the monitor at 127.0.0.1:<port>.
// Never rejects — failures (timeout, connection refused, QMP error) resolve as
// `{ ok: false, error }` so callers can translate them into honest HTTP errors.
export function qmpExecute(
  port: number,
  command: string,
  args?: Record<string, unknown>,
  opts?: { timeoutMs?: number },
): Promise<QmpResult> {
  const timeoutMs = opts?.timeoutMs ?? COMMAND_TIMEOUT_MS;
  return new Promise((resolve) => {
    const sock = net.connect(port, "127.0.0.1");
    let buf = "";
    let settled = false;
    let handshakeSent = false;
    let commandSent = false;

    const done = (r: QmpResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { sock.destroy(); } catch { /* ignore */ }
      resolve(r);
    };

    const timer = setTimeout(() => {
      done({ ok: false, error: `QMP command '${command}' timed out after ${timeoutMs}ms` });
    }, timeoutMs);

    const send = (obj: unknown) => {
      try {
        sock.write(JSON.stringify(obj) + "\r\n");
      } catch (e) {
        done({ ok: false, error: `QMP write failed: ${e instanceof Error ? e.message : String(e)}` });
      }
    };

    sock.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(line);
        } catch {
          continue; // partial/garbled line — skip
        }
        // 1. Greeting → leave negotiation mode.
        if ("QMP" in msg && !handshakeSent) {
          handshakeSent = true;
          send({ execute: "qmp_capabilities" });
          continue;
        }
        // 2. Async events are noise while we await a specific reply.
        if ("event" in msg) continue;
        // 3. First reply after the handshake is the qmp_capabilities ack;
        //    consume it and fire the real command.
        if (handshakeSent && !commandSent) {
          commandSent = true;
          send(args ? { execute: command, arguments: args } : { execute: command });
          continue;
        }
        // 4. Next reply answers our command.
        if (commandSent) {
          if ("return" in msg) {
            done({ ok: true, return: msg.return });
            return;
          }
          if ("error" in msg) {
            const e = (msg.error as { desc?: string; class?: string }) || {};
            done({ ok: false, error: e.desc || e.class || "QMP error" });
            return;
          }
        }
      }
    });

    sock.on("error", (err) => {
      done({ ok: false, error: `QMP connection error: ${err.message}` });
    });
    sock.on("close", () => {
      done({ ok: false, error: "QMP connection closed before a reply was received" });
    });
  });
}

// Ask QEMU to write a screenshot of the guest's primary display to a host file.
// QEMU >= 7.1 accepts a `format` argument and can emit PNG directly; older
// builds only accept `{filename}` and always write PPM. Try PNG first and fall
// back to a plain (PPM) screendump so both QEMU generations are handled. The
// caller is responsible for converting/reading the resulting file.
export async function qmpScreendump(port: number, filename: string): Promise<QmpResult> {
  const png = await qmpExecute(port, "screendump", { filename, format: "png" }, { timeoutMs: 20000 });
  if (png.ok) return png;
  return qmpExecute(port, "screendump", { filename }, { timeoutMs: 20000 });
}

// Inject a batch of input events (mouse/keyboard) atomically. `events` is an
// array of QMP InputEvent objects (see vm-input.ts for the builders).
export function qmpInputSendEvent(port: number, events: unknown[]): Promise<QmpResult> {
  return qmpExecute(port, "input-send-event", { events });
}

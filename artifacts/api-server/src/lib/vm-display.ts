import { type IncomingMessage, type Server } from "http";
import { type Socket } from "net";
import net from "net";
import crypto from "crypto";
import { URL } from "url";
import { WebSocketServer, type WebSocket } from "ws";
import { getVm, getRuntime } from "./vm-registry";
import { isValidVmId } from "./vm-capabilities";
import { logger } from "./logger";

const DISPLAY_PATH = "/api/vm/ws/display";

function timingSafeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// Relay browser <-> QEMU raw VNC (RFB) over a WebSocket, the "websockify" pattern
// noVNC expects. The browser connects to our authenticated proxy; we open a
// localhost TCP socket to the VM's QEMU VNC port and pipe bytes both ways. QEMU's
// VNC socket is bound to 127.0.0.1 only, so it is never directly reachable.
export function handleDisplayWebSocket(ws: WebSocket, vmId: string) {
  const vm = getVm(vmId);
  if (!vm) { ws.close(1011, "VM not found"); return; }
  if (getRuntime(vmId).state !== "running") {
    ws.close(4001, "VM is not running");
    return;
  }

  const tcp = net.connect(vm.ports.vnc, "127.0.0.1");

  tcp.on("connect", () => logger.info({ vm: vmId, port: vm.ports.vnc }, "Display proxy connected to QEMU VNC"));
  tcp.on("data", (chunk: Buffer) => {
    if (ws.readyState === ws.OPEN) ws.send(chunk);
  });
  tcp.on("error", (err) => {
    logger.warn({ err, vm: vmId }, "Display proxy TCP error");
    try { ws.close(1011, "VNC connection error"); } catch { /* ignore */ }
  });
  tcp.on("close", () => { try { ws.close(); } catch { /* ignore */ } });

  ws.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
    const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
    if (!tcp.destroyed) tcp.write(buf);
  });
  ws.on("close", () => { try { tcp.destroy(); } catch { /* ignore */ } });
  ws.on("error", () => { try { tcp.destroy(); } catch { /* ignore */ } });
}

export function createDisplayWss(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request: IncomingMessage, socket, head) => {
    if (!request.url?.startsWith(DISPLAY_PATH)) return;

    const netSocket = socket as Socket;
    const remoteAddr = netSocket.remoteAddress ?? "";
    const isLocal =
      remoteAddr === "127.0.0.1" ||
      remoteAddr === "::1" ||
      remoteAddr === "::ffff:127.0.0.1";
    if (!isLocal) {
      logger.warn({ remoteAddr }, "Rejected non-localhost display WebSocket upgrade");
      netSocket.write("HTTP/1.1 403 Forbidden\r\nContent-Length: 9\r\n\r\nForbidden");
      netSocket.destroy();
      return;
    }

    const reqUrl = new URL(request.url, "http://localhost");
    const vmId = reqUrl.searchParams.get("vm") ?? "";
    const token = reqUrl.searchParams.get("token") ?? "";

    if (!isValidVmId(vmId)) {
      netSocket.write("HTTP/1.1 400 Bad Request\r\nContent-Length: 10\r\n\r\nBad VM id\n");
      netSocket.destroy();
      return;
    }
    const vm = getVm(vmId);
    // Per-VM display token gates access; constant-time compare avoids leaks.
    if (!vm || !token || !timingSafeEqual(token, vm.displayToken)) {
      logger.warn({ vm: vmId }, "Rejected display WebSocket upgrade: invalid per-VM token");
      netSocket.write("HTTP/1.1 401 Unauthorized\r\nContent-Length: 12\r\n\r\nUnauthorized");
      netSocket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket as Socket, head, (ws) => {
      handleDisplayWebSocket(ws, vmId);
    });
  });

  return wss;
}

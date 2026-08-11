/**
 * Host desktop display WebSocket proxy.
 *
 * When x11vnc is running on the appliance (`x11vnc -display :0 -localhost -nopw
 * -forever`) it binds TCP port 5900 loopback-only. This module bridges that RFB
 * socket to a WebSocket so noVNC in the Session Portal can render the live
 * host kiosk desktop — not just individual VMs.
 *
 * Auth: accepts the same shell session token OR a valid view-only token so the
 * Session Portal's shareable link also grants read access to the host display.
 *
 * WS path: /api/host/ws/display?token=<shell-or-view-token>
 */

import { type IncomingMessage, type Server } from "http";
import { type Socket } from "net";
import net from "net";
import { type URL } from "url";
import { WebSocketServer, type WebSocket } from "ws";
import { SHELL_SESSION_TOKEN } from "./shell-token";
import { isValidViewToken } from "./view-tokens";
import { logger } from "./logger";

const HOST_DISPLAY_PATH = "/api/host/ws/display";
const HOST_VNC_PORT = Number(process.env["HOST_VNC_PORT"] ?? "5900");

export function handleHostDisplayWebSocket(ws: WebSocket) {
  const tcp = net.connect(HOST_VNC_PORT, "127.0.0.1");

  tcp.on("connect", () =>
    logger.info({ port: HOST_VNC_PORT }, "Host display proxy connected to x11vnc"),
  );
  tcp.on("data", (chunk: Buffer) => {
    if (ws.readyState === ws.OPEN) ws.send(chunk);
  });
  tcp.on("error", (err) => {
    logger.warn({ err }, "Host display proxy TCP error (x11vnc not running?)");
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

export function createHostDisplayWss(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request: IncomingMessage, socket, head) => {
    if (!request.url?.startsWith(HOST_DISPLAY_PATH)) return;

    const netSocket = socket as Socket;
    const remoteAddr = netSocket.remoteAddress ?? "";
    const isLocal =
      remoteAddr === "127.0.0.1" ||
      remoteAddr === "::1" ||
      remoteAddr === "::ffff:127.0.0.1";

    if (!isLocal) {
      logger.warn({ remoteAddr }, "Rejected non-localhost host display WebSocket upgrade");
      netSocket.write("HTTP/1.1 403 Forbidden\r\nContent-Length: 9\r\n\r\nForbidden");
      netSocket.destroy();
      return;
    }

    const { URL: NodeURL } = require("url") as typeof import("url");
    const reqUrl: URL = new NodeURL(request.url, "http://localhost");
    const token = reqUrl.searchParams.get("token") ?? "";

    const tokenValid =
      token === SHELL_SESSION_TOKEN || isValidViewToken(token);

    if (!tokenValid) {
      logger.warn("Rejected host display WebSocket upgrade: invalid token");
      netSocket.write("HTTP/1.1 401 Unauthorized\r\nContent-Length: 12\r\n\r\nUnauthorized");
      netSocket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket as Socket, head, (ws) => {
      handleHostDisplayWebSocket(ws);
    });
  });

  return wss;
}

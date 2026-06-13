/**
 * Returns a full API URL that works in all runtime contexts:
 *  - Replit dev / browser (http://...): relative paths like "/api/..." work fine
 *  - Electron packaged (file://...): relative paths resolve against file:// and fail;
 *    must use the absolute loopback API server URL
 *
 * Usage:
 *   fetch(apiUrl("/api/shell/session-token"))
 *   new WebSocket(apiUrl("/api/shell/ws", "ws"))
 */

const IS_FILE_PROTOCOL = typeof window !== "undefined" && window.location.protocol === "file:";
const ELECTRON_API_BASE = "http://127.0.0.1:8080";

export function apiUrl(path: string): string {
  if (IS_FILE_PROTOCOL) {
    return `${ELECTRON_API_BASE}${path}`;
  }
  return path;
}

export function apiWsUrl(path: string): string {
  if (IS_FILE_PROTOCOL) {
    // file:// → connect directly to loopback API server via ws://
    return `ws://127.0.0.1:8080${path}`;
  }
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}${path}`;
}

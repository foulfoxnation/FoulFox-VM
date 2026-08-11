const IS_FILE = typeof window !== "undefined" && window.location.protocol === "file:";
const BASE = "http://127.0.0.1:8080";
export function apiUrl(path: string): string { return IS_FILE ? BASE + path : path; }
export function apiWsUrl(path: string): string {
  if (IS_FILE) return "ws://127.0.0.1:8080" + path;
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return proto + "//" + window.location.host + path;
}

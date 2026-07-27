// Typed client for the hardware/peripheral endpoints (browser, network, usb,
// bluetooth). Plain JSON over apiUrl, mirroring vm-api.ts. Read-only GETs need
// no token; state-changing POSTs send the shell session token (X-Shell-Token).
import { apiUrl } from "./api-url";
import { authedFetch } from "./shell-token";



async function parseError(res: Response): Promise<string> {
  try {
    const j = await res.json();
    return j?.error || j?.message || `Request failed (${res.status})`;
  } catch {
    return `Request failed (${res.status})`;
  }
}

// Read endpoints that may be capability-gated return this union: the data when
// the feature is present on the host, or a reason when it isn't (honest in dev).
export type Capable<T> = ({ available: true } & T) | { available: false; reason: string };

async function getCapable<T>(path: string): Promise<Capable<T>> {
  const res = await fetch(apiUrl(path));
  const j = await res.json().catch(() => null);
  if (j && typeof j.available === "boolean") return j as Capable<T>;
  return { available: false, reason: await parseError(res) };
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await authedFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

// ── Browser ────────────────────────────────────────────────────────────────────
export interface BrowserCapabilities {
  proxy: boolean;
  nativeBrowser: boolean;
  chromium: boolean;
  firefox?: boolean;
  discord?: boolean;
  hasDisplay: boolean;
  openBrowser?: boolean;
}

export async function fetchBrowserCapabilities(): Promise<BrowserCapabilities> {
  const res = await fetch(apiUrl("/api/browser/capabilities"));
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

// Issue the HttpOnly, path-scoped cookie that authorizes the proxy iframe. Must
// run (with the shell token) before the first proxy load.
export async function initBrowserSession(): Promise<void> {
  await postJson("/api/browser/session", {});
}

export function browserProxySrc(url: string): string {
  return apiUrl(`/api/browser/proxy?url=${encodeURIComponent(url)}`);
}

export async function launchNativeBrowser(url: string): Promise<{ ok: boolean; message?: string }> {
  return postJson("/api/browser/launch", { url });
}

// Open a standalone, movable app window (Firefox, Chromium or Discord) over
// the kiosk on the appliance. Fails honestly in dev (no launcher / no display).
export async function openStandaloneBrowser(
  browser: "firefox" | "chromium" | "discord",
): Promise<{ ok: boolean; message?: string }> {
  return postJson("/api/browser/open", { browser });
}

// ── Network ──────────────────────────────────────────────────────────────────
export interface NetDevice { device: string; type: string; state: string; connection: string | null; }
export interface WifiActive { ssid: string; signal: number; }
export interface WifiNetwork { ssid: string; signal: number; security: string; inUse: boolean; }

export function fetchNetworkStatus(): Promise<Capable<{ devices: NetDevice[]; wifi: WifiActive | null }>> {
  return getCapable("/api/network/status");
}
export function scanWifi(): Promise<Capable<{ networks: WifiNetwork[] }>> {
  return getCapable("/api/network/wifi/scan");
}
export function connectWifi(ssid: string, password: string): Promise<{ ok: boolean; message: string }> {
  return postJson("/api/network/wifi/connect", { ssid, password });
}
export function forgetWifi(ssid: string): Promise<{ ok: boolean; message: string }> {
  return postJson("/api/network/wifi/forget", { ssid });
}

// ── USB ──────────────────────────────────────────────────────────────────────
export interface UsbDevice { bus: string; device: string; vendorId: string; productId: string; name: string; isHub: boolean; }

export function listUsb(): Promise<Capable<{ devices: UsbDevice[] }>> {
  return getCapable("/api/usb/list");
}
export function attachUsb(
  vmId: string, bus: string, device: string,
): Promise<{ ok: boolean; id: string; message: string }> {
  return postJson("/api/usb/attach", { vmId, bus, device });
}
export function detachUsb(
  vmId: string, bus: string, device: string,
): Promise<{ ok: boolean; message: string }> {
  return postJson("/api/usb/detach", { vmId, bus, device });
}

// ── Bluetooth ──────────────────────────────────────────────────────────────────
export interface BtDevice { mac: string; name: string; paired?: boolean; }
export type BtAction = "pair" | "connect" | "trust" | "remove";

export function fetchBluetoothStatus(): Promise<Capable<{
  powered: boolean; discovering: boolean; adapter: string | null; devices: BtDevice[];
}>> {
  return getCapable("/api/bluetooth/status");
}
export function setBluetoothPower(on: boolean): Promise<{ ok: boolean; powered: boolean }> {
  return postJson("/api/bluetooth/power", { on });
}
export function scanBluetooth(seconds: number): Promise<{ ok: boolean; devices: BtDevice[] }> {
  return postJson("/api/bluetooth/scan", { seconds });
}
export function bluetoothDeviceAction(action: BtAction, mac: string): Promise<{ ok: boolean; message: string }> {
  return postJson(`/api/bluetooth/${action}`, { mac });
}

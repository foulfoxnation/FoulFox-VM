// Shell session token manager — single source of truth for X-Shell-Token.
//
// The api-server generates a NEW random session token every time it starts
// (unless pre-seeded via env). On the appliance, "Retry Setup" restarts the
// api-server, so any token the frontend cached at boot instantly goes stale
// and every protected POST (WiFi connect, Bluetooth, power, VM lifecycle)
// starts failing with 401 "Missing or invalid session token" until a manual
// page refresh.
//
// This module fixes that by (a) caching the token but refreshing it whenever
// the server rejects it, and (b) retrying the rejected request once with the
// fresh token. Use authedFetch() for any state-changing call.
import { apiUrl } from "./api-url";
import { setDefaultHeaders } from "@workspace/api-client-react";

let cached: string | null = null;
let inflight: Promise<string | null> | null = null;

async function fetchTokenOnce(): Promise<string | null> {
  try {
    const res = await fetch(apiUrl("/api/shell/session-token"));
    if (!res.ok) return null;
    const token = ((await res.json()) as { token?: string }).token;
    if (token) {
      cached = token;
      // Keep the generated api-client hooks in sync too.
      setDefaultHeaders({ "X-Shell-Token": token });
      return token;
    }
    return null;
  } catch {
    return null;
  }
}

/** Cached token, fetching it on first use. May be null if the server is down. */
export async function getShellToken(): Promise<string | null> {
  if (cached) return cached;
  return refreshShellToken();
}

/** Force-refetch the token (deduped) and update all consumers. */
export function refreshShellToken(): Promise<string | null> {
  if (!inflight) {
    inflight = fetchTokenOnce().finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

/**
 * fetch() with the shell token attached. If the server answers 401 (token
 * rotated because the api-server restarted), refresh the token and retry the
 * request once. Bodies must be re-sendable (string/undefined — no streams).
 */
export async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const attempt = (token: string | null) =>
    fetch(apiUrl(path), {
      ...init,
      headers: {
        ...((init.headers as Record<string, string>) ?? {}),
        ...(token ? { "X-Shell-Token": token } : {}),
      },
    });

  const token = await getShellToken();
  const res = await attempt(token);
  if (res.status !== 401) return res;

  cached = null; // the server told us this token is dead
  const fresh = await refreshShellToken();
  if (!fresh || fresh === token) return res;
  return attempt(fresh);
}

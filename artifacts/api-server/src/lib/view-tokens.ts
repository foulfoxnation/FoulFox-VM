/**
 * Shared view-token store.
 *
 * A view token is a short-lived credential that gives read-only access to the
 * session portal (view VNC, read logs, inspect session info) without granting
 * interactive shell access. Created by POST /api/session/view-token.
 *
 * Stored in memory only — tokens are lost on server restart (fine: 2 h TTL).
 */

import crypto from "crypto";

const TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

const store = new Map<string, { expiresAt: number }>();

// Purge expired tokens every minute.
setInterval(() => {
  const now = Date.now();
  for (const [tok, entry] of store) {
    if (entry.expiresAt < now) store.delete(tok);
  }
}, 60_000).unref();

/** Create a new view token valid for TTL_MS milliseconds. */
export function createViewToken(): { token: string; expiresAt: number } {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = Date.now() + TTL_MS;
  store.set(token, { expiresAt });
  return { token, expiresAt };
}

/** Returns true if the token is valid and not yet expired. */
export function isValidViewToken(token: string | null | undefined): boolean {
  if (!token) return false;
  const entry = store.get(token);
  if (!entry) return false;
  if (entry.expiresAt < Date.now()) {
    store.delete(token);
    return false;
  }
  return true;
}

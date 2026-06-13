/**
 * Fetches the per-session shell token from the API server.
 * The token must be included as:
 *   - X-Shell-Token header on POST /api/shell/exec requests
 *   - ?token= query param on the /api/shell/ws WebSocket URL
 *
 * This prevents CSRF attacks from malicious web pages targeting the loopback API.
 */
import { useQuery } from "@tanstack/react-query";

async function fetchShellToken(): Promise<string> {
  const res = await fetch("/api/shell/session-token");
  if (!res.ok) throw new Error(`Failed to fetch shell token: ${res.status}`);
  const data = await res.json();
  return data.token as string;
}

export function useShellToken() {
  return useQuery({
    queryKey: ["shell-session-token"],
    queryFn: fetchShellToken,
    // Token is stable for the life of the API server process; refetch only on failure
    staleTime: Infinity,
    retry: 5,
    retryDelay: 1000,
  });
}

import { useQuery } from "@tanstack/react-query";
import { apiUrl } from "@/lib/api-url";

async function fetchShellToken(): Promise<string> {
  const res = await fetch(apiUrl("/api/shell/session-token"));
  if (!res.ok) throw new Error(`Failed to fetch shell token: ${res.status}`);
  const data = await res.json();
  return data.token as string;
}

export function useShellToken() {
  return useQuery({
    queryKey: ["shell-session-token"],
    queryFn: fetchShellToken,
    staleTime: Infinity,
    retry: 5,
    retryDelay: 1000,
  });
}

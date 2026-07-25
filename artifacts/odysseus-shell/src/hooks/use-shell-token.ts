import { useQuery } from "@tanstack/react-query";
import { refreshShellToken } from "@/lib/shell-token";

// Thin React Query wrapper over the shell-token manager. Refetches
// periodically so a token rotated by an api-server restart ("Retry Setup",
// live update) heals without a page refresh; authedFetch() additionally
// retries any 401 with a fresh token immediately.
export function useShellToken() {
  return useQuery({
    queryKey: ["shell-session-token"],
    queryFn: async () => {
      const token = await refreshShellToken();
      if (!token) throw new Error("Failed to fetch shell token");
      return token;
    },
    staleTime: 15_000,
    refetchInterval: 30_000,
    retry: 5,
    retryDelay: 1000,
  });
}

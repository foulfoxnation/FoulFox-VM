import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useShellToken } from "./use-shell-token";
import {
  listApps,
  startAppInstall,
  uninstallApp,
  fetchInstallJob,
  type InstalledApp,
  type InstallJob,
  type AppCapability,
} from "@/lib/apps-api";

export const APPS_KEY = ["apps"];

export function useApps() {
  return useQuery<InstalledApp[]>({
    queryKey: APPS_KEY,
    queryFn: listApps,
    // Poll quickly while something is installing, slowly otherwise.
    refetchInterval: (query) =>
      query.state.data?.some((a) => a.status === "installing") ? 3000 : 15000,
  });
}

export function useInstallApp() {
  const { data: token } = useShellToken();
  return useMutation({
    mutationFn: ({
      repoUrl,
      capabilities,
    }: {
      repoUrl: string;
      capabilities: AppCapability[];
    }) => startAppInstall(repoUrl, capabilities, token),
  });
}

export function useInstallJob(jobId: string | null) {
  return useQuery<InstallJob>({
    queryKey: ["install-job", jobId],
    queryFn: () => fetchInstallJob(jobId as string),
    enabled: !!jobId,
    refetchInterval: (query) => {
      const phase = query.state.data?.phase;
      return phase === "done" || phase === "error" ? false : 1200;
    },
  });
}

export function useUninstallApp() {
  const { data: token } = useShellToken();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => uninstallApp(id, token),
    onSuccess: () => qc.invalidateQueries({ queryKey: APPS_KEY }),
  });
}

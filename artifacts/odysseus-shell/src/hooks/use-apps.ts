import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useShellToken } from "./use-shell-token";
import {
  listApps,
  startAppInstall,
  startAppZipUpload,
  startAppFileInstall,
  uninstallApp,
  fetchInstallJob,
  listDrives,
  listDirectory,
  type InstalledApp,
  type InstallJob,
  type AppCapability,
  type DriveInfo,
  type DirListing,
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

export function useInstallZip() {
  const { data: token } = useShellToken();
  return useMutation({
    mutationFn: ({
      file,
      capabilities,
    }: {
      file: File;
      capabilities: AppCapability[];
    }) => startAppZipUpload(file, capabilities, token),
  });
}

export function useInstallFromPath() {
  const { data: token } = useShellToken();
  return useMutation({
    mutationFn: ({
      path,
      capabilities,
    }: {
      path: string;
      capabilities: AppCapability[];
    }) => startAppFileInstall(path, capabilities, token),
  });
}

// Flash drives, refreshed while the picker is open so plugging one in shows up.
export function useDrives(enabled: boolean, token?: string | null) {
  return useQuery<DriveInfo[]>({
    queryKey: ["drives"],
    queryFn: () => listDrives(token),
    enabled: enabled && !!token,
    refetchInterval: enabled ? 3000 : false,
  });
}

export function useDirectory(path: string | null, token?: string | null) {
  return useQuery<DirListing>({
    queryKey: ["dir", path],
    queryFn: () => listDirectory(path as string, token),
    enabled: !!path && !!token,
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

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  listApps,
  startAppInstall,
  startAppZipUpload,
  startAppFileInstall,
  reinstallApp,
  uninstallApp,
  fetchInstallJob,
  startAppRun,
  stopAppRun,
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
    // Poll quickly while something is installing or starting up, slowly otherwise.
    refetchInterval: (query) =>
      query.state.data?.some(
        (a) => a.status === "installing" || a.run?.phase === "starting",
      )
        ? 3000
        : 15000,
  });
}

export function useInstallApp() {
  return useMutation({
    mutationFn: ({
      repoUrl,
      capabilities,
    }: {
      repoUrl: string;
      capabilities: AppCapability[];
    }) => startAppInstall(repoUrl, capabilities),
  });
}

export function useInstallZip() {
  return useMutation({
    mutationFn: ({
      file,
      capabilities,
    }: {
      file: File;
      capabilities: AppCapability[];
    }) => startAppZipUpload(file, capabilities),
  });
}

export function useInstallFromPath() {
  return useMutation({
    mutationFn: ({
      path,
      capabilities,
    }: {
      path: string;
      capabilities: AppCapability[];
    }) => startAppFileInstall(path, capabilities),
  });
}

// Flash drives, refreshed while the picker is open so plugging one in shows up.
export function useDrives(enabled: boolean) {
  return useQuery<DriveInfo[]>({
    queryKey: ["drives"],
    queryFn: () => listDrives(),
    enabled,
    refetchInterval: enabled ? 3000 : false,
  });
}

export function useDirectory(path: string | null) {
  return useQuery<DirListing>({
    queryKey: ["dir", path],
    queryFn: () => listDirectory(path as string),
    enabled: !!path,
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

export function useStartApp() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => startAppRun(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: APPS_KEY }),
  });
}

export function useStopApp() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => stopAppRun(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: APPS_KEY }),
  });
}

export function useUninstallApp() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => uninstallApp(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: APPS_KEY }),
  });
}

export function useReinstallApp() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => reinstallApp(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: APPS_KEY }),
  });
}

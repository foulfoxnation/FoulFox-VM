import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useShellToken } from "./use-shell-token";
import {
  listVms,
  fetchCapabilities,
  fetchOsImages,
  fetchOsRelease,
  fetchOsBuildStatus,
  triggerOsBuild,
  createVm,
  vmLifecycle,
  deleteVm,
  retryProvision,
  fetchAppUpdateInfo,
  fetchUpdateStatus,
  applyAppUpdate,
  rollbackAppUpdate,
  type CreateVmInput,
  type VmLifecycleAction,
  type VmSummary,
  type VmCapabilities,
  type OsImage,
  type OsReleaseInfo,
  type OsBuildStatus,
  type AppUpdateInfo,
  type UpdateStatus,
} from "@/lib/vm-api";

export const VM_LIST_KEY = ["vm-list"];
export const VM_CAPS_KEY = ["vm-capabilities"];
export const VM_OS_IMAGES_KEY = ["vm-os-images"];
export const OS_RELEASE_KEY = ["os-release"];
export const OS_BUILD_STATUS_KEY = ["os-build-status"];
export const APP_UPDATE_INFO_KEY = ["app-update-info"];
export const UPDATE_STATUS_KEY = ["update-status"];
export const SHELL_TOKEN_KEY = ["shell-session-token"];

export function useVmList() {
  return useQuery<VmSummary[]>({
    queryKey: VM_LIST_KEY,
    queryFn: listVms,
    refetchInterval: 3000,
  });
}

export function useVmCapabilities(enabled = true) {
  return useQuery<VmCapabilities>({
    queryKey: VM_CAPS_KEY,
    queryFn: fetchCapabilities,
    enabled,
  });
}

export function useOsImages(enabled = true) {
  return useQuery<OsImage[]>({
    queryKey: VM_OS_IMAGES_KEY,
    queryFn: fetchOsImages,
    enabled,
  });
}

export function useOsRelease() {
  return useQuery<OsReleaseInfo>({
    queryKey: OS_RELEASE_KEY,
    queryFn: fetchOsRelease,
    refetchInterval: 60_000,
  });
}

// Live GitHub Actions build state. Polls fast while a run is in flight so the
// "Build image" button and status line feel responsive, slow when idle.
export function useOsBuildStatus() {
  return useQuery<OsBuildStatus>({
    queryKey: OS_BUILD_STATUS_KEY,
    queryFn: fetchOsBuildStatus,
    refetchInterval: (query) => (query.state.data?.running ? 8_000 : 30_000),
  });
}

export function useTriggerOsBuild() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: triggerOsBuild,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: OS_BUILD_STATUS_KEY });
      qc.invalidateQueries({ queryKey: OS_RELEASE_KEY });
    },
  });
}

export function useCreateVm() {
  const qc = useQueryClient();
  const { data: token } = useShellToken();
  return useMutation({
    mutationFn: (input: CreateVmInput) => createVm(input, token),
    onSuccess: () => qc.invalidateQueries({ queryKey: VM_LIST_KEY }),
  });
}

export function useVmLifecycle() {
  const qc = useQueryClient();
  const { data: token } = useShellToken();
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: VmLifecycleAction }) =>
      vmLifecycle(id, action, token),
    onSuccess: () => qc.invalidateQueries({ queryKey: VM_LIST_KEY }),
  });
}

export function useDeleteVm() {
  const qc = useQueryClient();
  const { data: token } = useShellToken();
  return useMutation({
    mutationFn: (id: string) => deleteVm(id, token),
    onSuccess: () => qc.invalidateQueries({ queryKey: VM_LIST_KEY }),
  });
}

export function useRetryProvision() {
  const qc = useQueryClient();
  const { data: token } = useShellToken();
  return useMutation({
    mutationFn: (id: string) => retryProvision(id, token),
    onSuccess: () => qc.invalidateQueries({ queryKey: VM_LIST_KEY }),
  });
}

// ── Live app-stack updates ──────────────────────────────────────────────────────
export function useAppUpdateInfo() {
  return useQuery<AppUpdateInfo>({
    queryKey: APP_UPDATE_INFO_KEY,
    queryFn: fetchAppUpdateInfo,
    refetchInterval: 60_000,
  });
}

export function useUpdateStatus() {
  return useQuery<UpdateStatus>({
    queryKey: UPDATE_STATUS_KEY,
    queryFn: fetchUpdateStatus,
    // Poll fast while an update runs, slowly when idle. The status file is
    // written by the detached patcher, so it keeps advancing even across the
    // api-server restart that apply triggers.
    refetchInterval: (query) =>
      query.state.data?.state === "running" ? 2000 : 20_000,
  });
}

// apply/rollback restart the api-server, which mints a fresh shell token; drop
// the cached one so the next action re-fetches it instead of sending a stale one.
function onUpdateActionSettled(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: UPDATE_STATUS_KEY });
  qc.invalidateQueries({ queryKey: APP_UPDATE_INFO_KEY });
  qc.invalidateQueries({ queryKey: SHELL_TOKEN_KEY });
}

export function useApplyAppUpdate() {
  const qc = useQueryClient();
  const { data: token } = useShellToken();
  return useMutation({
    mutationFn: () => applyAppUpdate(token),
    onSettled: () => onUpdateActionSettled(qc),
  });
}

export function useRollbackAppUpdate() {
  const qc = useQueryClient();
  const { data: token } = useShellToken();
  return useMutation({
    mutationFn: () => rollbackAppUpdate(token),
    onSettled: () => onUpdateActionSettled(qc),
  });
}

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useShellToken } from "./use-shell-token";
import {
  listVms,
  fetchCapabilities,
  fetchOsImages,
  createVm,
  vmLifecycle,
  deleteVm,
  retryProvision,
  type CreateVmInput,
  type VmLifecycleAction,
  type VmSummary,
  type VmCapabilities,
  type OsImage,
} from "@/lib/vm-api";

export const VM_LIST_KEY = ["vm-list"];
export const VM_CAPS_KEY = ["vm-capabilities"];
export const VM_OS_IMAGES_KEY = ["vm-os-images"];

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

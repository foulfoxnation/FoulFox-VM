import { useState } from "react";
import { VmDisplay } from "./VmDisplay";
import { Terminal } from "./Terminal";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import {
  Play,
  Square,
  RotateCcw,
  Trash2,
  Clock,
  Activity,
  Cpu,
  Loader2,
  AlertTriangle,
  RefreshCw,
  KeyRound,
  ShieldCheck,
  ShieldAlert,
  Shield,
} from "lucide-react";
import { useVmLifecycle, useDeleteVm, useRetryProvision } from "@/hooks/use-vms";
import { useToast } from "@/hooks/use-toast";
import { checkAgentHealth, type AgentHealth, type VmSummary, type VmLifecycleAction } from "@/lib/vm-api";

function formatUptime(seconds: number | null) {
  if (seconds == null) return "00:00:00";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return [h, m, s].map((n) => n.toString().padStart(2, "0")).join(":");
}

export function VmTab({
  vm,
  isDefault,
  onDeleted,
}: {
  vm: VmSummary;
  isDefault: boolean;
  onDeleted: () => void;
}) {
  const lifecycle = useVmLifecycle();
  const del = useDeleteVm();
  const retry = useRetryProvision();
  const { toast } = useToast();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [health, setHealth] = useState<AgentHealth | null>(null);
  const [checking, setChecking] = useState(false);

  const isRunning = vm.state === "running";
  const isTransitioning = vm.state === "starting" || vm.state === "stopping";
  const isStopped = vm.state === "stopped" || vm.state === "error";

  const p = vm.provisioning;
  const provBusy =
    p.status === "downloading" || p.status === "creating-disk" || p.status === "installing";
  const provFailed = p.status === "failed";

  const act = (action: VmLifecycleAction) =>
    lifecycle.mutate(
      { id: vm.id, action },
      {
        onSuccess: (r) => {
          if (!r.success) toast({ title: r.message, variant: "destructive" });
        },
        onError: (e: Error) =>
          toast({ title: `Failed to ${action} VM`, description: e.message, variant: "destructive" }),
      },
    );

  const testAgent = async () => {
    setChecking(true);
    try {
      const h = await checkAgentHealth(vm.id);
      setHealth(h);
      toast({
        title: h.ok ? "Agent SSH healthy" : "Agent SSH unreachable",
        description: h.detail,
        variant: h.ok ? undefined : "destructive",
      });
    } catch (e) {
      setHealth(null);
      toast({ title: "Health check failed", description: (e as Error).message, variant: "destructive" });
    } finally {
      setChecking(false);
    }
  };

  const handleDelete = () =>
    del.mutate(vm.id, {
      onSuccess: () => {
        toast({ title: `Deleted ${vm.name}` });
        onDeleted();
      },
      onError: (e: Error) =>
        toast({ title: "Failed to delete VM", description: e.message, variant: "destructive" }),
    });

  return (
    <div className="flex h-full flex-col">
      {/* Per-VM control header */}
      <div
        className="flex items-center justify-between gap-3 border-b bg-muted/30 px-4 py-2"
        data-testid={`vm-tab-${vm.id}`}
      >
        <div className="flex items-center gap-2">
          <Badge
            variant={isRunning ? "default" : vm.state === "error" ? "destructive" : "secondary"}
            className="text-[10px] font-bold uppercase tracking-wider"
            data-testid={`vm-state-${vm.id}`}
          >
            {vm.state}
          </Badge>
          {isRunning && (
            <span className="flex items-center font-mono text-xs text-muted-foreground">
              <Clock className="mr-1 h-3 w-3" />
              {formatUptime(vm.uptime)}
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5">
          <Button
            size="sm"
            variant={isRunning ? "outline" : "default"}
            disabled={isRunning || isTransitioning || provBusy || lifecycle.isPending}
            onClick={() => act("start")}
            data-testid={`button-start-${vm.id}`}
          >
            <Play className="mr-1.5 h-3.5 w-3.5" /> Start
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={isStopped || isTransitioning || lifecycle.isPending}
            onClick={() => act("stop")}
            data-testid={`button-stop-${vm.id}`}
          >
            <Square className="mr-1.5 h-3.5 w-3.5" /> Stop
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={isStopped || isTransitioning || lifecycle.isPending}
            onClick={() => act("restart")}
            data-testid={`button-restart-${vm.id}`}
          >
            <RotateCcw className="mr-1.5 h-3.5 w-3.5" /> Restart
          </Button>
        </div>

        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          <span
            className="flex items-center"
            title={
              vm.authMode === "key"
                ? "Agent SSH: key-based login"
                : vm.authMode === "password"
                ? "Agent SSH: password login (re-provision for a key)"
                : "Agent SSH: no key configured (re-provision to generate one)"
            }
            data-testid={`vm-authmode-${vm.id}`}
          >
            <KeyRound className="mr-1 h-3 w-3" />
            {vm.authMode === "key" ? "Key" : vm.authMode === "password" ? "Password" : "No key"}
          </span>
          <button
            type="button"
            className="flex items-center hover:text-foreground disabled:opacity-50"
            onClick={testAgent}
            disabled={!isRunning || checking}
            title={
              !isRunning
                ? "Start the VM to test the agent connection"
                : health
                ? `${health.ok ? "Healthy" : "Unreachable"} — ${health.detail}`
                : "Test agent SSH connection"
            }
            data-testid={`button-agent-health-${vm.id}`}
          >
            {checking ? (
              <Loader2 className="mr-1 h-3 w-3 animate-spin" />
            ) : health?.ok ? (
              <ShieldCheck className="mr-1 h-3 w-3 text-green-500" />
            ) : health ? (
              <ShieldAlert className="mr-1 h-3 w-3 text-destructive" />
            ) : (
              <Shield className="mr-1 h-3 w-3" />
            )}
            {checking ? "Testing" : health?.ok ? "Healthy" : health ? "Unreachable" : "Test SSH"}
          </button>
          <span className="flex items-center" title="RAM">
            <Activity className="mr-1 h-3 w-3" />
            {vm.ramGb}GB
          </span>
          <span className="flex items-center" title="CPU">
            <Cpu className="mr-1 h-3 w-3" />
            {vm.cpuCores}C
          </span>
          {!isDefault &&
            (confirmDelete ? (
              <span className="flex items-center gap-1">
                <Button
                  size="sm"
                  variant="destructive"
                  className="h-7"
                  onClick={handleDelete}
                  disabled={del.isPending}
                  data-testid={`button-confirm-delete-${vm.id}`}
                >
                  {del.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Confirm"}
                </Button>
                <Button size="sm" variant="ghost" className="h-7" onClick={() => setConfirmDelete(false)}>
                  Cancel
                </Button>
              </span>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-muted-foreground hover:text-destructive"
                onClick={() => setConfirmDelete(true)}
                title="Delete VM"
                data-testid={`button-delete-${vm.id}`}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            ))}
        </div>
      </div>

      {/* Provisioning banner */}
      {(provBusy || provFailed) && (
        <div
          className={`flex items-center gap-3 border-b px-4 py-2 ${provFailed ? "bg-red-500/5" : "bg-primary/5"}`}
          data-testid={`vm-provision-${vm.id}`}
        >
          {provFailed ? (
            <AlertTriangle className="h-4 w-4 shrink-0 text-red-500" />
          ) : (
            <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
          )}
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs">{provFailed ? p.error || "Provisioning failed" : p.message}</p>
            {!provFailed && <Progress value={p.progress} className="mt-1 h-1" />}
          </div>
          {provFailed && (
            <Button
              size="sm"
              variant="outline"
              className="h-7"
              disabled={retry.isPending}
              onClick={() => retry.mutate(vm.id)}
              data-testid={`button-retry-${vm.id}`}
            >
              <RefreshCw className="mr-1 h-3.5 w-3.5" /> Retry
            </Button>
          )}
        </div>
      )}

      {/* Display (top) + per-VM terminal (bottom) */}
      <ResizablePanelGroup direction="vertical" className="flex-1">
        <ResizablePanel defaultSize={65} minSize={25}>
          <VmDisplay vm={vm} />
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel defaultSize={35} minSize={15}>
          <div className="h-full bg-zinc-950 p-3">
            <Terminal vmId={vm.id} />
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}

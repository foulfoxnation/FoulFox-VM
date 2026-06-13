import { useGetVmStatus, useStartVm, useStopVm, useRestartVm, getGetVmStatusQueryKey } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Play, Square, RotateCcw, Activity, Clock, Cpu, HardDrive } from "lucide-react";
import { useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";

// Minimal common interface shared by all three no-argument VM mutation hooks
type VoidMutation = UseMutationResult<unknown, Error, void, unknown>;

export function VmControls() {
  const { data: status } = useGetVmStatus({ query: { refetchInterval: 3000, queryKey: getGetVmStatusQueryKey() } });
  const startVm = useStartVm() as VoidMutation;
  const stopVm = useStopVm() as VoidMutation;
  const restartVm = useRestartVm() as VoidMutation;
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const handleMutation = (mutation: VoidMutation, actionName: string) => {
    mutation.mutate(undefined, {
      onSuccess: () => {
        toast({ title: `VM ${actionName} initiated` });
        queryClient.invalidateQueries({ queryKey: getGetVmStatusQueryKey() });
      },
      onError: (err: Error) => {
        toast({ title: `Failed to ${actionName} VM`, variant: "destructive", description: err.message });
      }
    });
  };

  const isRunning = status?.state === "running";
  const isTransitioning = status?.state === "starting" || status?.state === "stopping";
  const isStopped = status?.state === "stopped" || status?.state === "error" || !status;

  const formatUptime = (seconds: number | null | undefined) => {
    if (seconds == null) return "00:00:00";
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  return (
    <div className="flex items-center gap-4 border-b bg-muted/40 p-2 px-4 shadow-sm" data-testid="vm-controls">
      <div className="flex items-center gap-2 border-r pr-4 mr-2">
        <Badge 
          variant={isRunning ? "default" : status?.state === "error" ? "destructive" : "secondary"}
          className="uppercase tracking-wider text-[10px] font-bold"
          data-testid={`status-badge-${status?.state || 'unknown'}`}
        >
          {status?.state || "Unknown"}
        </Badge>
        {isRunning && (
          <span className="flex items-center text-xs text-muted-foreground font-mono" data-testid="text-uptime">
            <Clock className="mr-1 h-3 w-3" />
            {formatUptime(status.uptime)}
          </span>
        )}
      </div>

      <div className="flex items-center gap-1.5 flex-1">
        <Button 
          size="sm" 
          variant={isRunning ? "outline" : "default"} 
          disabled={isRunning || isTransitioning || startVm.isPending}
          onClick={() => handleMutation(startVm, 'start')}
          data-testid="button-start-vm"
        >
          <Play className="mr-1.5 h-3.5 w-3.5" /> Start
        </Button>
        <Button 
          size="sm" 
          variant="outline"
          disabled={isStopped || isTransitioning || stopVm.isPending}
          onClick={() => handleMutation(stopVm, 'stop')}
          data-testid="button-stop-vm"
        >
          <Square className="mr-1.5 h-3.5 w-3.5" /> Stop
        </Button>
        <Button 
          size="sm" 
          variant="outline"
          disabled={isStopped || isTransitioning || restartVm.isPending}
          onClick={() => handleMutation(restartVm, 'restart')}
          data-testid="button-restart-vm"
        >
          <RotateCcw className="mr-1.5 h-3.5 w-3.5" /> Restart
        </Button>
      </div>

      {status && (
        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          <div className="flex items-center" title="RAM">
            <Activity className="mr-1 h-3 w-3" />
            {status.ramGb}GB
          </div>
          <div className="flex items-center" title="CPU">
            <Cpu className="mr-1 h-3 w-3" />
            {status.cpuCores}C
          </div>
          <div className="flex items-center" title="Connection Mode">
            <HardDrive className="mr-1 h-3 w-3" />
            {status.connectionMode.toUpperCase()}
          </div>
        </div>
      )}
    </div>
  );
}

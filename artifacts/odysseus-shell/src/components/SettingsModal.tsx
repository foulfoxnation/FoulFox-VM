import { useState, useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Settings, Loader2, RefreshCw } from "lucide-react";
import { useGetVmConfig, useUpdateVmConfig, getGetVmConfigQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { authedFetch, refreshShellToken } from "@/lib/shell-token";
import { apiUrl } from "@/lib/api-url";

const configSchema = z.object({
  isoPath: z.string().optional(),
  diskPath: z.string().optional(),
  ramGb: z.coerce.number().min(1),
  cpuCores: z.coerce.number().min(1),
  gpuPassthrough: z.string().optional(),
  connectionMode: z.enum(["serial", "ssh"]),
  sshPort: z.coerce.number().min(1).max(65535),
  sshUser: z.string().optional(),
  sshPassword: z.string().optional(),
});

export function SettingsModal() {
  const [open, setOpen] = useState(false);
  const [restartingServices, setRestartingServices] = useState(false);
  const { data: config, isLoading } = useGetVmConfig({ query: { enabled: open, queryKey: getGetVmConfigQueryKey() } });
  const updateConfig = useUpdateVmConfig();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const form = useForm<z.infer<typeof configSchema>>({
    resolver: zodResolver(configSchema),
    defaultValues: {
      isoPath: "",
      diskPath: "",
      ramGb: 4,
      cpuCores: 2,
      gpuPassthrough: "",
      connectionMode: "serial",
      sshPort: 22,
      sshUser: "",
      sshPassword: "",
    },
  });

  useEffect(() => {
    if (config) {
      form.reset({
        isoPath: config.isoPath || "",
        diskPath: config.diskPath || "",
        ramGb: config.ramGb,
        cpuCores: config.cpuCores,
        gpuPassthrough: config.gpuPassthrough || "",
        connectionMode: config.connectionMode,
        sshPort: config.sshPort,
        sshUser: config.sshUser || "",
        sshPassword: config.sshPassword || "",
      });
    }
  }, [config, form]);

  // "Retry Setup" — restart the FoulFox OS services (local AI + agent) and
  // re-run first-boot provisioning, then watch for the agent to come back.
  // Lives here in Settings (not the main toolbar) so it can't be pressed by
  // accident after a successful startup.
  const handleRestartServices = async () => {
    setRestartingServices(true);
    try {
      const res = await authedFetch("/api/os/restart-services", { method: "POST" });
      const data = await res.json() as { ok: boolean; results?: Record<string, { ok: boolean }> };
      if (data.ok) {
        toast({
          title: "Restarting FoulFox OS services…",
          description: "Local AI + agent restarting; provisioner re-running. Watching for the agent to come online.",
          duration: 5000,
        });
        // The restarted api-server mints a NEW session token; grab it as soon
        // as the server is back so the next action doesn't hit a stale-token 401.
        setTimeout(() => void refreshShellToken(), 4000);
        setTimeout(() => void refreshShellToken(), 10000);
        // Watch the agent until it actually answers (up to 90s) so "Retry
        // Setup" reports a real outcome instead of silently doing nothing.
        const deadline = Date.now() + 90_000;
        let online = false;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 3000));
          try {
            const s = await fetch(apiUrl("/api/odysseus/lifecycle/status"));
            const j = await s.json() as { alive?: boolean };
            if (j.alive) { online = true; break; }
          } catch { /* api-server may be mid-restart; keep polling */ }
        }
        if (online) {
          toast({ title: "FoulFox OS is online", description: "The agent is up — the chat is ready.", duration: 5000 });
        } else {
          toast({
            title: "Agent still offline",
            description: "The agent didn't come up after the restart. Open 'Show details' on the offline screen to see its crash log.",
            variant: "destructive",
            duration: 10000,
          });
        }
      } else {
        toast({
          title: "Restart may not have taken effect",
          description: "This only works on the physical machine. The AI agent is managed by the dev workflow here.",
          duration: 4000,
        });
      }
    } catch {
      toast({ title: "Could not reach the API server", variant: "destructive", duration: 3000 });
    } finally {
      setRestartingServices(false);
    }
  };

  const onSubmit = (values: z.infer<typeof configSchema>) => {
    updateConfig.mutate(
      { data: values },
      {
        onSuccess: (newConfig) => {
          queryClient.setQueryData(getGetVmConfigQueryKey(), newConfig);
          setOpen(false);
          toast({ title: "Settings saved successfully" });
        },
        onError: (err) => {
          toast({ title: "Failed to save settings", variant: "destructive", description: String(err) });
        },
      }
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="icon" data-testid="button-settings">
          <Settings className="h-4 w-4" />
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>VM Configuration</DialogTitle>
        </DialogHeader>
        {isLoading ? (
          <div className="flex justify-center p-8">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="ramGb">RAM (GB)</Label>
                <Input id="ramGb" type="number" {...form.register("ramGb")} data-testid="input-ram" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="cpuCores">CPU Cores</Label>
                <Input id="cpuCores" type="number" {...form.register("cpuCores")} data-testid="input-cpu" />
              </div>
            </div>
            
            <div className="space-y-2">
              <Label htmlFor="diskPath">Disk Path</Label>
              <Input id="diskPath" {...form.register("diskPath")} data-testid="input-disk-path" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="isoPath">ISO Path</Label>
              <Input id="isoPath" {...form.register("isoPath")} data-testid="input-iso-path" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="gpuPassthrough">GPU Passthrough ID</Label>
              <Input id="gpuPassthrough" {...form.register("gpuPassthrough")} data-testid="input-gpu" />
            </div>

            <div className="grid grid-cols-2 gap-4 border-t pt-4">
              <div className="space-y-2">
                <Label htmlFor="connectionMode">Connection Mode</Label>
                <select 
                  id="connectionMode" 
                  {...form.register("connectionMode")}
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                  data-testid="select-connection-mode"
                >
                  <option value="serial">Serial</option>
                  <option value="ssh">SSH</option>
                </select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="sshPort">SSH Port</Label>
                <Input id="sshPort" type="number" {...form.register("sshPort")} data-testid="input-ssh-port" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="sshUser">SSH User</Label>
                <Input id="sshUser" {...form.register("sshUser")} data-testid="input-ssh-user" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="sshPassword">SSH Password</Label>
                <Input id="sshPassword" type="password" {...form.register("sshPassword")} data-testid="input-ssh-password" />
              </div>
            </div>

            <div className="flex justify-end space-x-2 pt-4">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={updateConfig.isPending} data-testid="button-save-settings">
                {updateConfig.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Save Changes
              </Button>
            </div>

            <div className="border-t pt-4 space-y-2">
              <Label>System</Label>
              <p className="text-xs text-muted-foreground">
                Retry Setup restarts the FoulFox OS services (local AI + agent) and
                re-runs first-boot provisioning. Only needed if the agent failed to
                start — e.g. after connecting WiFi.
              </p>
              <Button
                type="button"
                variant="outline"
                onClick={handleRestartServices}
                disabled={restartingServices}
                data-testid="button-restart-services"
              >
                <RefreshCw className={`mr-2 h-4 w-4 ${restartingServices ? "animate-spin" : ""}`} />
                {restartingServices ? "Restarting…" : "Retry Setup"}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

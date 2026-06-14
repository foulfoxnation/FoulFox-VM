import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import {
  Loader2,
  CheckCircle2,
  AlertTriangle,
  Monitor,
  Apple,
  Terminal as TermIcon,
} from "lucide-react";
import { useVmCapabilities, useCreateVm } from "@/hooks/use-vms";
import { provisionStreamUrl, type OsKind, type ProvisioningState } from "@/lib/vm-api";
import { useToast } from "@/hooks/use-toast";

const OS_META: { key: OsKind; label: string; icon: typeof Monitor; blurb: string }[] = [
  { key: "linux", label: "Linux", icon: TermIcon, blurb: "Ubuntu 24.04 — image auto-downloaded, SSH enabled for the agent." },
  { key: "windows", label: "Windows", icon: Monitor, blurb: "Blank disk + unattended answer file. Supply a Windows ISO to install." },
  { key: "macos", label: "macOS", icon: Apple, blurb: "Apple hardware only (licensing + Hypervisor.framework)." },
];

type Phase = "configure" | "provisioning";

function clamp(v: string, min: number, max: number): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return min;
  return Math.min(Math.max(n, min), max);
}

export function OsPicker({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreated: (vmId: string) => void;
}) {
  const { toast } = useToast();
  const caps = useVmCapabilities(open);
  const createVm = useCreateVm();

  const [phase, setPhase] = useState<Phase>("configure");
  const [osKind, setOsKind] = useState<OsKind>("linux");
  const [name, setName] = useState("");
  const [ramGb, setRamGb] = useState(2);
  const [cpuCores, setCpuCores] = useState(2);
  const [diskGb, setDiskGb] = useState(32);
  const [newVmId, setNewVmId] = useState<string | null>(null);
  const [prov, setProv] = useState<ProvisioningState | null>(null);

  // Reset to a clean configure state whenever the dialog is (re)opened.
  useEffect(() => {
    if (open) {
      setPhase("configure");
      setOsKind("linux");
      setName("");
      setRamGb(2);
      setCpuCores(2);
      setDiskGb(32);
      setNewVmId(null);
      setProv(null);
    }
  }, [open]);

  // Windows wants more headroom by default.
  useEffect(() => {
    if (osKind === "windows") {
      setRamGb((r) => Math.max(r, 4));
      setDiskGb((d) => Math.max(d, 64));
    }
  }, [osKind]);

  // Stream provisioning progress once a VM has been created.
  useEffect(() => {
    if (phase !== "provisioning" || !newVmId) return;
    const es = new EventSource(provisionStreamUrl(newVmId));
    es.onmessage = (ev) => {
      try {
        const s = JSON.parse(ev.data) as ProvisioningState;
        setProv(s);
        if (s.status === "ready" || s.status === "failed") es.close();
      } catch {
        /* ignore malformed frame */
      }
    };
    es.onerror = () => {
      /* EventSource auto-reconnects; ignore transient errors */
    };
    return () => es.close();
  }, [phase, newVmId]);

  const support = caps.data?.osSupport;
  const osSupported = (k: OsKind) => support?.[k]?.supported ?? k !== "macos";
  const maxRam = Math.max(2, Math.floor((caps.data?.totalRamGb ?? 8) * 0.5));
  const maxCpu = Math.max(1, caps.data?.cpuCount ?? 4);

  const handleCreate = () => {
    const fallback = OS_META.find((o) => o.key === osKind)?.label ?? "New";
    createVm.mutate(
      { name: name.trim() || `${fallback} VM`, osKind, ramGb, cpuCores, diskGb },
      {
        onSuccess: (vm) => {
          setNewVmId(vm.id);
          setProv(vm.provisioning);
          setPhase("provisioning");
        },
        onError: (e: Error) =>
          toast({ title: "Could not create VM", description: e.message, variant: "destructive" }),
      },
    );
  };

  const provReady = prov?.status === "ready";
  const provFailed = prov?.status === "failed";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[560px]" data-testid="os-picker">
        <DialogHeader>
          <DialogTitle>{phase === "configure" ? "New virtual machine" : "Provisioning your VM"}</DialogTitle>
          <DialogDescription>
            {phase === "configure"
              ? "Pick an operating system and resources. The image is downloaded and the disk built automatically."
              : "Hang tight — downloading the image and preparing the disk."}
          </DialogDescription>
        </DialogHeader>

        {phase === "configure" ? (
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-2">
              {OS_META.map((o) => {
                const supported = osSupported(o.key);
                const active = osKind === o.key;
                return (
                  <button
                    key={o.key}
                    type="button"
                    disabled={!supported}
                    onClick={() => setOsKind(o.key)}
                    className={`flex flex-col items-center gap-2 rounded-lg border p-3 text-center transition-colors ${
                      active ? "border-primary bg-primary/5" : "border-border hover:bg-muted/50"
                    } ${!supported ? "cursor-not-allowed opacity-50" : ""}`}
                    data-testid={`os-option-${o.key}`}
                  >
                    <o.icon className="h-6 w-6 text-primary" />
                    <span className="text-sm font-medium">{o.label}</span>
                  </button>
                );
              })}
            </div>

            {!osSupported(osKind) ? (
              <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-2.5">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                <p className="text-xs text-muted-foreground">
                  {support?.[osKind]?.reason ?? "This OS is not supported on this host."}
                </p>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">{OS_META.find((o) => o.key === osKind)?.blurb}</p>
            )}

            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="vm-name">Name</Label>
                <Input
                  id="vm-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={`${OS_META.find((o) => o.key === osKind)?.label} VM`}
                  data-testid="input-vm-name"
                />
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="vm-ram">RAM (GB)</Label>
                  <Input id="vm-ram" type="number" min={1} max={maxRam} value={ramGb} onChange={(e) => setRamGb(clamp(e.target.value, 1, maxRam))} data-testid="input-vm-ram" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="vm-cpu">CPU cores</Label>
                  <Input id="vm-cpu" type="number" min={1} max={maxCpu} value={cpuCores} onChange={(e) => setCpuCores(clamp(e.target.value, 1, maxCpu))} data-testid="input-vm-cpu" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="vm-disk">Disk (GB)</Label>
                  <Input id="vm-disk" type="number" min={8} max={256} value={diskGb} onChange={(e) => setDiskGb(clamp(e.target.value, 8, 256))} data-testid="input-vm-disk" />
                </div>
              </div>
            </div>

            {caps.data && !caps.data.accelerator.hardware && (
              <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-2.5">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                <p className="text-xs text-muted-foreground">
                  No hardware acceleration: {caps.data.accelerator.reason}. The VM will be created but
                  run slowly under software emulation.
                </p>
              </div>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <Button variant="ghost" onClick={() => onOpenChange(false)} data-testid="button-cancel-create">
                Cancel
              </Button>
              <Button onClick={handleCreate} disabled={!osSupported(osKind) || createVm.isPending} data-testid="button-confirm-create">
                {createVm.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Create VM
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4 py-2">
            <div className="flex items-center gap-3">
              {provReady ? (
                <CheckCircle2 className="h-5 w-5 text-green-500" />
              ) : provFailed ? (
                <AlertTriangle className="h-5 w-5 text-red-500" />
              ) : (
                <Loader2 className="h-5 w-5 animate-spin text-primary" />
              )}
              <span className="text-sm">{prov?.message || "Starting…"}</span>
            </div>
            {!provFailed && <Progress value={prov?.progress ?? 0} />}
            {provFailed && prov?.error && <p className="text-xs text-red-400">{prov.error}</p>}
            <div className="flex justify-end gap-2">
              {provReady ? (
                <Button onClick={() => newVmId && onCreated(newVmId)} data-testid="button-open-vm">
                  Open VM
                </Button>
              ) : (
                <Button variant="outline" onClick={() => newVmId && onCreated(newVmId)} data-testid="button-open-vm-bg">
                  Open in background
                </Button>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

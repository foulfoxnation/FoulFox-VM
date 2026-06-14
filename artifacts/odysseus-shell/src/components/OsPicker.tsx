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
import { useOsImages, useVmCapabilities, useCreateVm } from "@/hooks/use-vms";
import { provisionStreamUrl, type OsKind, type OsImage, type ProvisioningState } from "@/lib/vm-api";
import { useToast } from "@/hooks/use-toast";

// Icon per OS family — the catalog itself is fetched from the backend so the
// menu and the appliance never drift.
const FAMILY_ICON: Record<OsKind, typeof Monitor> = {
  linux: TermIcon,
  windows: Monitor,
  macos: Apple,
};

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
  const osImages = useOsImages(open);
  const caps = useVmCapabilities(open);
  const createVm = useCreateVm();
  const images = osImages.data ?? [];

  const [phase, setPhase] = useState<Phase>("configure");
  const [imageId, setImageId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [ramGb, setRamGb] = useState(4);
  const [cpuCores, setCpuCores] = useState(2);
  const [diskGb, setDiskGb] = useState(32);
  const [newVmId, setNewVmId] = useState<string | null>(null);
  const [prov, setProv] = useState<ProvisioningState | null>(null);

  const selected = images.find((i) => i.id === imageId) ?? null;

  // Selecting an OS also pulls in that image's recommended RAM/disk defaults.
  const selectImage = (img: OsImage) => {
    setImageId(img.id);
    setRamGb(img.defaultRamGb);
    setDiskGb(img.defaultDiskGb);
  };

  // Reset to a clean configure state whenever the dialog is (re)opened.
  useEffect(() => {
    if (open) {
      setPhase("configure");
      setImageId(null);
      setName("");
      setRamGb(4);
      setCpuCores(2);
      setDiskGb(32);
      setNewVmId(null);
      setProv(null);
    }
  }, [open]);

  // Once the catalog loads (or after a reset), default to the first supported
  // OS so the picker always opens on a usable selection.
  useEffect(() => {
    if (!open || images.length === 0) return;
    // Keep a still-valid, still-supported selection; otherwise fall to the first
    // supported image (so a late refetch marking the current pick unsupported
    // moves off it rather than leaving a dead selection).
    const current = images.find((i) => i.id === imageId);
    if (current && current.supported) return;
    selectImage(images.find((i) => i.supported) ?? current ?? images[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, images]);

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

  const maxRam = Math.max(2, Math.floor((caps.data?.totalRamGb ?? 8) * 0.5));
  const maxCpu = Math.max(1, caps.data?.cpuCount ?? 4);
  const selectedSupported = selected?.supported ?? false;

  const handleCreate = () => {
    if (!selected) return;
    createVm.mutate(
      {
        name: name.trim() || `${selected.label} VM`,
        osKind: selected.family,
        imageId: selected.id,
        ramGb,
        cpuCores,
        diskGb,
      },
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
            {osImages.isLoading ? (
              <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading operating systems…
              </div>
            ) : (
              <div className="grid grid-cols-3 gap-2">
                {images.map((img) => {
                  const Icon = FAMILY_ICON[img.family];
                  const active = imageId === img.id;
                  return (
                    <button
                      key={img.id}
                      type="button"
                      disabled={!img.supported}
                      onClick={() => selectImage(img)}
                      className={`flex flex-col items-center gap-1.5 rounded-lg border p-3 text-center transition-colors ${
                        active ? "border-primary bg-primary/5" : "border-border hover:bg-muted/50"
                      } ${!img.supported ? "cursor-not-allowed opacity-50" : ""}`}
                      data-testid={`os-option-${img.id}`}
                    >
                      <Icon className="h-6 w-6 text-primary" />
                      <span className="text-sm font-medium leading-tight">{img.label}</span>
                      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{img.stability}</span>
                    </button>
                  );
                })}
              </div>
            )}

            {selected && !selectedSupported ? (
              <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-2.5">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                <p className="text-xs text-muted-foreground">
                  {selected.reason || "This OS is not supported on this host."}
                </p>
              </div>
            ) : selected ? (
              <p className="text-xs text-muted-foreground">{selected.blurb}</p>
            ) : null}

            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="vm-name">Name</Label>
                <Input
                  id="vm-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={selected ? `${selected.label} VM` : "VM name"}
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
              <Button onClick={handleCreate} disabled={!selected || !selectedSupported || createVm.isPending} data-testid="button-confirm-create">
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

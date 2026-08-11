import { useEffect, useRef, useState, useCallback } from "react";
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
  HardDrive,
  ChevronLeft,
  GripVertical,
} from "lucide-react";
import { useOsImages, useVmCapabilities, useCreateVm } from "@/hooks/use-vms";
import { provisionStreamUrl, type OsKind, type OsImage, type ProvisioningState } from "@/lib/vm-api";
import { useToast } from "@/hooks/use-toast";

// Icon per OS family
const FAMILY_ICON: Record<OsKind, typeof Monitor> = {
  linux: TermIcon,
  windows: Monitor,
  macos: Apple,
};

type Phase = "configure" | "disk" | "provisioning";

function clamp(v: string | number, min: number, max: number): number {
  const n = typeof v === "number" ? Math.floor(v) : Math.floor(Number(v));
  if (!Number.isFinite(n)) return min;
  return Math.min(Math.max(n, min), max);
}

function fmt(gb: number): string {
  if (gb >= 1000) return `${(gb / 1000).toFixed(1)} TB`;
  return `${gb} GB`;
}

// ── Partition Bar ─────────────────────────────────────────────────────────────
// Visual representation: [OS reserved | Windows VM | Free]

const OS_RESERVE_GB = 30; // how much we show as "OS + apps" in the bar

interface VmPartitionBarProps {
  totalGb: number;   // 0 = unknown (dev / Replit)
  vmGb: number;
  onChangeVm: (v: number) => void;
  minVmGb: number;
  maxVmGb: number;
}

function VmPartitionBar({ totalGb, vmGb, onChangeVm, minVmGb, maxVmGb }: VmPartitionBarProps) {
  const barRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const known = totalGb > 0;
  const reservedGb = known ? Math.min(OS_RESERVE_GB, totalGb - minVmGb) : OS_RESERVE_GB;
  const displayTotal = known ? totalGb : reservedGb + vmGb + 50; // synthetic for dev
  const freeGb = Math.max(0, displayTotal - reservedGb - vmGb);

  const resPct  = (reservedGb  / displayTotal) * 100;
  const vmPct   = (vmGb        / displayTotal) * 100;
  const freePct = (freeGb      / displayTotal) * 100;

  const calcVmGb = useCallback((clientX: number): number => {
    if (!barRef.current) return vmGb;
    const rect = barRef.current.getBoundingClientRect();
    const fraction = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const rawGb = Math.round(fraction * displayTotal - reservedGb);
    return clamp(rawGb, minVmGb, maxVmGb);
  }, [displayTotal, reservedGb, minVmGb, maxVmGb, vmGb]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return;
    onChangeVm(calcVmGb(e.clientX));
  }, [calcVmGb, onChangeVm]);

  const startDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    dragging.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const stopDrag = () => { dragging.current = false; };

  const handleLeft = resPct + vmPct; // percentage from left

  return (
    <div className="space-y-3">
      {/* Visual bar */}
      <div
        ref={barRef}
        className="relative flex h-14 w-full overflow-hidden rounded-lg border border-border select-none"
        onPointerMove={handlePointerMove}
        onPointerUp={stopDrag}
        onPointerCancel={stopDrag}
      >
        {/* FoulFox OS + reserved */}
        <div
          className="flex h-full flex-col items-center justify-center overflow-hidden bg-cyan-900/60 text-xs text-cyan-200"
          style={{ width: `${resPct}%`, minWidth: 2 }}
        >
          {resPct > 8 && (
            <>
              <span className="truncate px-2 font-medium">FoulFox OS</span>
              <span className="truncate px-2 text-[11px] text-cyan-400">{fmt(reservedGb)}</span>
            </>
          )}
        </div>

        {/* Windows VM */}
        <div
          className="flex h-full flex-col items-center justify-center overflow-hidden bg-orange-900/60 text-xs text-orange-200"
          style={{ width: `${vmPct}%`, minWidth: 4 }}
        >
          {vmPct > 8 && (
            <>
              <span className="truncate px-2 font-medium">Windows VM</span>
              <span className="truncate px-2 text-[11px] text-orange-400">{fmt(vmGb)}</span>
            </>
          )}
        </div>

        {/* Drag handle */}
        <div
          className="absolute top-0 bottom-0 z-10 flex cursor-col-resize touch-none items-center justify-center"
          style={{ left: `${handleLeft}%`, transform: "translateX(-50%)", width: 20 }}
          onPointerDown={startDrag}
        >
          <div className="flex h-full w-1.5 items-center justify-center rounded bg-background/80 shadow">
            <GripVertical className="h-3 w-3 text-muted-foreground" />
          </div>
        </div>

        {/* Free space */}
        {freePct > 0.5 && (
          <div
            className="flex h-full flex-col items-center justify-center overflow-hidden bg-muted/40 text-[11px] text-muted-foreground"
            style={{ width: `${freePct}%` }}
          >
            {freePct > 6 && (
              <>
                <span>Free</span>
                <span>{fmt(freeGb)}</span>
              </>
            )}
          </div>
        )}
      </div>

      {/* Legend */}
      <div className="flex flex-wrap gap-3 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1">
          <span className="h-2.5 w-2.5 rounded-sm bg-cyan-800" />FoulFox OS {fmt(reservedGb)}
        </span>
        <span className="flex items-center gap-1">
          <span className="h-2.5 w-2.5 rounded-sm bg-orange-800" />Windows VM {fmt(vmGb)}
        </span>
        {known && freeGb > 0 && (
          <span className="flex items-center gap-1">
            <span className="h-2.5 w-2.5 rounded-sm bg-muted" />Free {fmt(freeGb)}
          </span>
        )}
      </div>
    </div>
  );
}

// ── OsPicker ──────────────────────────────────────────────────────────────────

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
  const [diskGb, setDiskGb] = useState(64);
  const [newVmId, setNewVmId] = useState<string | null>(null);
  const [prov, setProv] = useState<ProvisioningState | null>(null);

  const selected = images.find((i) => i.id === imageId) ?? null;
  const isWindows = selected?.family === "windows";

  const selectImage = (img: OsImage) => {
    setImageId(img.id);
    setRamGb(img.defaultRamGb);
    // Windows gets a larger default disk so the VM + OS both fit
    setDiskGb(img.family === "windows" ? 64 : img.defaultDiskGb);
  };

  // Reset state whenever the dialog is (re)opened.
  useEffect(() => {
    if (open) {
      setPhase("configure");
      setImageId(null);
      setName("");
      setRamGb(4);
      setCpuCores(2);
      setDiskGb(64);
      setNewVmId(null);
      setProv(null);
    }
  }, [open]);

  // Default to Windows 11 once the image catalog loads.
  useEffect(() => {
    if (!open || images.length === 0) return;
    const current = images.find((i) => i.id === imageId);
    if (current && current.supported) return;
    const win11 = images.find((i) => i.id === "windows-11" && i.supported);
    selectImage(win11 ?? images.find((i) => i.supported) ?? current ?? images[0]);
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
      } catch { /* ignore */ }
    };
    es.onerror = () => { /* EventSource auto-reconnects */ };
    return () => es.close();
  }, [phase, newVmId]);

  const maxRam = Math.max(2, Math.floor((caps.data?.totalRamGb ?? 8) * 0.5));
  const maxCpu = Math.max(1, caps.data?.cpuCount ?? 4);

  // Disk sizing for the partition step
  const totalDiskGb  = caps.data?.totalDiskGb  ?? 0;
  const freeDiskGb   = caps.data?.freeDiskGb   ?? 0;
  const knownDisk    = totalDiskGb > 0;
  const minVmDiskGb  = 32;
  const maxVmDiskGb  = knownDisk
    ? Math.max(minVmDiskGb, Math.min(512, freeDiskGb + diskGb)) // current alloc counts as "free"
    : 512;

  const diskTooLarge = knownDisk && diskGb > freeDiskGb + 5; // 5 GB slack

  const selectedSupported = selected?.supported ?? false;

  // "Next" from configure: Windows goes to disk step; others create directly.
  const handleConfigureNext = () => {
    if (!selected) return;
    if (isWindows) {
      setPhase("disk");
    } else {
      doCreate();
    }
  };

  const doCreate = () => {
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

  const provReady  = prov?.status === "ready";
  const provFailed = prov?.status === "failed";

  // ── Dialog titles & descriptions ────────────────────────────────────────────
  const dialogTitle = phase === "configure"
    ? "New virtual machine"
    : phase === "disk"
    ? "Allocate disk partition"
    : "Provisioning your VM";

  const dialogDesc = phase === "configure"
    ? "Pick an operating system and resources. The image is downloaded and the disk built automatically."
    : phase === "disk"
    ? "Set how much disk space to reserve for the Windows VM. Drag the handle or use the slider below."
    : "Hang tight — downloading the image and preparing the disk.";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[580px]" data-testid="os-picker">
        <DialogHeader>
          <DialogTitle>{dialogTitle}</DialogTitle>
          <DialogDescription>{dialogDesc}</DialogDescription>
        </DialogHeader>

        {/* ── PHASE: configure ─────────────────────────────────────────────── */}
        {phase === "configure" && (
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
              <div className={`grid gap-3 ${isWindows ? "grid-cols-2" : "grid-cols-3"}`}>
                <div className="space-y-1.5">
                  <Label htmlFor="vm-ram">RAM (GB)</Label>
                  <Input id="vm-ram" type="number" min={1} max={maxRam} value={ramGb}
                    onChange={(e) => setRamGb(clamp(e.target.value, 1, maxRam))}
                    data-testid="input-vm-ram" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="vm-cpu">CPU cores</Label>
                  <Input id="vm-cpu" type="number" min={1} max={maxCpu} value={cpuCores}
                    onChange={(e) => setCpuCores(clamp(e.target.value, 1, maxCpu))}
                    data-testid="input-vm-cpu" />
                </div>
                {/* Windows disk is set in the partition step; show it read-only here */}
                {!isWindows && (
                  <div className="space-y-1.5">
                    <Label htmlFor="vm-disk">Disk (GB)</Label>
                    <Input id="vm-disk" type="number" min={8} max={256} value={diskGb}
                      onChange={(e) => setDiskGb(clamp(e.target.value, 8, 256))}
                      data-testid="input-vm-disk" />
                  </div>
                )}
              </div>
              {isWindows && (
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <HardDrive className="h-3.5 w-3.5 text-orange-400" />
                  Disk partition will be configured in the next step.
                </p>
              )}
            </div>

            {caps.data && !caps.data.accelerator.hardware && (
              <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-2.5">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                <p className="text-xs text-muted-foreground">
                  No hardware acceleration: {caps.data.accelerator.reason}. The VM will run under
                  software emulation.
                </p>
              </div>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <Button variant="ghost" onClick={() => onOpenChange(false)} data-testid="button-cancel-create">
                Cancel
              </Button>
              <Button
                onClick={handleConfigureNext}
                disabled={!selected || !selectedSupported || createVm.isPending}
                data-testid="button-confirm-create"
              >
                {isWindows ? "Next — Allocate Disk" : (
                  <>
                    {createVm.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    Create VM
                  </>
                )}
              </Button>
            </div>
          </div>
        )}

        {/* ── PHASE: disk (Windows only) ───────────────────────────────────── */}
        {phase === "disk" && (
          <div className="space-y-5">
            {/* Partition bar */}
            <VmPartitionBar
              totalGb={totalDiskGb}
              vmGb={diskGb}
              onChangeVm={(v) => setDiskGb(clamp(v, minVmDiskGb, maxVmDiskGb))}
              minVmGb={minVmDiskGb}
              maxVmGb={maxVmDiskGb}
            />

            {/* Slider + number input */}
            <div className="space-y-2 rounded-lg border bg-muted/20 p-4">
              <div className="flex items-center justify-between text-xs">
                <label htmlFor="disk-slider" className="flex items-center gap-1.5 font-medium">
                  <span className="h-2 w-2 rounded-sm bg-orange-800" />
                  Windows VM partition
                </label>
                <span className="text-muted-foreground">
                  min {fmt(minVmDiskGb)} · max {fmt(maxVmDiskGb)}
                </span>
              </div>

              <div className="flex items-center gap-3">
                <input
                  id="disk-slider"
                  type="range"
                  min={minVmDiskGb}
                  max={maxVmDiskGb}
                  step={4}
                  value={diskGb}
                  onChange={(e) => setDiskGb(Number(e.target.value))}
                  className="h-1.5 flex-1 cursor-pointer accent-primary"
                />
                <div className="flex items-center gap-1">
                  <input
                    type="number"
                    min={minVmDiskGb}
                    max={maxVmDiskGb}
                    value={diskGb}
                    onChange={(e) => {
                      const n = parseInt(e.target.value, 10);
                      if (!isNaN(n)) setDiskGb(clamp(n, minVmDiskGb, maxVmDiskGb));
                    }}
                    className="w-20 rounded border bg-muted/40 px-2 py-1 text-right text-xs font-mono focus:outline-none focus:ring-1 focus:ring-primary"
                    data-testid="input-vm-disk"
                  />
                  <span className="text-xs text-muted-foreground">GB</span>
                </div>
              </div>

              <p className="text-xs text-muted-foreground">
                This sets the size of the Windows virtual disk image. Windows 11 needs at least 32 GB;
                64 GB or more recommended for software installs.
              </p>
            </div>

            {/* Disk budget warning */}
            {diskTooLarge && (
              <div className="flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/5 p-3">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />
                <p className="text-xs text-red-400">
                  {diskGb} GB requested but only {fmt(freeDiskGb)} free on the data partition.
                  Reduce the VM disk size or free up space first.
                </p>
              </div>
            )}

            {/* Dev-mode notice */}
            {!knownDisk && (
              <div className="flex items-start gap-2 rounded-md border border-amber-500/20 bg-amber-500/5 p-2.5">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />
                <p className="text-xs text-muted-foreground">
                  Running in dev mode — disk size is not checked against host capacity.
                  On real hardware the Windows VM partition is pre-allocated on the data disk.
                </p>
              </div>
            )}

            <div className="flex justify-between gap-2">
              <Button variant="outline" onClick={() => setPhase("configure")}>
                <ChevronLeft className="mr-1.5 h-4 w-4" />
                Back
              </Button>
              <Button
                onClick={doCreate}
                disabled={diskTooLarge || createVm.isPending}
                data-testid="button-allocate-create"
              >
                {createVm.isPending
                  ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Creating…</>
                  : `Allocate ${fmt(diskGb)} & Create VM`}
              </Button>
            </div>
          </div>
        )}

        {/* ── PHASE: provisioning ──────────────────────────────────────────── */}
        {phase === "provisioning" && (
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
            {provFailed && prov?.error && (
              <p className="text-xs text-red-400">{prov.error}</p>
            )}
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

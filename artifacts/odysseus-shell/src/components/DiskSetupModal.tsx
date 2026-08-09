/**
 * DiskSetupModal — Full-disk partition wizard for installing FoulFox OS.
 *
 * Step 1 — Select a disk
 * Step 2 — Visual partition editor (drag handles or type GB values)
 * Step 3 — Confirm destruction warning
 * Step 4 — Live SSE install progress
 * Step 5 — Done / error
 */
import {
  useRef, useState, useEffect, useCallback,
} from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import {
  HardDrive, Loader2, AlertTriangle, CheckCircle2,
  ChevronRight, ChevronLeft, GripVertical,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiUrl } from "@/lib/api-url";
import { authedFetch } from "@/lib/shell-token";

// ── Types ───────────────────────────────────────────────────────────────────

interface DiskCandidate {
  path: string;
  sizeBytes: number;
  sizeGb: number;
  model: string | null;
  removable: boolean;
  isBootDisk: boolean;
}

interface JobState {
  status: "idle" | "running" | "done" | "error";
  step: string;
  pct: number;
  msg: string;
  targetDisk: string | null;
}

type Step = "select" | "partition" | "confirm" | "installing" | "done";

// ── Constants ────────────────────────────────────────────────────────────────

const EFI_GB = 1;          // always 1 GB
const MIN_OS_GB = 60;      // minimum FoulFox OS partition
const MIN_VM_GB = 20;      // minimum Windows VM data partition
const DEFAULT_OS_GB = 150;
const DEFAULT_VM_GB = 100;

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmt(gb: number): string {
  if (gb >= 1000) return `${(gb / 1000).toFixed(1)} TB`;
  return `${gb} GB`;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

// ── Partition Bar ────────────────────────────────────────────────────────────

interface PartitionBarProps {
  totalGb: number;
  osGb: number;
  vmGb: number;
  onChangeOs: (v: number) => void;
  onChangeVm: (v: number) => void;
}

function PartitionBar({ totalGb, osGb, vmGb, onChangeOs, onChangeVm }: PartitionBarProps) {
  const barRef = useRef<HTMLDivElement>(null);
  const dragging = useRef<"os-vm" | "vm-free" | null>(null);

  const freeGb = Math.max(0, totalGb - EFI_GB - osGb - vmGb);

  const efiPct  = (EFI_GB / totalGb) * 100;
  const osPct   = (osGb   / totalGb) * 100;
  const vmPct   = (vmGb   / totalGb) * 100;
  const freePct = (freeGb / totalGb) * 100;

  const calcGbAt = useCallback((clientX: number): number => {
    if (!barRef.current) return 0;
    const rect = barRef.current.getBoundingClientRect();
    return clamp((clientX - rect.left) / rect.width, 0, 1) * totalGb;
  }, [totalGb]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return;
    const gbAt = calcGbAt(e.clientX);
    if (dragging.current === "os-vm") {
      // Drag changes OS size. EFI occupies first EFI_GB, OS starts there.
      const newOs = Math.round(gbAt - EFI_GB);
      onChangeOs(clamp(newOs, MIN_OS_GB, totalGb - EFI_GB - vmGb - MIN_VM_GB));
    } else {
      // Drag changes VM size. VM starts after EFI + OS.
      const newVm = Math.round(gbAt - EFI_GB - osGb);
      onChangeVm(clamp(newVm, MIN_VM_GB, totalGb - EFI_GB - osGb));
    }
  }, [calcGbAt, osGb, vmGb, totalGb, onChangeOs, onChangeVm]);

  const startDrag = (handle: "os-vm" | "vm-free") =>
    (e: React.PointerEvent<HTMLDivElement>) => {
      dragging.current = handle;
      e.currentTarget.setPointerCapture(e.pointerId);
    };

  const stopDrag = () => { dragging.current = null; };

  // Combined pointer handler on a single transparent overlay layer
  const handleDiv = (
    position: number, // percentage from left
    handle: "os-vm" | "vm-free",
    label: string,
  ) => (
    <div
      className="absolute top-0 bottom-0 z-10 flex cursor-col-resize touch-none items-center justify-center"
      style={{ left: `${position}%`, transform: "translateX(-50%)", width: 16 }}
      onPointerDown={startDrag(handle)}
      onPointerMove={handlePointerMove}
      onPointerUp={stopDrag}
      onPointerCancel={stopDrag}
      title={`Drag to resize ${label}`}
    >
      <div className="flex h-full w-1 items-center justify-center rounded bg-background/80 shadow-sm">
        <GripVertical className="h-3 w-3 text-muted-foreground" />
      </div>
    </div>
  );

  return (
    <div className="space-y-2">
      {/* Bar */}
      <div
        ref={barRef}
        className="relative flex h-14 w-full overflow-hidden rounded-lg border border-border select-none"
      >
        {/* EFI */}
        <div
          className="flex h-full flex-col items-center justify-center overflow-hidden bg-slate-700/60 text-[10px] text-slate-300"
          style={{ width: `${efiPct}%`, minWidth: 2 }}
        >
          {efiPct > 2 && <span className="truncate px-1">EFI</span>}
        </div>

        {/* FoulFox OS */}
        <div
          className="flex h-full flex-col items-center justify-center overflow-hidden bg-cyan-900/60 text-xs text-cyan-200"
          style={{ width: `${osPct}%` }}
        >
          <span className="truncate px-2 font-medium">FoulFox OS</span>
          <span className="truncate px-2 text-[11px] text-cyan-400">{fmt(osGb)}</span>
        </div>

        {/* Handle: OS | VM */}
        {handleDiv(efiPct + osPct, "os-vm", "FoulFox OS / Windows VM")}

        {/* Windows VM data */}
        <div
          className="flex h-full flex-col items-center justify-center overflow-hidden bg-orange-900/60 text-xs text-orange-200"
          style={{ width: `${vmPct}%` }}
        >
          <span className="truncate px-2 font-medium">Windows VM</span>
          <span className="truncate px-2 text-[11px] text-orange-400">{fmt(vmGb)}</span>
        </div>

        {/* Handle: VM | Free */}
        {freeGb > 0.5 && handleDiv(efiPct + osPct + vmPct, "vm-free", "Windows VM / Free")}

        {/* Free space */}
        {freePct > 0.5 && (
          <div
            className="flex h-full flex-col items-center justify-center overflow-hidden bg-muted/40 text-[11px] text-muted-foreground"
            style={{ width: `${freePct}%` }}
          >
            {freePct > 5 && (
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
          <span className="h-2.5 w-2.5 rounded-sm bg-slate-600" />EFI {fmt(EFI_GB)}
        </span>
        <span className="flex items-center gap-1">
          <span className="h-2.5 w-2.5 rounded-sm bg-cyan-800" />FoulFox OS {fmt(osGb)}
        </span>
        <span className="flex items-center gap-1">
          <span className="h-2.5 w-2.5 rounded-sm bg-orange-800" />Windows VM {fmt(vmGb)}
        </span>
        {freeGb > 0 && (
          <span className="flex items-center gap-1">
            <span className="h-2.5 w-2.5 rounded-sm bg-muted" />Free {fmt(freeGb)}
          </span>
        )}
      </div>
    </div>
  );
}

// ── Size Input ────────────────────────────────────────────────────────────────

function SizeInput({
  label, value, onChange, min, max, recommended, color,
}: {
  label: string; value: number; onChange: (v: number) => void;
  min: number; max: number; recommended: number; color: string;
}) {
  const [raw, setRaw] = useState(String(value));

  useEffect(() => { setRaw(String(value)); }, [value]);

  const commit = () => {
    const n = parseInt(raw, 10);
    if (!isNaN(n)) onChange(clamp(n, min, max));
    else setRaw(String(value));
  };

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <label className="flex items-center gap-1.5 text-xs font-medium text-foreground">
          <span className={`h-2 w-2 rounded-sm ${color}`} />
          {label}
        </label>
        <div className="flex items-center gap-2">
          {value === recommended && (
            <Badge variant="outline" className="border-green-500/40 py-0 text-[10px] text-green-400">
              Recommended
            </Badge>
          )}
          <span className="text-xs text-muted-foreground">
            min {fmt(min)} · max {fmt(max)}
          </span>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <input
          type="range"
          min={min}
          max={max}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="h-1.5 flex-1 cursor-pointer accent-primary"
        />
        <div className="flex items-center gap-1">
          <input
            type="number"
            value={raw}
            min={min}
            max={max}
            onChange={(e) => setRaw(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => e.key === "Enter" && commit()}
            className="w-20 rounded border bg-muted/40 px-2 py-1 text-right text-xs font-mono focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <span className="text-xs text-muted-foreground">GB</span>
        </div>
      </div>
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

interface DiskSetupModalProps {
  /** If true, the modal opens automatically (live-USB first-boot scenario). */
  autoOpen?: boolean;
  /** Render trigger button. If omitted, a default "Install to Disk" button is shown. */
  trigger?: React.ReactNode;
}

export function DiskSetupModal({ autoOpen = false, trigger }: DiskSetupModalProps) {
  const [open, setOpen] = useState(autoOpen);
  const [step, setStep] = useState<Step>("select");

  // Disk selection
  const [candidates, setCandidates] = useState<DiskCandidate[]>([]);
  const [helperAvailable, setHelperAvailable] = useState<boolean | null>(null);
  const [loadingCandidates, setLoadingCandidates] = useState(false);
  const [selectedDisk, setSelectedDisk] = useState<DiskCandidate | null>(null);

  // Partition sizes
  const [osGb, setOsGb] = useState(DEFAULT_OS_GB);
  const [vmGb, setVmGb] = useState(DEFAULT_VM_GB);

  // Job progress
  const [job, setJob] = useState<JobState>({ status: "idle", step: "", pct: 0, msg: "", targetDisk: null });
  const sseRef = useRef<EventSource | null>(null);

  const { toast } = useToast();

  const totalGb = selectedDisk?.sizeGb ?? 0;
  const used = EFI_GB + osGb + vmGb;
  const tooSmall = totalGb > 0 && used > totalGb;
  const minRequired = EFI_GB + MIN_OS_GB + MIN_VM_GB;

  // ── Data loading ──────────────────────────────────────────────────────────

  useEffect(() => {
    if (!open) return;
    setLoadingCandidates(true);

    fetch(apiUrl("/api/os/disk-install/status"))
      .then((r) => r.json())
      .then((s: JobState) => {
        setJob(s);
        if (s.status === "running") setStep("installing");
        else if (s.status === "done") setStep("done");
        else if (s.status === "error") setStep("done");
      })
      .catch(() => {});

    fetch(apiUrl("/api/os/disk-install/candidates"))
      .then((r) => r.json())
      .then((d: { helperAvailable: boolean; disks: DiskCandidate[] }) => {
        setHelperAvailable(d.helperAvailable ?? false);
        setCandidates(d.disks ?? []);
      })
      .catch(() => setHelperAvailable(false))
      .finally(() => setLoadingCandidates(false));
  }, [open]);

  // ── SSE progress ──────────────────────────────────────────────────────────

  useEffect(() => {
    if (!open || step !== "installing") return;
    if (sseRef.current) sseRef.current.close();
    const es = new EventSource(apiUrl("/api/os/disk-install/stream"));
    sseRef.current = es;
    es.onmessage = (e) => {
      try {
        const s: JobState = JSON.parse(e.data);
        setJob(s);
        if (s.status === "done" || s.status === "error") {
          setStep("done");
          es.close();
        }
      } catch { /* ignore */ }
    };
    es.onerror = () => es.close();
    return () => { es.close(); sseRef.current = null; };
  }, [open, step]);

  // ── Actions ───────────────────────────────────────────────────────────────

  const reset = () => {
    setStep("select");
    setSelectedDisk(null);
    setOsGb(DEFAULT_OS_GB);
    setVmGb(DEFAULT_VM_GB);
    setJob({ status: "idle", step: "", pct: 0, msg: "", targetDisk: null });
  };

  const startInstall = async () => {
    if (!selectedDisk) return;
    try {
      const resp = await authedFetch("/api/os/disk-install/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          targetDisk: selectedDisk.path,
          osSizeGb: osGb,
          dataSizeGb: vmGb,
        }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        toast({ title: "Failed to start install", description: data.error, variant: "destructive" });
        return;
      }
      setJob({ status: "running", step: "starting", pct: 0, msg: "Starting…", targetDisk: selectedDisk.path });
      setStep("installing");
    } catch (e) {
      toast({ title: "Failed to start install", description: (e as Error).message, variant: "destructive" });
    }
  };

  // ── Constrained setters (ensure sizes fit) ────────────────────────────────

  const setOsGbConstrained = useCallback((v: number) => {
    const clamped = clamp(v, MIN_OS_GB, Math.max(MIN_OS_GB, totalGb - EFI_GB - vmGb));
    setOsGb(clamped);
  }, [totalGb, vmGb]);

  const setVmGbConstrained = useCallback((v: number) => {
    const clamped = clamp(v, MIN_VM_GB, Math.max(MIN_VM_GB, totalGb - EFI_GB - osGb));
    setVmGb(clamped);
  }, [totalGb, osGb]);

  // Reset sizes when a new disk is selected
  const selectDisk = (disk: DiskCandidate) => {
    setSelectedDisk(disk);
    // Fit defaults into this disk
    const avail = disk.sizeGb - EFI_GB;
    const newOs = clamp(DEFAULT_OS_GB, MIN_OS_GB, avail - MIN_VM_GB);
    const newVm = clamp(DEFAULT_VM_GB, MIN_VM_GB, avail - newOs);
    setOsGb(newOs);
    setVmGb(newVm);
    setStep("partition");
  };

  const installable = candidates.filter((d) => !d.isBootDisk && d.sizeGb >= minRequired);
  const tooSmallDisks = candidates.filter((d) => !d.isBootDisk && d.sizeGb < minRequired);

  // ── Render ────────────────────────────────────────────────────────────────

  const triggerEl = trigger ?? (
    <Button variant="outline" size="sm" data-testid="button-disk-install">
      <HardDrive className="mr-1.5 h-3.5 w-3.5" />
      Install to Disk
    </Button>
  );

  return (
    <Dialog open={open} onOpenChange={(v) => {
      setOpen(v);
      if (!v && step !== "installing") reset();
    }}>
      {/* Don't render trigger button when autoOpen (it opens itself) */}
      {!autoOpen && (
        <div onClick={() => setOpen(true)} className="contents cursor-pointer">
          {triggerEl}
        </div>
      )}

      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <HardDrive className="h-5 w-5" />
            {step === "select" && "Install FoulFox OS — Select Disk"}
            {step === "partition" && "Configure Partitions"}
            {step === "confirm" && "Confirm Installation"}
            {step === "installing" && "Installing…"}
            {step === "done" && (job.status === "done" ? "Installation Complete" : "Installation Failed")}
          </DialogTitle>
        </DialogHeader>

        {/* ── STEP 1: Select disk ────────────────────────────────────────── */}
        {step === "select" && (
          <div className="space-y-4">
            {helperAvailable === false && (
              <div className="rounded-lg border border-yellow-500/20 bg-yellow-500/5 p-3 text-sm text-yellow-400">
                The disk-install helper is only available when booted from a FoulFox OS USB stick.
              </div>
            )}

            {loadingCandidates && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Detecting disks…
              </div>
            )}

            {!loadingCandidates && helperAvailable !== false && (
              <>
                <p className="text-sm text-muted-foreground">
                  Choose the internal drive to install FoulFox OS onto. The drive will be
                  partitioned and the existing contents <strong className="text-foreground">permanently erased</strong>.
                  Minimum {fmt(minRequired)} required.
                </p>

                {installable.length === 0 && tooSmallDisks.length === 0 && (
                  <p className="rounded border p-3 text-sm text-muted-foreground">
                    No eligible internal disks found. Connect your target drive and reload.
                  </p>
                )}

                {installable.length > 0 && (
                  <div className="space-y-2">
                    {installable.map((disk) => (
                      <button
                        key={disk.path}
                        type="button"
                        onClick={() => selectDisk(disk)}
                        className="flex w-full items-center gap-3 rounded-lg border border-border p-3 text-left transition-colors hover:border-primary/50 hover:bg-muted/30"
                        data-testid={`disk-option-${disk.path.replace(/\//g, "-")}`}
                      >
                        <HardDrive className="h-6 w-6 shrink-0 text-muted-foreground" />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-sm font-medium">{disk.path}</span>
                            {disk.removable && (
                              <Badge variant="secondary" className="text-[10px]">Removable</Badge>
                            )}
                          </div>
                          {disk.model && (
                            <span className="text-xs text-muted-foreground">{disk.model}</span>
                          )}
                        </div>
                        <div className="text-right">
                          <div className="text-sm font-medium">{fmt(disk.sizeGb)}</div>
                          <ChevronRight className="ml-auto h-4 w-4 text-muted-foreground" />
                        </div>
                      </button>
                    ))}
                  </div>
                )}

                {tooSmallDisks.length > 0 && (
                  <div className="space-y-1">
                    <p className="text-xs text-muted-foreground">Too small (min {fmt(minRequired)}):</p>
                    {tooSmallDisks.map((disk) => (
                      <div
                        key={disk.path}
                        className="flex items-center gap-3 rounded-lg border border-border/50 p-3 opacity-40"
                      >
                        <HardDrive className="h-5 w-5 shrink-0 text-muted-foreground" />
                        <span className="font-mono text-sm">{disk.path}</span>
                        {disk.model && <span className="text-xs text-muted-foreground">{disk.model}</span>}
                        <Badge variant="secondary" className="ml-auto text-[10px]">{fmt(disk.sizeGb)}</Badge>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* ── STEP 2: Partition editor ───────────────────────────────────── */}
        {step === "partition" && selectedDisk && (
          <div className="space-y-5">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">
                Disk: <span className="font-mono text-foreground">{selectedDisk.path}</span>
                {selectedDisk.model && <span className="ml-1 text-xs">· {selectedDisk.model}</span>}
              </span>
              <Badge variant="secondary">{fmt(selectedDisk.sizeGb)} total</Badge>
            </div>

            {/* Visual bar */}
            <PartitionBar
              totalGb={totalGb}
              osGb={osGb}
              vmGb={vmGb}
              onChangeOs={setOsGbConstrained}
              onChangeVm={setVmGbConstrained}
            />

            {/* Size inputs */}
            <div className="space-y-4 rounded-lg border bg-muted/20 p-4">
              <p className="text-xs text-muted-foreground">
                Drag the handles above or adjust sizes below. The Windows VM partition
                stores virtual disk images — larger means more room for Windows + installed games/software.
              </p>

              <SizeInput
                label="FoulFox OS partition"
                value={osGb}
                onChange={setOsGbConstrained}
                min={MIN_OS_GB}
                max={totalGb - EFI_GB - MIN_VM_GB}
                recommended={DEFAULT_OS_GB}
                color="bg-cyan-800"
              />

              <SizeInput
                label="Windows VM data partition"
                value={vmGb}
                onChange={setVmGbConstrained}
                min={MIN_VM_GB}
                max={totalGb - EFI_GB - osGb}
                recommended={DEFAULT_VM_GB}
                color="bg-orange-800"
              />

              <div className="rounded border border-border/40 bg-muted/30 p-3">
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">EFI boot partition</span>
                  <span className="font-mono">{fmt(EFI_GB)} (fixed)</span>
                </div>
                <div className="mt-1 flex justify-between text-xs">
                  <span className="text-muted-foreground">Total required</span>
                  <span className={`font-mono ${tooSmall ? "text-red-400" : "text-foreground"}`}>
                    {fmt(used)} / {fmt(totalGb)}
                  </span>
                </div>
              </div>

              {tooSmall && (
                <div className="flex items-center gap-2 rounded border border-red-500/30 bg-red-500/5 p-3 text-sm text-red-400">
                  <AlertTriangle className="h-4 w-4 shrink-0" />
                  Partitions exceed disk size by {fmt(used - totalGb)}. Reduce one or both sizes.
                </div>
              )}
            </div>

            <div className="flex justify-between">
              <Button variant="outline" onClick={() => setStep("select")}>
                <ChevronLeft className="mr-1.5 h-4 w-4" /> Back
              </Button>
              <Button
                disabled={tooSmall}
                onClick={() => setStep("confirm")}
                data-testid="button-next-confirm"
              >
                Review & Install <ChevronRight className="ml-1.5 h-4 w-4" />
              </Button>
            </div>
          </div>
        )}

        {/* ── STEP 3: Confirm ────────────────────────────────────────────── */}
        {step === "confirm" && selectedDisk && (
          <div className="space-y-5">
            {/* Partition summary */}
            <div className="rounded-lg border bg-muted/20 p-4 space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Target disk</span>
                <span className="font-mono">{selectedDisk.path} ({fmt(selectedDisk.sizeGb)})</span>
              </div>
              <div className="flex justify-between">
                <span className="flex items-center gap-1.5 text-muted-foreground">
                  <span className="h-2 w-2 rounded-sm bg-slate-600" />EFI
                </span>
                <span>{fmt(EFI_GB)}</span>
              </div>
              <div className="flex justify-between">
                <span className="flex items-center gap-1.5 text-muted-foreground">
                  <span className="h-2 w-2 rounded-sm bg-cyan-800" />FoulFox OS
                </span>
                <span>{fmt(osGb)}</span>
              </div>
              <div className="flex justify-between">
                <span className="flex items-center gap-1.5 text-muted-foreground">
                  <span className="h-2 w-2 rounded-sm bg-orange-800" />Windows VM data
                </span>
                <span>{fmt(vmGb)}</span>
              </div>
            </div>

            {/* Destructive warning */}
            <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-4 space-y-2">
              <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />
                <p className="text-sm text-red-400">
                  <strong>Everything on {selectedDisk.path} will be permanently erased</strong>, including
                  any existing operating system. This cannot be undone.
                  Remove the USB stick only after the installation completes.
                </p>
              </div>
            </div>

            <div className="flex justify-between">
              <Button variant="outline" onClick={() => setStep("partition")}>
                <ChevronLeft className="mr-1.5 h-4 w-4" /> Back
              </Button>
              <Button variant="destructive" onClick={startInstall} data-testid="button-start-install">
                Erase &amp; Install FoulFox OS
              </Button>
            </div>
          </div>
        )}

        {/* ── STEP 4: Installing ─────────────────────────────────────────── */}
        {step === "installing" && (
          <div className="space-y-4">
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="flex items-center gap-1.5 text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  {job.msg || "Installing…"}
                </span>
                <span className="font-mono text-xs text-muted-foreground">{job.pct}%</span>
              </div>
              <Progress value={job.pct} className="h-2" />
            </div>
            <p className="text-xs text-muted-foreground">
              Installing to <span className="font-mono">{job.targetDisk}</span>.
              Do <strong>not</strong> remove the USB stick until installation is complete.
            </p>
          </div>
        )}

        {/* ── STEP 5: Done / Error ───────────────────────────────────────── */}
        {step === "done" && (
          <div className="space-y-4">
            {job.status === "done" ? (
              <div className="flex items-start gap-3 rounded-lg border border-green-500/20 bg-green-500/5 p-4">
                <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-green-500" />
                <div>
                  <p className="font-medium text-green-400">Installation complete</p>
                  <p className="mt-1 text-sm text-muted-foreground">{job.msg}</p>
                  <p className="mt-2 text-xs text-muted-foreground">
                    Remove the USB stick and reboot. FoulFox OS will start from the internal disk.
                  </p>
                </div>
              </div>
            ) : (
              <div className="flex items-start gap-3 rounded-lg border border-red-500/20 bg-red-500/5 p-4">
                <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-500" />
                <div>
                  <p className="font-medium text-red-400">Installation failed</p>
                  <p className="mt-1 text-sm text-muted-foreground">{job.msg}</p>
                </div>
              </div>
            )}
            <div className="flex justify-end gap-2">
              {job.status === "error" && (
                <Button variant="outline" onClick={reset}>Try Again</Button>
              )}
              <Button variant="outline" onClick={() => setOpen(false)}>Close</Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

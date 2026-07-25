import { useState, useEffect, useRef } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { HardDrive, Loader2, AlertTriangle, CheckCircle2, ChevronRight } from "lucide-react";
import { useShellToken } from "@/hooks/use-shell-token";
import { useToast } from "@/hooks/use-toast";
import { apiUrl } from "@/lib/api-url";

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

function formatSize(gb: number): string {
  if (gb >= 1000) return `${(gb / 1000).toFixed(1)} TB`;
  return `${gb} GB`;
}

export function DiskInstallPanel() {
  const [open, setOpen] = useState(false);
  const [candidates, setCandidates] = useState<DiskCandidate[]>([]);
  const [helperAvailable, setHelperAvailable] = useState<boolean | null>(null);
  const [loadingCandidates, setLoadingCandidates] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [job, setJob] = useState<JobState>({ status: "idle", step: "", pct: 0, msg: "", targetDisk: null });
  const sseRef = useRef<EventSource | null>(null);
  const { data: shellToken } = useShellToken();
  const { toast } = useToast();

  // Load current status and candidates when dialog opens.
  useEffect(() => {
    if (!open) return;
    setLoadingCandidates(true);

    // Fetch current job status first (handles page reload mid-install).
    fetch(apiUrl("/api/os/disk-install/status"))
      .then((r) => r.json())
      .then((s) => setJob(s))
      .catch(() => {});

    // Fetch candidate disks.
    fetch(apiUrl("/api/os/disk-install/candidates"))
      .then((r) => r.json())
      .then((d) => {
        setHelperAvailable(d.helperAvailable ?? false);
        setCandidates(d.disks ?? []);
      })
      .catch(() => setHelperAvailable(false))
      .finally(() => setLoadingCandidates(false));
  }, [open]);

  // Subscribe to SSE progress when an install is running.
  useEffect(() => {
    if (!open || (job.status !== "running" && job.status !== "idle")) return;
    if (sseRef.current) { sseRef.current.close(); }

    const es = new EventSource(apiUrl("/api/os/disk-install/stream"));
    sseRef.current = es;
    es.onmessage = (e) => {
      try { setJob(JSON.parse(e.data)); } catch { /* ignore */ }
    };
    es.onerror = () => es.close();
    return () => { es.close(); sseRef.current = null; };
  }, [open, job.status]);

  const startInstall = async () => {
    if (!selected || !shellToken) return;
    try {
      const resp = await fetch(apiUrl("/api/os/disk-install/start"), {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Shell-Token": shellToken },
        body: JSON.stringify({ targetDisk: selected }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        toast({ title: "Failed to start install", description: data.error, variant: "destructive" });
        return;
      }
      setJob({ status: "running", step: "starting", pct: 0, msg: "Starting…", targetDisk: selected });
    } catch (e) {
      toast({ title: "Failed to start install", description: (e as Error).message, variant: "destructive" });
    }
  };

  const reset = () => {
    setSelected(null);
    setConfirmed(false);
    setJob({ status: "idle", step: "", pct: 0, msg: "", targetDisk: null });
  };

  const installable = candidates.filter((d) => !d.isBootDisk && !d.removable);
  const isRunning = job.status === "running";
  const isDone = job.status === "done";
  const isError = job.status === "error";

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v && !isRunning) reset(); }}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" data-testid="button-disk-install">
          <HardDrive className="mr-1.5 h-3.5 w-3.5" />
          Install to Disk
        </Button>
      </DialogTrigger>

      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <HardDrive className="h-5 w-5" />
            Install FoulFox OS to Internal Disk
          </DialogTitle>
        </DialogHeader>

        {/* ── Progress / result view ── */}
        {(isRunning || isDone || isError) && (
          <div className="space-y-4">
            {isDone && (
              <div className="flex items-start gap-3 rounded-lg border border-green-500/20 bg-green-500/5 p-4">
                <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-green-500" />
                <div>
                  <p className="font-medium text-green-400">Installation complete</p>
                  <p className="mt-1 text-sm text-muted-foreground">{job.msg}</p>
                </div>
              </div>
            )}
            {isError && (
              <div className="flex items-start gap-3 rounded-lg border border-red-500/20 bg-red-500/5 p-4">
                <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-500" />
                <div>
                  <p className="font-medium text-red-400">Installation failed</p>
                  <p className="mt-1 text-sm text-muted-foreground">{job.msg}</p>
                </div>
              </div>
            )}
            {isRunning && (
              <div className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="flex items-center gap-1.5 text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    {job.msg || "Installing…"}
                  </span>
                  <span className="font-mono text-xs text-muted-foreground">{job.pct}%</span>
                </div>
                <Progress value={job.pct} className="h-2" />
                <p className="text-xs text-muted-foreground">
                  Installing to <span className="font-mono">{job.targetDisk}</span>. Do not remove the USB stick yet.
                </p>
              </div>
            )}
            {(isDone || isError) && (
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => { reset(); setOpen(false); }}>Close</Button>
                {isError && <Button variant="outline" onClick={reset}>Try Again</Button>}
                {isDone && (
                  <p className="self-center text-xs text-muted-foreground">
                    Remove the USB stick and reboot to boot from the installed disk.
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        {/* ── Selection flow (not running / done / error) ── */}
        {!isRunning && !isDone && !isError && (
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
                  Choose an internal disk to install FoulFox OS onto. <strong className="text-foreground">Everything on the selected disk will be erased.</strong>
                </p>

                {installable.length === 0 ? (
                  <p className="rounded border p-3 text-sm text-muted-foreground">
                    No eligible internal disks found. Make sure the target drive is connected and not the USB boot stick.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {installable.map((disk) => (
                      <button
                        key={disk.path}
                        type="button"
                        onClick={() => { setSelected(disk.path); setConfirmed(false); }}
                        className={`flex w-full items-center gap-3 rounded-lg border p-3 text-left transition-colors ${
                          selected === disk.path
                            ? "border-primary bg-primary/5"
                            : "border-border hover:border-primary/40 hover:bg-muted/30"
                        }`}
                        data-testid={`disk-option-${disk.path.replace(/\//g, "-")}`}
                      >
                        <HardDrive className="h-5 w-5 shrink-0 text-muted-foreground" />
                        <div className="min-w-0 flex-1">
                          <span className="font-mono text-sm font-medium">{disk.path}</span>
                          {disk.model && <span className="ml-2 text-xs text-muted-foreground">{disk.model}</span>}
                        </div>
                        <Badge variant="secondary" className="shrink-0 text-xs">
                          {formatSize(disk.sizeGb)}
                        </Badge>
                      </button>
                    ))}
                  </div>
                )}

                {selected && !confirmed && (
                  <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-4 space-y-3">
                    <div className="flex items-start gap-2">
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />
                      <p className="text-sm text-red-400">
                        <strong>This will permanently erase all data on{" "}
                        <span className="font-mono">{selected}</span></strong>, including any existing operating system. This cannot be undone.
                      </p>
                    </div>
                    <Button
                      variant="destructive"
                      className="w-full"
                      onClick={() => setConfirmed(true)}
                      data-testid="button-confirm-erase"
                    >
                      I understand — erase disk and install FoulFox OS
                    </Button>
                  </div>
                )}

                {selected && confirmed && (
                  <div className="flex justify-end gap-2 border-t pt-4">
                    <Button variant="outline" onClick={() => { setSelected(null); setConfirmed(false); }}>
                      Cancel
                    </Button>
                    <Button
                      onClick={startInstall}
                      disabled={!shellToken}
                      data-testid="button-start-install"
                    >
                      <ChevronRight className="mr-1.5 h-4 w-4" />
                      Start Installation
                    </Button>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

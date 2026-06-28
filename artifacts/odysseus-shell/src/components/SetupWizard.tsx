import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Loader2,
  CheckCircle2,
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  MonitorCog,
  Gamepad2,
  Compass,
  HardDrive,
  Wand2,
  Wrench,
  Terminal,
} from "lucide-react";
import { apiUrl } from "@/lib/api-url";
import { useShellToken } from "@/hooks/use-shell-token";
import { useToast } from "@/hooks/use-toast";

// First-run onboarding for the Odysseus 3-agent suite. Renders only when a suite
// exists but is not yet marked setup_complete (or no suite at all). Steps:
//  0 Welcome + service reachability, 1 per-agent model selection,
//  2 Windows VM capability detection (honest), 3 review + provision.

type Role = "windows" | "game" | "architect";

type SuiteState = {
  suite: null | {
    id: string;
    name: string;
    setup_complete: boolean;
    members: { role: string }[];
  };
  roles: { role: string; name: string; description: string }[];
};

type ModelItem = {
  endpoint_id: string;
  endpoint_name: string;
  models: string[];
  offline?: boolean;
};
type ModelsResp = { items: ModelItem[] };

type Caps = {
  canBootVm: boolean;
  kvm: boolean;
  kvmReason: string;
  qemuSystem: boolean;
  qemuImg: boolean;
  platform: string;
  arch: string;
  message: string;
};

type VmSizing = { diskGb: number; ramGb: number; cpuCores: number };

type SizingPlan = {
  tier: string;
  diskGb: number;
  ramGb: number;
  cpuCores: number;
  reserveGb: number;
  vmBudgetGb: number;
  diskKnown: boolean;
  totalDiskGb: number;
  freeDiskGb: number;
  totalRamGb: number;
  cpuCount: number;
  notes: string[];
};

type StoragePlanResp = {
  plan: SizingPlan;
  current:
    | { ramGb: number; cpuCores: number; diskGb: number; diskPath: string | null; diskExists: boolean }
    | null;
  canBootVm: boolean;
};

type DiskInfo = {
  path: string;
  sizeBytes: number;
  model: string | null;
  removable: boolean;
  isBootDisk: boolean;
};
type PartitionsResp = {
  helperAvailable: boolean;
  bootDisk: string | null;
  persistExists: boolean;
  persistLabel: string;
  disks: DiskInfo[];
};
type DryRunResp = {
  ok: boolean;
  canApply?: boolean;
  persistExists?: boolean;
  device?: string;
  model?: string;
  tableType?: string;
  freeBytes?: number;
  plannedBytes?: number;
  persistLabel?: string;
  fingerprint?: string;
  code?: string;
  reason?: string;
  error?: string;
};
type ApplyResp = {
  ok: boolean;
  device?: string;
  partition?: string;
  partitionCreated?: boolean;
  formatted?: boolean;
  needsReboot?: boolean;
  bytes?: number;
  reason?: string;
  code?: string;
  error?: string;
};

const ROLES: { key: Role; label: string; icon: typeof MonitorCog }[] = [
  { key: "windows", label: "Windows Agent", icon: MonitorCog },
  { key: "game", label: "Game Agent", icon: Gamepad2 },
  { key: "architect", label: "FoulFox OS Architect", icon: Compass },
];

async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(apiUrl(path));
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return r.json();
}

// Select values are encoded "<endpoint_id>::<model>". endpoint_id never contains
// "::", so split on the FIRST occurrence to keep model names with "::" intact.
function parseSel(v: string | undefined): { endpoint_id: string; model: string } | null {
  if (!v) return null;
  const i = v.indexOf("::");
  if (i < 0) return null;
  return { endpoint_id: v.slice(0, i), model: v.slice(i + 2) };
}

const selectClass =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

const inputClass = selectClass;

export function SetupWizard() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [step, setStep] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [sel, setSel] = useState<Record<string, string>>({});

  const stateQ = useQuery({
    queryKey: ["agent-suite-state"],
    queryFn: () => getJson<SuiteState>("/api/odysseus/api/agent-suite/state"),
  });

  const needsSetup =
    !!stateQ.data && (!stateQ.data.suite || !stateQ.data.suite.setup_complete);
  const open = needsSetup && !dismissed;

  const modelsQ = useQuery({
    queryKey: ["models"],
    queryFn: () => getJson<ModelsResp>("/api/odysseus/api/models"),
    enabled: open,
  });
  const capsQ = useQuery({
    queryKey: ["vm-caps"],
    queryFn: () => getJson<Caps>("/api/vm/capabilities"),
    enabled: open,
  });
  const planQ = useQuery({
    queryKey: ["storage-plan"],
    queryFn: () => getJson<StoragePlanResp>("/api/setup/storage/plan"),
    enabled: open,
  });
  const partitionsQ = useQuery({
    queryKey: ["storage-partitions"],
    queryFn: () => getJson<PartitionsResp>("/api/setup/storage/partitions"),
    enabled: open,
  });
  const shellTokenQ = useShellToken();
  // null = "use the recommendation"; an object = a user override.
  const [sizing, setSizing] = useState<VmSizing | null>(null);
  // Storage step: which persistence path the user picked, + the typed erase
  // confirmation that gates the destructive apply.
  const [partMode, setPartMode] = useState<"auto" | "manual" | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const CONFIRM_PHRASE = "ERASE FREE SPACE";

  const modelOptions = useMemo(() => {
    const opts: { value: string; label: string }[] = [];
    for (const it of modelsQ.data?.items ?? []) {
      if (it.offline) continue;
      for (const m of it.models ?? []) {
        opts.push({ value: `${it.endpoint_id}::${m}`, label: `${it.endpoint_name} · ${m}` });
      }
    }
    return opts;
  }, [modelsQ.data]);

  const provision = useMutation({
    mutationFn: async () => {
      const role_models: Record<string, { endpoint_id: string; model: string }> = {};
      for (const r of ROLES) {
        const parsed = parseSel(sel[r.key]);
        if (parsed) role_models[r.key] = parsed;
      }
      const res = await fetch(apiUrl("/api/odysseus/api/agent-suite/provision"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: stateQ.data?.suite?.name || "FoulFox OS Suite",
          role_models,
          setup_complete: true,
        }),
      });
      if (!res.ok) throw new Error(`provision → ${res.status}`);
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["agent-suite-state"] });
      toast({ title: "Setup complete", description: "Your 3-agent suite is ready." });
      setDismissed(true);
    },
    onError: (e) =>
      toast({ title: "Setup failed", variant: "destructive", description: String(e) }),
  });

  const applySizing = useMutation({
    mutationFn: async (body: VmSizing) => {
      const token = shellTokenQ.data;
      const res = await fetch(apiUrl("/api/setup/storage/vm-sizing"), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { "X-Shell-Token": token } : {}),
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(j?.error || `vm-sizing → ${res.status}`);
      }
      return res.json();
    },
  });

  // Plan the persistence partition (read-only). The device is a confirmation
  // hint; the device-side helper still derives the real boot disk itself.
  const dryRun = useMutation({
    mutationFn: async (device: string | null): Promise<DryRunResp> => {
      const token = shellTokenQ.data;
      const res = await fetch(apiUrl("/api/setup/storage/partition/dry-run"), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { "X-Shell-Token": token } : {}),
        },
        body: JSON.stringify(device ? { device } : {}),
      });
      const j = (await res.json().catch(() => null)) as DryRunResp | null;
      if (!res.ok) throw new Error(j?.error || j?.reason || `dry-run → ${res.status}`);
      return j as DryRunResp;
    },
    onError: (e) =>
      toast({ title: "Couldn't read the disk", variant: "destructive", description: String(e) }),
  });

  // DESTRUCTIVE: create + format the persistence partition. confirm:true is sent
  // only after the user types the erase phrase in the UI.
  const applyPartition = useMutation({
    mutationFn: async (input: { device: string | null; fingerprint?: string }): Promise<ApplyResp> => {
      const token = shellTokenQ.data;
      const res = await fetch(apiUrl("/api/setup/storage/partition/apply"), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { "X-Shell-Token": token } : {}),
        },
        body: JSON.stringify({
          ...(input.device ? { device: input.device } : {}),
          ...(input.fingerprint ? { fingerprint: input.fingerprint } : {}),
          confirm: true,
        }),
      });
      const j = (await res.json().catch(() => null)) as ApplyResp | null;
      if (!res.ok) throw new Error(j?.error || j?.reason || `apply → ${res.status}`);
      return j as ApplyResp;
    },
    onSuccess: (d) => {
      qc.invalidateQueries({ queryKey: ["storage-partitions"] });
      toast({
        title: d.formatted ? "Persistence partition created" : "Partition created",
        description: d.reason || "Reboot to activate durable storage.",
      });
    },
    onError: (e) =>
      toast({ title: "Auto-partition failed", variant: "destructive", description: String(e) }),
  });

  // Save the (possibly adjusted) VM sizing, then provision the agent suite. A
  // correctable sizing error (e.g. over budget) stops here so the user can fix it.
  const finishSetup = async () => {
    const plan = planQ.data?.plan;
    const body =
      sizing ?? (plan ? { diskGb: plan.diskGb, ramGb: plan.ramGb, cpuCores: plan.cpuCores } : null);
    if (body) {
      try {
        await applySizing.mutateAsync(body);
      } catch (e) {
        toast({ title: "VM sizing not saved", variant: "destructive", description: String(e) });
        return;
      }
    }
    provision.mutate();
  };

  if (!open) return null;

  const steps = ["Welcome", "Models", "Windows VM", "Storage", "Review"];

  return (
    <Dialog open={open} onOpenChange={(o) => !o && setDismissed(true)}>
      <DialogContent className="sm:max-w-[580px] max-h-[88vh] overflow-y-auto" data-testid="setup-wizard">
        <DialogHeader>
          <DialogTitle>Set up your FoulFox OS agent suite</DialogTitle>
          <DialogDescription>
            Pick a model for each agent and check Windows VM readiness — takes a minute.
          </DialogDescription>
        </DialogHeader>

        {/* Step indicator */}
        <div className="flex items-center gap-2 pb-1">
          {steps.map((s, i) => (
            <div key={s} className="flex items-center gap-2">
              <div
                className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-medium ${
                  i === step
                    ? "bg-primary text-primary-foreground"
                    : i < step
                    ? "bg-primary/20 text-primary"
                    : "bg-muted text-muted-foreground"
                }`}
              >
                {i < step ? <CheckCircle2 className="h-4 w-4" /> : i + 1}
              </div>
              <span className={`text-xs ${i === step ? "font-medium" : "text-muted-foreground"}`}>{s}</span>
              {i < steps.length - 1 && <div className="h-px w-4 bg-border" />}
            </div>
          ))}
        </div>

        <div className="min-h-[260px] py-2">
          {/* Step 0 — Welcome */}
          {step === 0 && (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                FoulFox OS runs as three coordinated agents. The Architect reviews the
                workers' results and only signs off when the work passes.
              </p>
              <div className="space-y-2">
                {(stateQ.data?.roles ?? []).map((r) => {
                  const meta = ROLES.find((x) => x.key === (r.role as Role));
                  const Icon = meta?.icon ?? Compass;
                  return (
                    <div key={r.role} className="flex items-start gap-3 rounded-md border p-3">
                      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                      <div>
                        <div className="text-sm font-medium">{r.name}</div>
                        <div className="text-xs text-muted-foreground">{r.description}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="flex items-center gap-2 text-xs">
                {stateQ.isLoading ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                ) : stateQ.data ? (
                  <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />
                ) : (
                  <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
                )}
                <span className="text-muted-foreground">
                  {stateQ.data ? "FoulFox OS service reachable" : "FoulFox OS service unreachable"}
                </span>
              </div>
            </div>
          )}

          {/* Step 1 — Model selection per agent */}
          {step === 1 && (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Choose a model for each agent. Each agent is model-agnostic — you can
                change these later in FoulFox OS settings.
              </p>
              {modelsQ.isLoading ? (
                <div className="flex justify-center p-6">
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>
              ) : modelOptions.length === 0 ? (
                <div className="flex items-start gap-3 rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                  <p className="text-xs text-muted-foreground">
                    No model providers detected yet. Your agents will use the current
                    default chat model. Add a provider (Ollama, LM Studio, OpenAI, …)
                    in FoulFox OS → Settings → Models, then re-run setup to assign a
                    specific model per agent.
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  {ROLES.map((r) => (
                    <div key={r.key} className="space-y-1.5">
                      <Label htmlFor={`model-${r.key}`} className="flex items-center gap-2">
                        <r.icon className="h-3.5 w-3.5 text-primary" />
                        {r.label}
                      </Label>
                      <select
                        id={`model-${r.key}`}
                        className={selectClass}
                        value={sel[r.key] ?? ""}
                        onChange={(e) => setSel((s) => ({ ...s, [r.key]: e.target.value }))}
                        data-testid={`select-model-${r.key}`}
                      >
                        <option value="">Use default chat model</option>
                        {modelOptions.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Step 2 — Windows VM capability */}
          {step === 2 && (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                The Windows Agent drives a real Windows VM. We checked whether this
                machine can boot one.
              </p>
              {capsQ.isLoading ? (
                <div className="flex justify-center p-6">
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>
              ) : capsQ.data ? (
                <div
                  className={`flex items-start gap-3 rounded-md border p-3 ${
                    capsQ.data.canBootVm
                      ? "border-green-500/40 bg-green-500/5"
                      : "border-amber-500/40 bg-amber-500/5"
                  }`}
                >
                  {capsQ.data.canBootVm ? (
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-500" />
                  ) : (
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                  )}
                  <div className="space-y-2">
                    <p className="text-sm">{capsQ.data.message}</p>
                    <ul className="text-xs text-muted-foreground space-y-0.5">
                      <li>KVM acceleration: {capsQ.data.kvm ? "available" : "unavailable"}</li>
                      <li>QEMU system emulator: {capsQ.data.qemuSystem ? "installed" : "not installed"}</li>
                      <li>QEMU disk tools: {capsQ.data.qemuImg ? "installed" : "not installed"}</li>
                      <li>Host: {capsQ.data.platform}/{capsQ.data.arch}</li>
                    </ul>
                  </div>
                </div>
              ) : (
                <div className="flex items-start gap-3 rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                  <p className="text-xs text-muted-foreground">
                    Could not detect VM capability. The other agents still work; you can
                    configure the VM later on a machine with hardware virtualization.
                  </p>
                </div>
              )}

              {/* Hardware-tiered Windows VM sizing */}
              {planQ.isLoading ? (
                <div className="flex justify-center p-4">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              ) : planQ.data?.plan ? (
                (() => {
                  const plan = planQ.data.plan;
                  const rec: VmSizing = {
                    diskGb: plan.diskGb,
                    ramGb: plan.ramGb,
                    cpuCores: plan.cpuCores,
                  };
                  const eff = sizing ?? rec;
                  const diskMax = plan.diskKnown && plan.vmBudgetGb > 0 ? plan.vmBudgetGb : undefined;
                  const ramMax = plan.totalRamGb > 0 ? Math.max(1, Math.floor(plan.totalRamGb / 2)) : undefined;
                  const cpuMax = plan.cpuCount > 0 ? plan.cpuCount : undefined;
                  const set = (patch: Partial<VmSizing>) =>
                    setSizing((s) => ({ ...(s ?? rec), ...patch }));
                  const toInt = (v: string, min: number) => {
                    const n = Math.floor(Number(v));
                    return Number.isFinite(n) ? Math.max(min, n) : min;
                  };
                  return (
                    <div className="space-y-3 rounded-md border p-3" data-testid="vm-sizing-panel">
                      <div className="flex items-center gap-2">
                        <HardDrive className="h-4 w-4 text-primary" />
                        <span className="text-sm font-medium">Windows VM size</span>
                        <span className="ml-auto text-[11px] uppercase tracking-wide text-muted-foreground">
                          {plan.tier} tier
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Sized to your hardware — conservative on a small machine, larger on a capable
                        one.{" "}
                        {plan.diskKnown
                          ? `Detected ${plan.totalDiskGb}GB disk · ${plan.totalRamGb}GB RAM · ${plan.cpuCount} CPU. Holding ${plan.reserveGb}GB back for FoulFox OS + your apps leaves ${plan.vmBudgetGb}GB for VMs.`
                          : "Disk size couldn't be detected — using safe defaults you can adjust."}
                      </p>
                      <div className="grid grid-cols-3 gap-3">
                        <div className="space-y-1">
                          <Label htmlFor="size-disk" className="text-xs">
                            Disk (GB)
                          </Label>
                          <input
                            id="size-disk"
                            type="number"
                            min={8}
                            max={diskMax}
                            className={inputClass}
                            value={eff.diskGb}
                            onChange={(e) => set({ diskGb: toInt(e.target.value, 8) })}
                            data-testid="input-size-disk"
                          />
                        </div>
                        <div className="space-y-1">
                          <Label htmlFor="size-ram" className="text-xs">
                            RAM (GB)
                          </Label>
                          <input
                            id="size-ram"
                            type="number"
                            min={1}
                            max={ramMax}
                            className={inputClass}
                            value={eff.ramGb}
                            onChange={(e) => set({ ramGb: toInt(e.target.value, 1) })}
                            data-testid="input-size-ram"
                          />
                        </div>
                        <div className="space-y-1">
                          <Label htmlFor="size-cpu" className="text-xs">
                            CPU cores
                          </Label>
                          <input
                            id="size-cpu"
                            type="number"
                            min={1}
                            max={cpuMax}
                            className={inputClass}
                            value={eff.cpuCores}
                            onChange={(e) => set({ cpuCores: toInt(e.target.value, 1) })}
                            data-testid="input-size-cpu"
                          />
                        </div>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-muted-foreground">
                          Recommended: {rec.diskGb}GB · {rec.ramGb}GB RAM · {rec.cpuCores} CPU
                        </span>
                        {sizing && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 text-xs"
                            onClick={() => setSizing(null)}
                            data-testid="button-reset-sizing"
                          >
                            Reset to recommended
                          </Button>
                        )}
                      </div>
                      {planQ.data.current?.diskExists && (
                        <p className="text-xs text-amber-600 dark:text-amber-500">
                          A Windows disk image already exists — RAM and CPU changes apply, but the
                          disk keeps its current size unless it's recreated.
                        </p>
                      )}
                    </div>
                  );
                })()
              ) : null}
            </div>
          )}

          {/* Step 3 — Storage persistence (auto vs manual) */}
          {step === 3 &&
            (() => {
              const pinfo = partitionsQ.data;
              const dr = dryRun.data;
              const ar = applyPartition.data;
              const gb = (b?: number) =>
                typeof b === "number" ? (b / 1024 ** 3).toFixed(b < 1024 ** 3 * 10 ? 1 : 0) : "?";
              const bootDisk = pinfo?.bootDisk ?? null;
              const dev = bootDisk ?? "/dev/sdX";
              const label = pinfo?.persistLabel ?? "foulfox-persist";
              const cardCls = (active: boolean) =>
                `w-full text-left rounded-md border p-3 transition-colors ${
                  active ? "border-primary bg-primary/5" : "hover:bg-muted/50"
                }`;
              return (
                <div className="space-y-4">
                  <p className="text-sm text-muted-foreground">
                    A fresh FoulFox USB runs entirely in RAM — the Windows ISO and your VM are{" "}
                    <span className="font-medium">lost on reboot</span>. Add a{" "}
                    <span className="font-medium">{label}</span> partition so your storage survives a
                    restart.
                  </p>

                  {partitionsQ.isLoading ? (
                    <div className="flex justify-center p-6">
                      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                    </div>
                  ) : pinfo?.persistExists ? (
                    <div className="flex items-start gap-3 rounded-md border border-green-500/40 bg-green-500/5 p-3">
                      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-500" />
                      <p className="text-sm">
                        Durable storage is already set up — a{" "}
                        <span className="font-medium">{label}</span> partition exists. Nothing to do
                        here.
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      <button
                        type="button"
                        onClick={() => setPartMode("auto")}
                        className={cardCls(partMode === "auto")}
                        data-testid="choice-partition-auto"
                      >
                        <div className="flex items-center gap-2">
                          <Wand2 className="h-4 w-4 text-primary" />
                          <span className="text-sm font-medium">Auto-partition this drive for me</span>
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">
                          Create the {label} partition in the free space on the FoulFox USB. Only
                          unused space is touched — existing partitions are never modified.
                        </p>
                      </button>

                      <button
                        type="button"
                        onClick={() => setPartMode("manual")}
                        className={cardCls(partMode === "manual")}
                        data-testid="choice-partition-manual"
                      >
                        <div className="flex items-center gap-2">
                          <Wrench className="h-4 w-4 text-primary" />
                          <span className="text-sm font-medium">I&apos;ll partition it myself</span>
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">
                          Show the exact commands to add the partition by hand from a Linux machine.
                        </p>
                      </button>

                      {partMode === "auto" && (
                        <div className="space-y-3 rounded-md border p-3">
                          {pinfo && !pinfo.helperAvailable ? (
                            <div className="flex items-start gap-3">
                              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                              <p className="text-xs text-muted-foreground">
                                Auto-partitioning runs on the FoulFox OS device itself — it isn&apos;t
                                available in this preview. Boot the USB to use it, or partition
                                manually.
                              </p>
                            </div>
                          ) : !bootDisk ? (
                            <div className="flex items-start gap-3">
                              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                              <p className="text-xs text-muted-foreground">
                                Couldn&apos;t identify the drive FoulFox booted from. Use the manual
                                option instead.
                              </p>
                            </div>
                          ) : (
                            <>
                              <p className="text-xs text-muted-foreground">
                                Target drive: <span className="font-medium">{dev}</span>
                                {(() => {
                                  const d = pinfo?.disks.find((x) => x.isBootDisk);
                                  return d ? ` · ${d.model ?? "USB drive"} · ${gb(d.sizeBytes)}GB` : "";
                                })()}
                              </p>

                              {!dr || !dr.ok ? (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => dryRun.mutate(bootDisk)}
                                  disabled={dryRun.isPending}
                                  data-testid="button-partition-preview"
                                >
                                  {dryRun.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                                  Preview changes
                                </Button>
                              ) : !dr.canApply ? (
                                <div className="flex items-start gap-3 rounded-md border border-amber-500/40 bg-amber-500/5 p-2.5">
                                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                                  <p className="text-xs">
                                    {dr.reason || "This drive can&apos;t be auto-partitioned."}
                                  </p>
                                </div>
                              ) : ar?.partitionCreated ? (
                                <div className="flex items-start gap-3 rounded-md border border-green-500/40 bg-green-500/5 p-2.5">
                                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-500" />
                                  <p className="text-xs">
                                    {ar.reason ||
                                      "Persistence partition created. Reboot to activate durable storage."}
                                  </p>
                                </div>
                              ) : (
                                <div className="space-y-2 rounded-md border border-red-500/40 bg-red-500/5 p-3">
                                  <p className="text-xs">
                                    Will create a{" "}
                                    <span className="font-medium">{gb(dr.plannedBytes)}GB ext4</span>{" "}
                                    partition labelled{" "}
                                    <span className="font-medium">{dr.persistLabel}</span> in the free
                                    space on <span className="font-medium">{dr.device}</span>. Existing
                                    partitions are left untouched. Type{" "}
                                    <span className="font-mono font-medium">{CONFIRM_PHRASE}</span> to
                                    confirm.
                                  </p>
                                  <input
                                    className={inputClass}
                                    value={confirmText}
                                    onChange={(e) => setConfirmText(e.target.value)}
                                    placeholder={CONFIRM_PHRASE}
                                    data-testid="input-partition-confirm"
                                  />
                                  <Button
                                    size="sm"
                                    variant="destructive"
                                    disabled={
                                      confirmText.trim() !== CONFIRM_PHRASE || applyPartition.isPending
                                    }
                                    onClick={() =>
                                      applyPartition.mutate({
                                        device: dr.device ?? bootDisk,
                                        fingerprint: dr.fingerprint,
                                      })
                                    }
                                    data-testid="button-partition-apply"
                                  >
                                    {applyPartition.isPending && (
                                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                    )}
                                    Create persistence partition
                                  </Button>
                                </div>
                              )}
                            </>
                          )}
                        </div>
                      )}

                      {partMode === "manual" && (
                        <div className="space-y-2 rounded-md border p-3">
                          <div className="flex items-center gap-2">
                            <Terminal className="h-4 w-4 text-primary" />
                            <span className="text-sm font-medium">Manual partition steps</span>
                          </div>
                          <p className="text-xs text-muted-foreground">
                            From a Linux machine (replace <span className="font-mono">{dev}</span> with
                            your USB device and <span className="font-mono">N</span> with the new
                            partition number):
                          </p>
                          <pre className="overflow-x-auto rounded bg-muted p-2 text-[11px] leading-relaxed">
{`sudo parted ${dev} unit MiB print free
sudo parted ${dev} --script -- mkpart primary ext4 START 100%
sudo partprobe ${dev}
sudo mkfs.ext4 -L ${label} ${dev}N
sudo mount ${dev}N /mnt
echo "/ union" | sudo tee /mnt/persistence.conf`}
                          </pre>
                          <p className="text-xs text-muted-foreground">
                            Replace <span className="font-mono">START</span> with the free-region start
                            shown by the first command. Full guide: docs/flash.md →
                            &ldquo;Make storage persistent&rdquo;.
                          </p>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })()}

          {/* Step 4 — Review */}
          {step === 4 && (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">Review and finish setup.</p>
              <div className="space-y-2">
                {ROLES.map((r) => {
                  const parsed = parseSel(sel[r.key]);
                  const label = parsed ? parsed.model : "Default chat model";
                  return (
                    <div key={r.key} className="flex items-center justify-between rounded-md border p-2.5">
                      <span className="flex items-center gap-2 text-sm">
                        <r.icon className="h-3.5 w-3.5 text-primary" />
                        {r.label}
                      </span>
                      <span className="text-xs text-muted-foreground">{label}</span>
                    </div>
                  );
                })}
                <div className="flex items-center justify-between rounded-md border p-2.5">
                  <span className="text-sm">Windows VM</span>
                  <span className="text-xs text-muted-foreground">
                    {capsQ.data?.canBootVm ? "Ready to boot" : "Not bootable on this host"}
                  </span>
                </div>
                {planQ.data?.plan &&
                  (() => {
                    const plan = planQ.data.plan;
                    const eff =
                      sizing ?? { diskGb: plan.diskGb, ramGb: plan.ramGb, cpuCores: plan.cpuCores };
                    return (
                      <div className="flex items-center justify-between rounded-md border p-2.5">
                        <span className="text-sm">VM size</span>
                        <span className="text-xs text-muted-foreground" data-testid="text-review-sizing">
                          {eff.diskGb}GB disk · {eff.ramGb}GB RAM · {eff.cpuCores} CPU
                        </span>
                      </div>
                    );
                  })()}
                <div className="flex items-center justify-between rounded-md border p-2.5">
                  <span className="text-sm">Durable storage</span>
                  <span className="text-xs text-muted-foreground" data-testid="text-review-storage">
                    {partitionsQ.data?.persistExists || applyPartition.data?.partitionCreated
                      ? "Persistence ready — reboot to activate"
                      : "Running in RAM (set up in the Storage step)"}
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer nav */}
        <div className="flex items-center justify-between pt-2">
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            onClick={() => setDismissed(true)}
            data-testid="button-skip-setup"
          >
            Skip for now
          </Button>
          <div className="flex gap-2">
            {step > 0 && (
              <Button variant="outline" size="sm" onClick={() => setStep((s) => s - 1)} data-testid="button-wizard-back">
                <ChevronLeft className="mr-1 h-4 w-4" /> Back
              </Button>
            )}
            {step < steps.length - 1 ? (
              <Button size="sm" onClick={() => setStep((s) => s + 1)} data-testid="button-wizard-next">
                Next <ChevronRight className="ml-1 h-4 w-4" />
              </Button>
            ) : (
              <Button
                size="sm"
                onClick={() => void finishSetup()}
                disabled={provision.isPending || applySizing.isPending}
                data-testid="button-wizard-finish"
              >
                {(provision.isPending || applySizing.isPending) && (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                )}
                Finish setup
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

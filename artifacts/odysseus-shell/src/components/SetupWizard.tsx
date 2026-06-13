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
} from "lucide-react";
import { apiUrl } from "@/lib/api-url";
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

const ROLES: { key: Role; label: string; icon: typeof MonitorCog }[] = [
  { key: "windows", label: "Windows Agent", icon: MonitorCog },
  { key: "game", label: "Game Agent", icon: Gamepad2 },
  { key: "architect", label: "Odysseus Architect", icon: Compass },
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
          name: stateQ.data?.suite?.name || "Odysseus Suite",
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

  if (!open) return null;

  const steps = ["Welcome", "Models", "Windows VM", "Review"];

  return (
    <Dialog open={open} onOpenChange={(o) => !o && setDismissed(true)}>
      <DialogContent className="sm:max-w-[580px] max-h-[88vh] overflow-y-auto" data-testid="setup-wizard">
        <DialogHeader>
          <DialogTitle>Set up your Odysseus agent suite</DialogTitle>
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
                Odysseus runs as three coordinated agents. The Architect reviews the
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
                  {stateQ.data ? "Odysseus service reachable" : "Odysseus service unreachable"}
                </span>
              </div>
            </div>
          )}

          {/* Step 1 — Model selection per agent */}
          {step === 1 && (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Choose a model for each agent. Each agent is model-agnostic — you can
                change these later in Odysseus settings.
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
                    in Odysseus → Settings → Models, then re-run setup to assign a
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
            </div>
          )}

          {/* Step 3 — Review */}
          {step === 3 && (
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
                onClick={() => provision.mutate()}
                disabled={provision.isPending}
                data-testid="button-wizard-finish"
              >
                {provision.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Finish setup
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

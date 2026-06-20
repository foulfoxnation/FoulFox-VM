import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Cpu,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  ChevronDown,
  PlugZap,
} from "lucide-react";
import { apiUrl } from "@/lib/api-url";
import { useShellToken } from "@/hooks/use-shell-token";
import { useToast } from "@/hooks/use-toast";

// Self-serve "bring your own model" flow: connect a self-hosted llama (Ollama /
// LM Studio) reached over a tunnel and point the whole agent suite at it, so AI
// runs on the user's own hardware instead of a paid API. The privileged
// model-endpoint writes go through the api-server's /api/local-model/* routes,
// which inject the Odysseus admin token server-side (the browser never sees it).

type TestResp = {
  online: boolean;
  status: string;
  models: string[];
  count: number;
  ping_error?: string | null;
};

type CreateResp = {
  id: string;
  name: string;
  base_url: string;
  models: string[];
  online: boolean;
  status: string;
  ping_error?: string | null;
};

type SuiteState = {
  suite: null | { id: string; name: string; setup_complete: boolean };
};

const ROLE_KEYS = ["windows", "game", "architect"] as const;

const selectClass =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(apiUrl(path));
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return r.json();
}

async function postJson<T>(path: string, body: unknown, token?: string): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers["x-shell-token"] = token;
  const r = await fetch(apiUrl(path), {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const data = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (!r.ok) {
    const msg = (data.error as string) || (data.detail as string) || `Request failed (${r.status})`;
    throw new Error(msg);
  }
  return data as T;
}

export function ConnectLlamaModal() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: shellToken } = useShellToken();
  const [open, setOpen] = useState(false);

  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [secret, setSecret] = useState("");
  const [showHelp, setShowHelp] = useState(false);

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResp | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<CreateResp | null>(null);
  const [selectedModel, setSelectedModel] = useState("");
  const [provisioning, setProvisioning] = useState(false);

  const stateQ = useQuery({
    queryKey: ["agent-suite-state"],
    queryFn: () => getJson<SuiteState>("/api/odysseus/api/agent-suite/state"),
    enabled: open,
  });

  function reset() {
    setName("");
    setUrl("");
    setSecret("");
    setShowHelp(false);
    setTesting(false);
    setTestResult(null);
    setError(null);
    setSaving(false);
    setSaved(null);
    setSelectedModel("");
    setProvisioning(false);
  }

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    setError(null);
    try {
      const res = await postJson<TestResp>(
        "/api/local-model/test",
        { base_url: url.trim(), api_key: secret.trim() },
        shellToken,
      );
      setTestResult(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setTesting(false);
    }
  }

  async function handleConnect() {
    setSaving(true);
    setError(null);
    try {
      const res = await postJson<CreateResp>(
        "/api/local-model/endpoints",
        { name: name.trim(), base_url: url.trim(), api_key: secret.trim() },
        shellToken,
      );
      setSaved(res);
      setSelectedModel(res.models?.[0] ?? "");
      qc.invalidateQueries({ queryKey: ["models"] });
      toast({ title: "Local model connected", description: res.name });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function handleUseForAgents() {
    if (!saved || !selectedModel) return;
    setProvisioning(true);
    try {
      const role_models: Record<string, { endpoint_id: string; model: string }> = {};
      for (const r of ROLE_KEYS) {
        role_models[r] = { endpoint_id: saved.id, model: selectedModel };
      }
      const r = await fetch(apiUrl("/api/odysseus/api/agent-suite/provision"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: stateQ.data?.suite?.name || "FoulFox OS Suite",
          role_models,
          setup_complete: true,
        }),
      });
      if (!r.ok) throw new Error(`provision → ${r.status}`);
      qc.invalidateQueries({ queryKey: ["agent-suite-state"] });
      qc.invalidateQueries({ queryKey: ["models"] });
      toast({
        title: "Agents updated",
        description: `All agents now run on ${selectedModel}.`,
      });
      setOpen(false);
      reset();
    } catch (e) {
      toast({
        title: "Could not update agents",
        variant: "destructive",
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setProvisioning(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2" data-testid="button-connect-llama">
          <Cpu className="h-4 w-4" />
          Connect local model
        </Button>
      </DialogTrigger>
      <DialogContent
        className="sm:max-w-[560px] max-h-[88vh] overflow-y-auto"
        data-testid="connect-llama-modal"
      >
        <DialogHeader>
          <DialogTitle>Connect your own local model</DialogTitle>
          <DialogDescription>
            Point FoulFox at a model running on your own computer (Ollama or LM Studio)
            over a tunnel. Your agents then run on your hardware — no per-call AI charges.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-1">
          {/* Connection form */}
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="llama-url">Local model URL</Label>
              <Input
                id="llama-url"
                placeholder="https://your-tunnel.trycloudflare.com"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                disabled={!!saved}
                data-testid="input-llama-url"
              />
              <p className="text-xs text-muted-foreground">
                The public tunnel URL for your Ollama / LM Studio server. We add{" "}
                <code>/v1</code> automatically if it's missing.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="llama-name">Name (optional)</Label>
                <Input
                  id="llama-name"
                  placeholder="My local model"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  disabled={!!saved}
                  data-testid="input-llama-name"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="llama-secret">Secret (optional)</Label>
                <Input
                  id="llama-secret"
                  type="password"
                  placeholder="If your server needs a key"
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                  disabled={!!saved}
                  data-testid="input-llama-secret"
                />
              </div>
            </div>
          </div>

          {/* Error / test result */}
          {error && (
            <div className="flex items-start gap-2 rounded-md border border-red-500/40 bg-red-500/5 p-3 text-xs">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />
              <span>{error}</span>
            </div>
          )}
          {testResult && !saved && !error && (
            <div
              className={`flex items-start gap-2 rounded-md border p-3 text-xs ${
                testResult.online
                  ? "border-green-500/40 bg-green-500/5"
                  : "border-amber-500/40 bg-amber-500/5"
              }`}
            >
              {testResult.online ? (
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-500" />
              ) : (
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
              )}
              <span>
                {testResult.online
                  ? `Reachable — found ${testResult.count} model${
                      testResult.count === 1 ? "" : "s"
                    }.`
                  : `Couldn't reach that URL${
                      testResult.ping_error ? `: ${testResult.ping_error}` : "."
                    }`}
              </span>
            </div>
          )}

          {/* Pre-save actions */}
          {!saved && (
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleTest}
                disabled={!url.trim() || testing || saving || !shellToken}
                data-testid="button-test-llama"
              >
                {testing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Test connection
              </Button>
              <Button
                size="sm"
                onClick={handleConnect}
                disabled={!url.trim() || saving || !shellToken}
                data-testid="button-save-llama"
              >
                {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Connect
              </Button>
            </div>
          )}

          {/* Post-save: assign to the agent suite */}
          {saved && (
            <div className="space-y-3 rounded-md border border-green-500/30 bg-green-500/5 p-3">
              <div className="flex items-center gap-2 text-sm font-medium">
                <CheckCircle2 className="h-4 w-4 text-green-500" />
                {saved.name} connected
              </div>
              {saved.models?.length ? (
                <>
                  <div className="space-y-1.5">
                    <Label htmlFor="llama-model">Model to use</Label>
                    <select
                      id="llama-model"
                      className={selectClass}
                      value={selectedModel}
                      onChange={(e) => setSelectedModel(e.target.value)}
                      data-testid="select-llama-model"
                    >
                      {saved.models.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                  </div>
                  <Button
                    size="sm"
                    className="w-full gap-2"
                    onClick={handleUseForAgents}
                    disabled={!selectedModel || provisioning}
                    data-testid="button-use-for-agents"
                  >
                    {provisioning ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <PlugZap className="h-4 w-4" />
                    )}
                    Use this model for all FoulFox agents
                  </Button>
                  <p className="text-xs text-muted-foreground">
                    This points all three agents at your local model. You can fine-tune
                    per-agent choices later in setup.
                  </p>
                </>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Saved, but no models were detected yet. Make sure your model server is
                  running with at least one model pulled, then reopen this dialog to assign
                  it.
                </p>
              )}
            </div>
          )}

          {/* Setup help */}
          <Collapsible open={showHelp} onOpenChange={setShowHelp}>
            <CollapsibleTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-between px-2 text-muted-foreground"
                data-testid="button-toggle-llama-help"
              >
                How do I set this up?
                <ChevronDown
                  className={`h-4 w-4 transition-transform ${showHelp ? "rotate-180" : ""}`}
                />
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="space-y-2 px-2 pb-1 pt-2 text-xs text-muted-foreground">
              <ol className="list-decimal space-y-1.5 pl-4">
                <li>
                  On your home computer, install{" "}
                  <span className="font-medium text-foreground">Ollama</span> (ollama.com)
                  and run a model, e.g. <code>ollama run llama3.2</code>.
                </li>
                <li>
                  Install <span className="font-medium text-foreground">cloudflared</span>{" "}
                  and expose Ollama:{" "}
                  <code>cloudflared tunnel --url http://localhost:11434</code>.
                </li>
                <li>
                  Copy the <code>https://….trycloudflare.com</code> URL it prints and paste
                  it above.
                </li>
                <li>
                  Click <span className="font-medium text-foreground">Test connection</span>,
                  then <span className="font-medium text-foreground">Connect</span>, then
                  assign the model to your agents.
                </li>
              </ol>
              <p>
                Full guide with LM Studio + a permanent tunnel:{" "}
                <code>docs/connect-local-llama.md</code> in your project.
              </p>
            </CollapsibleContent>
          </Collapsible>
        </div>
      </DialogContent>
    </Dialog>
  );
}

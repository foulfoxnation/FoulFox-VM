import { useRef, useCallback, useEffect, useState, forwardRef, useImperativeHandle, type ForwardedRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, ServerOff, Monitor, MonitorDot, Tv2, Server } from "lucide-react";
import { apiUrl } from "@/lib/api-url";
import { authedFetch } from "@/lib/shell-token";

/** Methods exposed to the parent shell via ref. */
export interface ChatPaneHandle {
  /** Force the Odysseus sidebar to become visible (restores it if hidden). */
  showSidebar(): void;
  /** Reload the Odysseus iframe to surface new messages (e.g. after a voice exchange). */
  refresh(): void;
}

/** Which machine the agent's shell + file tools should act on. */
export type ChatTarget =
  | { kind: "host"; label?: string }
  | { kind: "vm"; vmId: string; label?: string; osKind?: string; projectPath?: string | null };

export interface AgentChatPaneProps {
  /** Terminal output to send to the agent chat as a new message. */
  pendingContext?: string | null;
  /** Called once the pending context has been delivered. */
  onContextConsumed?: () => void;
  /** Shell session token forwarded as an auth header. */
  shellToken?: string | null;
  /**
   * Machine the agent should operate on. When the user is viewing a VM tab we
   * bind the agent's shell/file tools to that VM; on the Host Shell / Workspace
   * tabs we bind them back to the host. Defaults to the host.
   */
  target?: ChatTarget;
  /** Show the slim "acting on" badge above the chat (used in side-panel mode). */
  showTargetBadge?: boolean;
}

type WorkspaceMode = "windows" | "host";

const ODYSSEUS_SRC = apiUrl("/api/odysseus/");
const CHAT_MODE_KEY = "foulfox-chat-mode";

function loadSavedMode(): WorkspaceMode {
  try {
    const saved = localStorage.getItem(CHAT_MODE_KEY);
    if (saved === "host" || saved === "windows") return saved;
  } catch { /* ignore */ }
  return "windows"; // default: Windows VM
}

interface VmEntry {
  id: string;
  name: string;
  status: string;
  osKind?: string;
}

export const AgentChatPane = forwardRef(
function AgentChatPane({
  pendingContext,
  onContextConsumed,
  shellToken,
  target,
  showTargetBadge = false,
}: AgentChatPaneProps, ref: ForwardedRef<ChatPaneHandle>) {
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useImperativeHandle(ref, () => ({
    showSidebar() {
      try {
        const iframe = iframeRef.current;
        if (!iframe) return;
        const win = iframe.contentWindow as (Window & {
          _odyOpenSidebar?: (side?: string) => void;
        }) | null;
        if (!win) return;

        // Method 1: use the function Odysseus exposes on its window.
        if (typeof win._odyOpenSidebar === "function") {
          win._odyOpenSidebar();
          return;
        }

        // Method 2: directly click the hamburger toggle inside the iframe DOM.
        const doc = iframe.contentDocument;
        if (doc) {
          const sidebar = doc.getElementById("sidebar");
          if (sidebar?.classList.contains("hidden")) {
            const btn = doc.getElementById("hamburger-btn");
            btn?.click();
            return;
          }
          // Sidebar exists and is already visible — nothing to do.
          if (sidebar) return;
        }
      } catch {
        // cross-origin guard — safe to ignore
      }
    },
    refresh() {
      // Reload the Odysseus iframe so new messages (e.g. from a voice exchange)
      // appear without the user having to switch tabs manually.
      if (iframeRef.current) {
        iframeRef.current.src = ODYSSEUS_SRC;
      }
    },
  }));

  const loadedRef = useRef(false);

  // Label of the target the agent is *confirmed* bound to (updated only on a
  // successful vm-target POST). `bindError` is set when a bind attempt fails so
  // the badge can warn instead of falsely claiming the new target is active.
  const [boundLabel, setBoundLabel] = useState<string | null>(null);
  const [bindError, setBindError] = useState(false);

  // ── Workspace mode toggle ───────────────────────────────────────────────────
  // "windows" = agent works in the Windows VM by default (stored in localStorage).
  // "host"    = agent works on the FoulFox OS host.
  const [chatMode, setChatMode] = useState<WorkspaceMode>(loadSavedMode);

  const handleModeToggle = useCallback((mode: WorkspaceMode) => {
    setChatMode(mode);
    try { localStorage.setItem(CHAT_MODE_KEY, mode); } catch { /* ignore */ }
  }, []);

  // ── Offline pane: Retry Setup + on-screen diagnostics ──────────────────────
  const [retrying, setRetrying] = useState(false);
  const [retryNote, setRetryNote] = useState<string | null>(null);
  const [diagLoading, setDiagLoading] = useState(false);
  const [diagnostics, setDiagnostics] = useState<{ appliance: boolean; sections: Array<{ title: string; text: string }> } | null>(null);

  const handleShowDiagnostics = useCallback(async () => {
    setDiagLoading(true);
    try {
      const res = await authedFetch("/api/os/diagnostics");
      setDiagnostics(await res.json());
    } catch {
      setDiagnostics({ appliance: true, sections: [{ title: "Diagnostics", text: "Could not reach the API server for diagnostics." }] });
    } finally {
      setDiagLoading(false);
    }
  }, []);

  const handleOfflineRetry = useCallback(async () => {
    setRetrying(true);
    setRetryNote("Restarting local AI + agent, re-running setup…");
    try {
      const res = await authedFetch("/api/os/restart-services", { method: "POST" });
      const data = await res.json() as { ok: boolean };
      if (!data.ok) {
        setRetryNote("Restart only works on the FoulFox OS machine (dev workspace manages the agent itself).");
        return;
      }
      // Watch the agent until it answers (up to 90s); on failure, auto-load
      // the crash log so the reason is on screen without any terminal work.
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 3000));
        try {
          const s = await fetch(apiUrl("/api/odysseus/lifecycle/status"));
          const j = await s.json() as { alive?: boolean };
          if (j.alive) {
            setRetryNote("FoulFox OS is online.");
            return; // status query refetch flips the pane to the chat
          }
        } catch { /* api-server may be mid-restart; keep polling */ }
      }
      setRetryNote("The agent still isn't answering after the restart — details below show why it stopped.");
      await handleShowDiagnostics();
    } catch {
      setRetryNote("Could not reach the API server to restart services.");
    } finally {
      setRetrying(false);
    }
  }, [handleShowDiagnostics]);

  const { data: status, isLoading } = useQuery({
    queryKey: ["odysseus-lifecycle-status"],
    queryFn: async () => {
      const res = await fetch(apiUrl("/api/odysseus/lifecycle/status"));
      if (!res.ok) throw new Error("Status failed");
      return res.json() as Promise<{ state: string; alive: boolean }>;
    },
    refetchInterval: 5000,
  });

  const isAlive = status?.alive === true;

  // Fetch running VMs so we can find the Windows VM id for the toggle.
  const { data: vms } = useQuery<VmEntry[]>({
    queryKey: ["vms-for-workspace-toggle"],
    queryFn: async () => {
      const res = await authedFetch("/api/vms");
      if (!res.ok) return [];
      return res.json();
    },
    enabled: isAlive,
    refetchInterval: 30_000,
    staleTime: 20_000,
  });

  // Find the first running Windows VM (or any Windows VM if none are running).
  const windowsVm = vms?.find(v => v.osKind === "windows" && v.status === "running")
    ?? vms?.find(v => v.osKind === "windows");

  // Identity of the current target (used as the effect key so a re-render with
  // an equivalent target object does not re-POST).
  const targetKind = target?.kind ?? "host";
  const targetVmId = target?.kind === "vm" ? target.vmId : "";
  const targetLabel =
    target?.label ?? (target?.kind === "vm" ? target.vmId : "Host system");

  // Resolve which vm-target to bind based on chat mode:
  //   • "windows" + a Windows VM exists → use that VM
  //   • "windows" + no Windows VM       → fall back to whatever tab the user is on
  //   • "host"                          → use the current tab target
  const resolvedVm = chatMode === "windows" && windowsVm
    ? windowsVm.id
    : (targetKind === "vm" ? targetVmId : "host");
  const resolvedLabel = chatMode === "windows" && windowsVm
    ? (windowsVm.name ?? windowsVm.id)
    : targetLabel;

  // Bind the agent's shell + file tools to the resolved workspace and update
  // the Odysseus backend's workspace-mode context for the chat processor.
  useEffect(() => {
    if (!isAlive) return;
    let cancelled = false;

    Promise.all([
      authedFetch("/api/odysseus/api/vm-target", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vm: resolvedVm }),
      }),
      authedFetch("/api/odysseus/api/workspace-mode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: chatMode, vmLabel: resolvedLabel }),
      }),
    ])
      .then(([vmTargetRes]) => vmTargetRes.ok ? vmTargetRes.json() : null)
      .then((data) => {
        if (cancelled) return;
        if (data && data.ok) {
          setBoundLabel(resolvedLabel);
          setBindError(false);
        } else {
          setBindError(true);
        }
      })
      .catch(() => {
        if (cancelled) return;
        setBindError(true);
      });

    return () => { cancelled = true; };
  }, [chatMode, resolvedVm, resolvedLabel, isAlive, shellToken]);

  // Deliver pending terminal context to Odysseus's native /api/chat endpoint.
  // This creates a real chat session, then reloads the iframe so the new
  // conversation is shown. Works whether or not the iframe just loaded.
  const deliverContext = useCallback(async () => {
    if (!pendingContext) return;
    const message =
      "I have some terminal output from the host shell that I'd like you to analyse:\n\n" +
      "```\n" + pendingContext.slice(-4000) + "\n```\n\n" +
      "Please identify any errors, explain what happened, and suggest next steps.";
    try {
      await authedFetch("/api/odysseus/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });
      if (iframeRef.current) iframeRef.current.src = ODYSSEUS_SRC;
    } catch {
      // Non-fatal: the iframe still shows the chat; the user can type manually.
    } finally {
      onContextConsumed?.();
    }
  }, [pendingContext, shellToken, onContextConsumed]);

  // Fire delivery when context arrives after the iframe is already loaded
  // (switching to an already-mounted pane does not re-fire onLoad).
  useEffect(() => {
    if (isAlive && loadedRef.current && pendingContext) {
      void deliverContext();
    }
  }, [pendingContext, isAlive, deliverContext]);

  const handleIframeLoad = useCallback(() => {
    loadedRef.current = true;
    if (pendingContext) void deliverContext();
  }, [pendingContext, deliverContext]);

  if (isLoading) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-muted/20" data-testid="agent-chat-loading">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!isAlive) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center overflow-auto bg-muted/20 p-6 text-muted-foreground" data-testid="agent-chat-offline">
        <ServerOff className="mb-4 h-12 w-12" />
        <h2 className="text-xl font-semibold text-foreground">FoulFox OS Offline</h2>
        <p className="mt-2 max-w-md text-center">
          The FoulFox OS agent is not answering. Use Retry Setup to restart the
          local AI and the agent, or Show details to see why it stopped.
        </p>
        <div className="mt-4 flex gap-2">
          <button
            className="rounded-md border bg-background px-4 py-2 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-50"
            disabled={retrying}
            onClick={() => void handleOfflineRetry()}
            data-testid="button-offline-retry-setup"
          >
            {retrying ? "Restarting…" : "Retry Setup"}
          </button>
          <button
            className="rounded-md border bg-background px-4 py-2 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-50"
            disabled={diagLoading}
            onClick={() => void handleShowDiagnostics()}
            data-testid="button-offline-diagnostics"
          >
            {diagLoading ? "Loading…" : diagnostics ? "Refresh details" : "Show details"}
          </button>
        </div>
        {retryNote && <p className="mt-3 text-sm">{retryNote}</p>}
        {diagnostics && (
          <div className="mt-4 w-full max-w-3xl space-y-3 text-left" data-testid="offline-diagnostics">
            {diagnostics.appliance === false && (
              <p className="text-sm">Full system diagnostics are only available on the FoulFox OS machine (in the dev workspace the agent is managed by the workflow).</p>
            )}
            {diagnostics.sections.map((s) => (
              <div key={s.title}>
                <h3 className="mb-1 text-sm font-semibold text-foreground">{s.title}</h3>
                <pre className="max-h-64 overflow-auto rounded-md border bg-background p-3 text-xs leading-relaxed">
                  {s.text || "(no output)"}
                </pre>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-col" data-testid="agent-chat-container">

      {/* ── Workspace toggle ─────────────────────────────────────────────────── */}
      <div
        className="flex items-center gap-2 border-b bg-muted/30 px-3 py-1.5"
        data-testid="workspace-toggle-bar"
      >
        {/* Pill toggle */}
        <div className="flex items-center rounded-full border bg-background p-0.5 shadow-sm">
          <button
            onClick={() => handleModeToggle("host")}
            data-testid="workspace-toggle-host"
            title="Agent works on FoulFox OS (the host)"
            className={[
              "flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-all",
              chatMode === "host"
                ? "bg-primary text-primary-foreground shadow"
                : "text-muted-foreground hover:text-foreground",
            ].join(" ")}
          >
            <Server className="h-3 w-3" />
            FoulFox OS
          </button>
          <button
            onClick={() => handleModeToggle("windows")}
            data-testid="workspace-toggle-windows"
            title="Agent works inside the Windows VM by default"
            className={[
              "flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-all",
              chatMode === "windows"
                ? "bg-primary text-primary-foreground shadow"
                : "text-muted-foreground hover:text-foreground",
            ].join(" ")}
          >
            <Tv2 className="h-3 w-3" />
            Windows VM
          </button>
        </div>

        {/* Bound-to indicator */}
        <span className="text-[10px] text-muted-foreground">
          {chatMode === "windows" && windowsVm
            ? <>Agent → <span className="font-medium text-foreground">{windowsVm.name ?? windowsVm.id}</span></>
            : chatMode === "windows" && !windowsVm
            ? <span className="text-amber-500">No Windows VM running</span>
            : <>Agent → <span className="font-medium text-foreground">FoulFox OS</span></>
          }
          {bindError && (
            <span className="ml-1.5 text-destructive" data-testid="agent-chat-bind-error">
              · bind failed
            </span>
          )}
        </span>
      </div>

      {/* ── Optional "acting on" badge (side-panel mode) ────────────────────── */}
      {showTargetBadge && (
        <div
          className="flex items-center gap-1.5 border-b bg-muted/40 px-3 py-1 text-[11px] text-muted-foreground"
          data-testid="agent-chat-target"
        >
          {chatMode === "windows" && windowsVm ? (
            <MonitorDot className="h-3.5 w-3.5 text-primary" />
          ) : (
            <Monitor className="h-3.5 w-3.5" />
          )}
          <span className="text-muted-foreground">Agent acting on:</span>
          <span className="font-medium text-foreground">{boundLabel ?? "binding…"}</span>
          {bindError && (
            <span className="text-destructive" data-testid="agent-chat-bind-error-badge">
              · couldn't switch to {resolvedLabel}
            </span>
          )}
        </div>
      )}

      <iframe
        ref={iframeRef}
        src={ODYSSEUS_SRC}
        className="min-h-0 w-full flex-1 border-0"
        title="FoulFox OS Workspace"
        data-testid="agent-chat-iframe"
        onLoad={handleIframeLoad}
      />
    </div>
  );
});
AgentChatPane.displayName = "AgentChatPane";

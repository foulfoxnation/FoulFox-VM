import { useRef, useCallback, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, ServerOff, Monitor, MonitorDot } from "lucide-react";
import { apiUrl } from "@/lib/api-url";

/** Which machine the agent's shell + file tools should act on. */
export type ChatTarget =
  | { kind: "host"; label?: string }
  | { kind: "vm"; vmId: string; label?: string };

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

const ODYSSEUS_SRC = apiUrl("/api/odysseus/");

export function AgentChatPane({
  pendingContext,
  onContextConsumed,
  shellToken,
  target,
  showTargetBadge = false,
}: AgentChatPaneProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const loadedRef = useRef(false);
  const [boundLabel, setBoundLabel] = useState<string | null>(null);

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

  // Identity of the current target, used as the effect key so a re-render with
  // an equivalent target object does not re-POST.
  const targetKind = target?.kind ?? "host";
  const targetVmId = target?.kind === "vm" ? target.vmId : "";
  const targetLabel =
    target?.label ?? (target?.kind === "vm" ? target.vmId : "Host system");

  // Bind the agent's shell + file tools to whatever workspace the user views.
  // The selection is process-global in Odysseus, so a single POST per change
  // keeps the one shared conversation pointed at the right machine.
  useEffect(() => {
    if (!isAlive) return;
    const vm = targetKind === "vm" ? targetVmId : "host";
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (shellToken) headers["X-Shell-Token"] = shellToken;
    let cancelled = false;
    fetch(apiUrl("/api/odysseus/api/vm-target"), {
      method: "POST",
      headers,
      body: JSON.stringify({ vm }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled) return;
        setBoundLabel(data && data.ok ? targetLabel : targetLabel);
      })
      .catch(() => {
        // Non-fatal: the agent still works on the host default; surface nothing.
      });
    return () => {
      cancelled = true;
    };
  }, [targetKind, targetVmId, targetLabel, isAlive, shellToken]);

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
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (shellToken) headers["X-Shell-Token"] = shellToken;
      await fetch(apiUrl("/api/odysseus/api/chat"), {
        method: "POST",
        headers,
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
      <div className="flex h-full w-full flex-col items-center justify-center bg-muted/20 text-muted-foreground" data-testid="agent-chat-offline">
        <ServerOff className="mb-4 h-12 w-12" />
        <h2 className="text-xl font-semibold text-foreground">FoulFox VM Offline</h2>
        <p className="mt-2 max-w-md text-center">
          The FoulFox VM agent is currently disconnected or the server is unreachable.
          Wait for it to come online or check the VM status.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-col" data-testid="agent-chat-container">
      {showTargetBadge && (
        <div
          className="flex items-center gap-1.5 border-b bg-muted/40 px-3 py-1 text-[11px] text-muted-foreground"
          data-testid="agent-chat-target"
        >
          {targetKind === "vm" ? (
            <MonitorDot className="h-3.5 w-3.5 text-primary" />
          ) : (
            <Monitor className="h-3.5 w-3.5" />
          )}
          <span className="text-muted-foreground">Agent acting on:</span>
          <span className="font-medium text-foreground">{boundLabel ?? targetLabel}</span>
        </div>
      )}
      <iframe
        ref={iframeRef}
        src={ODYSSEUS_SRC}
        className="min-h-0 w-full flex-1 border-0"
        title="FoulFox VM Workspace"
        data-testid="agent-chat-iframe"
        onLoad={handleIframeLoad}
      />
    </div>
  );
}

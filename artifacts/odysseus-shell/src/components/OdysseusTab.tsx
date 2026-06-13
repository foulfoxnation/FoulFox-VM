import { useRef, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, ServerOff } from "lucide-react";
import { apiUrl } from "@/lib/api-url";

export interface OdysseusTabProps {
  /** Terminal output to send to the Odysseus chat as a new message. */
  pendingContext?: string | null;
  /** Called once the pending context has been delivered. */
  onContextConsumed?: () => void;
  /** Shell session token required for auth headers. */
  shellToken?: string | null;
}

export function OdysseusTab({ pendingContext, onContextConsumed, shellToken }: OdysseusTabProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);

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

  // When the iframe finishes loading and we have pending terminal context,
  // POST it to Odysseus's native /api/chat endpoint. This creates a real
  // Odysseus chat session visible in the UI, then reloads the iframe so
  // the new conversation is shown to the user.
  const handleIframeLoad = useCallback(async () => {
    if (!pendingContext) return;

    const message =
      "I have some terminal output from the Windows VM shell that I'd like you to analyse:\n\n" +
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

      // Reload the iframe so the Odysseus UI renders the new chat session.
      if (iframeRef.current) {
        iframeRef.current.src = apiUrl("/api/odysseus/");
      }
    } catch {
      // Non-fatal: iframe is already showing the Odysseus UI; user can type manually.
    } finally {
      onContextConsumed?.();
    }
  }, [pendingContext, shellToken, onContextConsumed]);

  if (isLoading) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-muted/20" data-testid="odysseus-loading">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!isAlive) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center bg-muted/20 text-muted-foreground" data-testid="odysseus-offline">
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
    <div className="h-full w-full" data-testid="odysseus-iframe-container">
      <iframe
        ref={iframeRef}
        src={apiUrl("/api/odysseus/")}
        className="h-full w-full border-0"
        title="FoulFox VM Workspace"
        data-testid="odysseus-iframe"
        onLoad={handleIframeLoad}
      />
    </div>
  );
}

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, ServerOff } from "lucide-react";

export function OdysseusTab() {
  const { data: status, isLoading } = useQuery({
    queryKey: ["/api/odysseus-status"],
    queryFn: async () => {
      const res = await fetch("/api/odysseus-status");
      if (!res.ok) throw new Error("Status failed");
      return res.json() as Promise<{ alive: boolean }>;
    },
    refetchInterval: 5000,
  });

  if (isLoading) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-muted/20" data-testid="odysseus-loading">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!status?.alive) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center bg-muted/20 text-muted-foreground" data-testid="odysseus-offline">
        <ServerOff className="mb-4 h-12 w-12" />
        <h2 className="text-xl font-semibold text-foreground">Odysseus Offline</h2>
        <p className="mt-2 max-w-md text-center">
          The Odysseus agent is currently disconnected or the server is unreachable.
          Wait for it to come online or check the VM status.
        </p>
      </div>
    );
  }

  return (
    <div className="h-full w-full" data-testid="odysseus-iframe-container">
      <iframe
        src="/api/odysseus/"
        className="h-full w-full border-0"
        title="Odysseus Workspace"
        data-testid="odysseus-iframe"
      />
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { RefreshCw } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  checkOdysseusUpdate,
  applyOdysseusUpdate,
  fetchOdysseusUpdateStatus,
} from "@/lib/vm-api";

// One button: check upstream → toast if up to date; otherwise pull the latest
// Odysseus from Git (also serves as install/repair when it's missing or broken).
export function OdysseusUpdateButton() {
  const [busy, setBusy] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const { toast } = useToast();

  // Clear any in-flight poller if the component unmounts.
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  const stopPolling = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    setBusy(false);
  };

  const pollUntilDone = () => {
    pollRef.current = setInterval(async () => {
      try {
        const s = await fetchOdysseusUpdateStatus();
        if (s.state === "done") {
          stopPolling();
          toast({ title: "Odysseus updated", description: s.message });
        } else if (s.state === "error") {
          stopPolling();
          toast({
            title: "Odysseus update failed",
            description: s.message,
            variant: "destructive",
          });
        }
      } catch {
        // transient poll error (e.g. service restarting) — keep polling
      }
    }, 2500);
  };

  const onClick = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const check = await checkOdysseusUpdate();
      if (check.updating) {
        toast({ title: "Odysseus update already running" });
        pollUntilDone();
        return;
      }
      if (check.action === "none") {
        toast({
          title: "Odysseus is up to date",
          description: check.remoteCommit
            ? `Version ${check.remoteCommit.slice(0, 7)}`
            : undefined,
        });
        setBusy(false);
        return;
      }
      const label =
        check.action === "repair"
          ? "Repairing Odysseus…"
          : check.action === "install"
            ? "Installing Odysseus…"
            : "Updating Odysseus…";
      const started = await applyOdysseusUpdate();
      if (!started.started) {
        throw new Error(started.error || "Could not start the update.");
      }
      toast({ title: label, description: "This can take a few minutes." });
      pollUntilDone();
    } catch (err) {
      stopPolling();
      toast({
        title: "Odysseus update check failed",
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    }
  };

  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-8 gap-1.5 text-muted-foreground hover:text-foreground"
      onClick={onClick}
      disabled={busy}
      title="Check for Odysseus updates (also repairs a broken install)"
      data-testid="button-odysseus-updates"
    >
      <RefreshCw className={`h-4 w-4 ${busy ? "animate-spin" : ""}`} />
      <span className="hidden sm:inline text-xs">Odysseus Updates</span>
    </Button>
  );
}

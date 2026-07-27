import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { RefreshCw } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  fetchAppUpdateInfo,
  applyAppUpdate,
  fetchUpdateStatus,
  checkOdysseusUpdate,
  applyOdysseusUpdate,
  fetchOdysseusUpdateStatus,
} from "@/lib/vm-api";

// One button, two paths:
//
// 1. FoulFox OS appliance (patcher supported): pull the full app-stack bundle
//    (api-server + shell + Odysseus service) and swap it in atomically with
//    automatic rollback. This is the REAL update path — it covers everything
//    and falls back to the published-site mirror when GitHub is unreachable.
// 2. Anywhere else (dev preview, no patcher): the legacy git-sync path for the
//    Odysseus service only.
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

  // ── Path 1: app-bundle patcher (appliance) ────────────────────────────────
  const pollPatcher = () => {
    pollRef.current = setInterval(async () => {
      try {
        const s = await fetchUpdateStatus();
        if (s.state === "success") {
          stopPolling();
          toast({ title: "FoulFox updated", description: s.message });
        } else if (s.state === "failed") {
          stopPolling();
          toast({
            title: "Update failed",
            description: s.error || s.message,
            variant: "destructive",
          });
        }
        // "running" (or a stale "idle" while the unit spins up) → keep polling.
      } catch {
        // The apply restarts the api-server mid-update — transient errors are
        // expected; the status file survives, so just keep polling.
      }
    }, 3000);
  };

  const runPatcherFlow = async (): Promise<void> => {
    const info = await fetchAppUpdateInfo();
    if (info.status === "current") {
      toast({
        title: "FoulFox is up to date",
        description: info.currentVersion ? `Version ${info.currentVersion}` : undefined,
      });
      setBusy(false);
      return;
    }
    if (info.status === "building" || info.status === "unconfigured") {
      toast({
        title: "No update available yet",
        description:
          info.status === "building"
            ? "The update servers are unreachable or a new bundle is still building. Try again in a few minutes."
            : "No update source is configured on this device.",
        variant: "destructive",
      });
      setBusy(false);
      return;
    }
    // status === "ready" — but if the patcher is already mid-update (e.g. the
    // user double-clicked across an api-server restart), just resume polling.
    try {
      const s = await fetchUpdateStatus();
      if (s.state === "running") {
        toast({ title: "Update already running", description: s.message });
        pollPatcher();
        return;
      }
    } catch {
      // status probe is best-effort
    }
    const started = await applyAppUpdate();
    if (!started.started) {
      throw new Error(started.error || "Could not start the update.");
    }
    toast({
      title: info.latestVersion
        ? `Updating FoulFox to ${info.latestVersion}…`
        : "Updating FoulFox…",
      description: "Downloading and applying — this can take several minutes.",
    });
    pollPatcher();
  };

  // ── Path 2: legacy git sync (dev / no patcher) ────────────────────────────
  const pollLegacy = () => {
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

  const runLegacyFlow = async (): Promise<void> => {
    const check = await checkOdysseusUpdate();
    if (check.updating) {
      toast({ title: "Odysseus update already running" });
      pollLegacy();
      return;
    }
    if (check.action === "none") {
      toast({
        title: "Odysseus is up to date",
        description: check.remoteCommit ? `Version ${check.remoteCommit.slice(0, 7)}` : undefined,
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
    pollLegacy();
  };

  const onClick = async () => {
    if (busy) return;
    setBusy(true);
    try {
      // Prefer the patcher (full app-stack update). Only fall back to the
      // legacy git-sync when the server EXPLICITLY reports the patcher is not
      // installed (dev preview). A transient probe failure must NOT silently
      // route an appliance user into the legacy path — surface it and retry.
      let info;
      try {
        info = await fetchAppUpdateInfo();
      } catch (probeErr) {
        throw new Error(
          `Could not check for updates (${probeErr instanceof Error ? probeErr.message : String(probeErr)}). Try again in a moment.`,
        );
      }
      if (info.supported) {
        await runPatcherFlow();
      } else {
        await runLegacyFlow();
      }
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
      title="Check for FoulFox updates (downloads and applies the latest app bundle)"
      data-testid="button-odysseus-updates"
    >
      <RefreshCw className={`h-4 w-4 ${busy ? "animate-spin" : ""}`} />
      <span className="hidden sm:inline text-xs">Odysseus Updates</span>
    </Button>
  );
}

import { useEffect, useRef, useState } from "react";
import RFB from "@novnc/novnc/core/rfb.js";
import { displayWsUrl, type VmSummary } from "@/lib/vm-api";
import { Loader2, MonitorX } from "lucide-react";

// Graphical (VNC) display for a single VM. Connects via noVNC's RFB to our
// authenticated websockify-style proxy only while the VM is running.
export function VmDisplay({ vm }: { vm: VmSummary }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"connecting" | "connected" | "disconnected">("connecting");
  const [error, setError] = useState<string | null>(null);

  const running = vm.state === "running";

  useEffect(() => {
    if (!running || !containerRef.current) return;
    setStatus("connecting");
    setError(null);

    let rfb: RFB | null = null;
    try {
      rfb = new RFB(containerRef.current, displayWsUrl(vm), {});
      rfb.scaleViewport = true;
      rfb.resizeSession = false;
      rfb.background = "#09090b";
      rfb.addEventListener("connect", () => setStatus("connected"));
      rfb.addEventListener("disconnect", (e: Event) => {
        setStatus("disconnected");
        const detail = (e as CustomEvent).detail as { clean?: boolean } | undefined;
        if (detail && detail.clean === false) setError("Display connection lost.");
      });
      rfb.addEventListener("securityfailure", (e: Event) => {
        const detail = (e as CustomEvent).detail as { reason?: string } | undefined;
        setError(detail?.reason || "VNC security failure");
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus("disconnected");
    }

    return () => {
      try {
        rfb?.disconnect();
      } catch {
        /* ignore */
      }
    };
    // displayToken is stable per VM; reconnect only when the VM or its run-state changes.
  }, [running, vm.id, vm.displayToken]);

  if (!running) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-zinc-950 text-muted-foreground">
        <MonitorX className="h-10 w-10 opacity-40" />
        <p className="text-sm">Display is available when the VM is running.</p>
        <p className="text-xs opacity-60">Start the VM to view its screen.</p>
      </div>
    );
  }

  return (
    <div className="relative h-full w-full bg-zinc-950">
      <div ref={containerRef} className="h-full w-full" data-testid={`vm-display-${vm.id}`} />
      {status !== "connected" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-zinc-950/80 text-muted-foreground">
          {error ? (
            <>
              <MonitorX className="h-8 w-8 text-red-400" />
              <p className="text-sm text-red-300">{error}</p>
            </>
          ) : (
            <>
              <Loader2 className="h-8 w-8 animate-spin" />
              <p className="text-sm">Connecting to display…</p>
            </>
          )}
        </div>
      )}
    </div>
  );
}

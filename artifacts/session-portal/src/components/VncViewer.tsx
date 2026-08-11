import { useEffect, useRef, useState } from "react";
import RFB from "@novnc/novnc/core/rfb.js";
import { Loader2, MonitorOff } from "lucide-react";

interface VncViewerProps {
  /** Full WebSocket URL to connect to (already resolved via apiWsUrl). */
  wsUrl: string | null;
  /** Shown in the placeholder when wsUrl is null. */
  label?: string;
}

export function VncViewer({ wsUrl, label }: VncViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!wsUrl || !containerRef.current) {
      setError(null);
      return;
    }

    setConnecting(true);
    setError(null);
    let rfb: any;

    try {
      rfb = new RFB(containerRef.current, wsUrl);
      rfb.scaleViewport = true;
      rfb.resizeSession = false;
      rfb.addEventListener("connect", () => {
        setConnecting(false);
        setError(null);
      });
      rfb.addEventListener("disconnect", (e: any) => {
        setConnecting(false);
        if (e?.detail?.clean === false) {
          setError("Connection lost");
        }
      });
    } catch (e: any) {
      setConnecting(false);
      setError(e?.message ?? "VNC failed");
    }

    return () => {
      if (rfb) {
        try { rfb.disconnect(); } catch { /* ignore */ }
      }
    };
  }, [wsUrl]);

  return (
    <div className="relative flex-1 w-full h-full bg-black">
      {/* Placeholder — shown when no connection target */}
      {!wsUrl && (
        <div className="absolute inset-0 flex items-center justify-center flex-col gap-3 text-zinc-600 z-20">
          <MonitorOff className="w-10 h-10 opacity-40" />
          <span className="text-sm font-mono">
            {label ?? "No display selected"}
          </span>
        </div>
      )}

      {/* Connecting spinner */}
      {wsUrl && connecting && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/60 backdrop-blur-sm z-10 text-zinc-400">
          <Loader2 className="w-8 h-8 animate-spin" />
        </div>
      )}

      {/* Error state */}
      {wsUrl && error && !connecting && (
        <div className="absolute inset-0 flex items-center justify-center flex-col gap-2 text-zinc-500 z-20">
          <MonitorOff className="w-8 h-8 opacity-50" />
          <span className="text-xs font-mono">{error}</span>
          <span className="text-xs opacity-50">
            {label?.includes("Host") ? "Start x11vnc on the machine to view the desktop" : "VM may be stopped or display token expired"}
          </span>
        </div>
      )}

      <div
        ref={containerRef}
        className="w-full h-full overflow-hidden"
      />
    </div>
  );
}

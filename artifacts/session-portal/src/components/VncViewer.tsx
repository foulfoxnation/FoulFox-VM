import { useEffect, useRef, useState } from "react";
import RFB from "@novnc/novnc/core/rfb.js";
import { apiWsUrl } from "@/lib/api-url";
import { Loader2 } from "lucide-react";

interface VncViewerProps {
  vmId: string | null;
  displayToken: string | null;
}

export function VncViewer({ vmId, displayToken }: VncViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [connecting, setConnecting] = useState(false);

  useEffect(() => {
    if (!vmId || !displayToken || !containerRef.current) return;
    
    setConnecting(true);
    const url = apiWsUrl(`/api/vm/ws/display?vm=${vmId}&token=${displayToken}`);
    let rfb: any;
    
    try {
      rfb = new RFB(containerRef.current, url);
      rfb.scaleViewport = true;
      rfb.resizeSession = false;
      rfb.addEventListener('connect', () => setConnecting(false));
      rfb.addEventListener('disconnect', () => setConnecting(false));
    } catch (e) {
      console.error("VNC error:", e);
      setConnecting(false);
    }
    
    return () => {
      if (rfb) {
        try { rfb.disconnect(); } catch (e) {}
      }
    };
  }, [vmId, displayToken]);

  return (
    <div className="relative flex-1 w-full h-full bg-black/90">
      {(!vmId || !displayToken) && (
        <div className="absolute inset-0 flex items-center justify-center bg-black text-zinc-500 flex-col gap-2 z-20">
          <div className="text-xl font-medium tracking-tight">
            {!vmId ? "No VM Selected" : "Waiting for display..."}
          </div>
          <div className="text-sm font-mono opacity-60">
            {!vmId ? "Select a machine from the bar above" : "VM state is not fully running yet"}
          </div>
        </div>
      )}
      
      {vmId && displayToken && connecting && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/50 backdrop-blur-sm z-10 text-zinc-400">
          <Loader2 className="w-8 h-8 animate-spin" />
        </div>
      )}
      <div ref={containerRef} className="w-full h-full overflow-hidden flex items-center justify-center" />
    </div>
  );
}

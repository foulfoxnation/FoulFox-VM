import { useEffect, useRef, useState, useCallback } from "react";
import RFB from "@novnc/novnc/core/rfb.js";
import { displayWsUrl, type VmSummary } from "@/lib/vm-api";
import { Loader2, MonitorX, LogOut } from "lucide-react";

// Graphical (VNC) display for a single VM. Connects via noVNC's RFB to our
// authenticated websockify-style proxy only while the VM is running.
//
// The escape ribbon (top bar) floats ABOVE the noVNC canvas as a sibling div
// inside a common relative container. This means click events on the ribbon
// are handled by React and never forwarded into the VM guest.
export function VmDisplay({
  vm,
  onEscape,
}: {
  vm: VmSummary;
  /** Called when the user wants to leave the VM view (click or Ctrl+M). */
  onEscape?: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"connecting" | "connected" | "disconnected">("connecting");
  const [error, setError] = useState<string | null>(null);

  // Escape ribbon visibility: auto-show for 3 s after initial connect,
  // then show again whenever the mouse reaches the top 48 px of the display.
  const [ribbonVisible, setRibbonVisible] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showRibbon = useCallback((duration = 3000) => {
    setRibbonVisible(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    if (duration > 0) {
      hideTimer.current = setTimeout(() => setRibbonVisible(false), duration);
    }
  }, []);

  const hideRibbonNow = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    setRibbonVisible(false);
  }, []);

  const running = vm.state === "running";

  // Block double-click on the VNC canvas from triggering browser requestFullscreen.
  // noVNC itself doesn't call requestFullscreen, but Chromium kiosk + pointer-lock
  // interactions can accidentally enter true fullscreen and trap the user with no
  // visible way out.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const blockFs = (e: Event) => e.preventDefault();
    el.addEventListener("dblclick", blockFs);
    return () => el.removeEventListener("dblclick", blockFs);
  }, []);

  // Global capture-phase F11 handler — exits browser fullscreen even when noVNC
  // has keyboard focus and the parent component's React-fullscreen state is false.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "F11" && document.fullscreenElement) {
        e.preventDefault();
        e.stopPropagation();
        document.exitFullscreen().catch(() => {});
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, []);

  // Ctrl+M — escape back to FoulFox OS (capture phase beats noVNC).
  useEffect(() => {
    if (!onEscape) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "m" && e.ctrlKey && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        onEscape();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onEscape]);

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
      rfb.addEventListener("connect", () => {
        setStatus("connected");
        // Show the escape ribbon briefly so the user knows they're "inside" the VM.
        showRibbon(4000);
      });
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
      try { rfb?.disconnect(); } catch { /* ignore */ }
    };
    // displayToken is stable per VM; reconnect only when the VM or its run-state changes.
  }, [running, vm.id, vm.displayToken, showRibbon]);

  // Mouse proximity — show ribbon when the pointer is near the top of the display.
  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const yFromTop = e.clientY - rect.top;
      if (yFromTop < 48) {
        showRibbon(0); // stay visible while near top
      } else if (ribbonVisible) {
        // Start hide timer when pointer moves away from the trigger zone.
        if (hideTimer.current) clearTimeout(hideTimer.current);
        hideTimer.current = setTimeout(() => setRibbonVisible(false), 1200);
      }
    },
    [ribbonVisible, showRibbon],
  );

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
    <div
      className="relative h-full w-full bg-zinc-950"
      onMouseMove={handleMouseMove}
    >
      {/* noVNC canvas container — all pointer events here go into the VM */}
      <div ref={containerRef} className="h-full w-full" data-testid={`vm-display-${vm.id}`} />

      {/* ── Escape ribbon ────────────────────────────────────────────────────
          This is a sibling to the noVNC canvas, not a child. It sits above
          the canvas via z-index. Pointer events on this element are handled by
          React — they never reach the noVNC event listeners.
          ──────────────────────────────────────────────────────────────────── */}
      <div
        className={[
          "absolute left-0 right-0 top-0 z-50",
          "flex items-center justify-between gap-2 px-3 py-1.5",
          "bg-zinc-900/90 backdrop-blur-sm border-b border-white/10",
          "transition-all duration-300",
          ribbonVisible
            ? "opacity-100 pointer-events-auto translate-y-0"
            : "opacity-0 pointer-events-none -translate-y-full",
        ].join(" ")}
        // Keep the ribbon visible while hovering over it.
        onMouseEnter={() => showRibbon(0)}
        onMouseLeave={() => {
          if (hideTimer.current) clearTimeout(hideTimer.current);
          hideTimer.current = setTimeout(() => setRibbonVisible(false), 800);
        }}
      >
        <div className="flex items-center gap-2 text-xs text-zinc-300">
          <span className="font-semibold text-white">FoulFox OS</span>
          <span className="text-zinc-500">·</span>
          <span className="text-zinc-400">Move mouse here or press</span>
          <kbd className="rounded bg-zinc-700 px-1.5 py-0.5 font-mono text-[10px] text-zinc-200">
            Ctrl+M
          </kbd>
          <span className="text-zinc-400">to return to the OS</span>
        </div>

        {onEscape && (
          <button
            type="button"
            onClick={(e) => {
              // Stop the event from going into the VM canvas behind the ribbon.
              e.stopPropagation();
              onEscape();
            }}
            className="flex items-center gap-1.5 rounded bg-zinc-700 px-2.5 py-1 text-xs font-medium text-white hover:bg-zinc-600 active:bg-zinc-500 transition-colors"
            data-testid="button-vm-escape"
          >
            <LogOut className="h-3.5 w-3.5" />
            Return to FoulFox OS
          </button>
        )}
      </div>

      {/* Permanent hint tab — always visible at top-right even when ribbon is hidden */}
      {onEscape && status === "connected" && !ribbonVisible && (
        <div
          className="absolute right-2 top-0 z-40 flex cursor-pointer items-center gap-1 rounded-b bg-zinc-800/70 px-2 py-0.5 text-[10px] text-zinc-400 hover:text-white hover:bg-zinc-700/90 transition-colors select-none"
          onClick={(e) => { e.stopPropagation(); showRibbon(0); }}
          title="Click or move mouse to top of display to reveal escape controls"
          data-testid="button-vm-escape-hint"
        >
          ↑ Ctrl+M
        </div>
      )}

      {/* Connecting / error overlay */}
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

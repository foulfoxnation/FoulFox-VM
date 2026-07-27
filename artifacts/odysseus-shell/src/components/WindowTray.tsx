import { useEffect, useRef, useState } from "react";
import { apiUrl } from "@/lib/api-url";
import { authedFetch } from "@/lib/shell-token";
import { Button } from "@/components/ui/button";
import { AppWindow, Globe, MessageSquare, Monitor } from "lucide-react";

// ── Open-window tray ──────────────────────────────────────────────────────────
// The kiosk shell is fullscreen, so a minimized Firefox/Discord window has no
// on-screen affordance to bring it back. This tray polls GET /api/windows (the
// api-server lists open X windows via wmctrl) and re-activates one on click.
// In dev (no wmctrl / no X display) the endpoint reports available:false and
// the tray renders nothing.

interface TrayWindow {
  id: string;
  cls: string;
  title: string;
}

const POLL_MS = 4000;

function windowMeta(w: TrayWindow): { label: string; Icon: typeof AppWindow } {
  const cls = w.cls.toLowerCase();
  if (cls.includes("discord")) return { label: "Discord", Icon: MessageSquare };
  if (cls.includes("firefox")) return { label: "Firefox", Icon: Globe };
  if (cls.includes("chromium")) return { label: "Chromium", Icon: Globe };
  if (cls.includes("virt-viewer") || cls.includes("remote-viewer") || cls.includes("vinagre")) {
    return { label: "VM Display", Icon: Monitor };
  }
  // Fall back to the window title (first ~18 chars) or the class name.
  const t = w.title.trim();
  if (t) return { label: t.length > 18 ? `${t.slice(0, 17)}…` : t, Icon: AppWindow };
  const base = w.cls.split(".").pop() || "App";
  return { label: base, Icon: AppWindow };
}

export function WindowTray() {
  const [windows, setWindows] = useState<TrayWindow[]>([]);
  const [available, setAvailable] = useState(false);
  const busyRef = useRef(false);

  useEffect(() => {
    let stopped = false;

    async function poll() {
      try {
        const res = await fetch(apiUrl("/api/windows"));
        if (!res.ok) return;
        const data = (await res.json()) as { available: boolean; windows: TrayWindow[] };
        if (stopped) return;
        setAvailable(data.available);
        setWindows(data.available ? data.windows : []);
      } catch {
        // API briefly down (restart) — keep the last state, try again next tick.
      }
    }

    void poll();
    const t = setInterval(poll, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, []);

  if (!available || windows.length === 0) return null;

  async function activate(id: string) {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      await authedFetch(apiUrl("/api/windows/activate"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
    } catch {
      // Window may already be gone; the next poll prunes it.
    } finally {
      busyRef.current = false;
    }
  }

  return (
    <div
      className="ml-auto flex items-center gap-1 self-center pl-2"
      data-testid="window-tray"
      title="Open windows on this machine — click to bring one to the front"
    >
      {windows.map((w) => {
        const { label, Icon } = windowMeta(w);
        return (
          <Button
            key={w.id}
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 px-2 text-xs"
            onClick={() => void activate(w.id)}
            title={w.title || label}
            data-testid={`tray-window-${w.id}`}
          >
            <Icon className="h-3.5 w-3.5" />
            <span className="max-w-[110px] truncate">{label}</span>
          </Button>
        );
      })}
    </div>
  );
}

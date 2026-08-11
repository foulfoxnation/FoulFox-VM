import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { apiWsUrl } from "@/lib/api-url";
import "@xterm/xterm/css/xterm.css";

export function TerminalPane({ shellToken }: { shellToken: string | null }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);

  useEffect(() => {
    if (!shellToken || !containerRef.current) return;

    const term = new XTerm({
      cursorBlink: true,
      fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
      fontSize: 13,
      theme: { background: "#09090b", foreground: "#fafafa" }
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);
    
    // Slight delay to ensure parent containers have painted correctly before fitting
    setTimeout(() => fitAddon.fit(), 10);

    termRef.current = term;

    const ws = new WebSocket(apiWsUrl(`/api/shell/ws?token=${shellToken}`));
    
    ws.onopen = () => {
      fitAddon.fit();
      ws.send(JSON.stringify({
        type: "resize",
        cols: term.cols,
        rows: term.rows
      }));
    };

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === "data") term.write(msg.data);
      } catch (err) {}
    };

    const dataDisposable = term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "data", data }));
      }
    });

    const handleResize = () => {
      fitAddon.fit();
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: "resize",
          cols: term.cols,
          rows: term.rows
        }));
      }
    };

    // Use ResizeObserver for more robust resizing
    const resizeObserver = new ResizeObserver(() => handleResize());
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      dataDisposable.dispose();
      term.dispose();
      ws.close();
    };
  }, [shellToken]);

  if (!shellToken) {
    return (
      <div className="flex h-full items-center justify-center bg-zinc-950 text-zinc-500 text-sm font-mono">
        Waiting for shell token...
      </div>
    );
  }

  return (
    <div className="w-full h-full bg-zinc-950 p-2">
      <div ref={containerRef} className="w-full h-full" />
    </div>
  );
}

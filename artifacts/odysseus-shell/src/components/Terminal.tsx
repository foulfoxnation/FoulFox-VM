import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

export function Terminal() {
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new XTerm({
      cursorBlink: true,
      fontFamily: 'var(--font-mono)',
      theme: {
        background: '#09090b', // hsl(240 10% 3.9%) - var(--background)
        foreground: '#fafafa', // hsl(0 0% 98%) - var(--foreground)
      }
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);
    fitAddon.fit();

    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${wsProtocol}//${window.location.host}/api/shell/ws`);
    wsRef.current = ws;

    ws.onopen = () => {
      fitAddon.fit();
      ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "data" && msg.data) {
          term.write(msg.data);
        } else if (msg.type === "exit") {
          term.write(`\r\n[Process exited with code ${msg.exitCode}]\r\n`);
        }
      } catch (e) {
        // Fallback if not JSON
        if (typeof event.data === "string") {
          term.write(event.data);
        }
      }
    };

    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "data", data }));
      }
    });

    const resizeObserver = new ResizeObserver(() => {
      if (fitAddonRef.current && wsRef.current?.readyState === WebSocket.OPEN && xtermRef.current) {
        fitAddonRef.current.fit();
        wsRef.current.send(JSON.stringify({
          type: "resize",
          cols: xtermRef.current.cols,
          rows: xtermRef.current.rows
        }));
      }
    });

    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      ws.close();
      term.dispose();
    };
  }, []);

  return <div ref={containerRef} className="h-full w-full overflow-hidden" data-testid="terminal-container" />;
}

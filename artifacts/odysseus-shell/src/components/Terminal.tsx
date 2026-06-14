import { useEffect, useRef, forwardRef, useImperativeHandle } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { useShellToken } from "@/hooks/use-shell-token";
import { apiWsUrl } from "@/lib/api-url";

export interface TerminalHandle {
  clear: () => void;
  getLastOutput: () => string;
}

interface TerminalProps {
  /** Scopes this terminal to a specific VM. Agent VM-targeting is wired in Phase 4. */
  vmId?: string;
}

export const Terminal = forwardRef<TerminalHandle, TerminalProps>(({ vmId }, ref) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const outputBufferRef = useRef<string>("");

  const { data: shellToken } = useShellToken();

  useImperativeHandle(ref, () => ({
    clear: () => {
      xtermRef.current?.clear();
      outputBufferRef.current = "";
    },
    getLastOutput: () => outputBufferRef.current,
  }));

  useEffect(() => {
    if (!containerRef.current) return;
    // Wait until we have the shell token before opening the WebSocket
    if (!shellToken) return;

    const term = new XTerm({
      cursorBlink: true,
      fontFamily: "var(--font-mono)",
      theme: {
        background: "#09090b",
        foreground: "#fafafa",
      },
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);
    fitAddon.fit();

    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    // Include the session token as a query param — WebSocket API doesn't support
    // custom headers, so ?token= is the standard workaround for token auth on WS.
    // apiWsUrl handles both browser (relative) and Electron file:// (absolute) modes.
    const wsPath = vmId
      ? `/api/shell/ws?token=${encodeURIComponent(shellToken)}&vm=${encodeURIComponent(vmId)}`
      : `/api/shell/ws?token=${encodeURIComponent(shellToken)}`;
    const ws = new WebSocket(apiWsUrl(wsPath));
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
          const plain = String(msg.data).replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
          outputBufferRef.current = (outputBufferRef.current + plain).slice(-8192);
        } else if (msg.type === "exit") {
          term.write(`\r\n[Process exited with code ${msg.exitCode}]\r\n`);
        }
      } catch {
        if (typeof event.data === "string") {
          term.write(event.data);
          outputBufferRef.current = (outputBufferRef.current + event.data).slice(-8192);
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
        wsRef.current.send(
          JSON.stringify({ type: "resize", cols: xtermRef.current.cols, rows: xtermRef.current.rows }),
        );
      }
    });

    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      ws.close();
      term.dispose();
    };
  }, [shellToken, vmId]); // re-run if token changes (e.g. API server restart) or VM target changes

  return (
    <div ref={containerRef} className="h-full w-full overflow-hidden" data-testid="terminal-container" />
  );
});

Terminal.displayName = "Terminal";

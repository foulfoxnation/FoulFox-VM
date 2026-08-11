import { useEffect, useRef, useState } from "react";
import { apiUrl } from "@/lib/api-url";

interface LogEntry {
  ts: number;
  level: "info" | "warn" | "error";
  text: string;
}

export function LogStream({ shellToken }: { shellToken: string | null }) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!shellToken) return;

    const es = new EventSource(apiUrl(`/api/shell/logs/stream?token=${shellToken}`));
    
    es.onmessage = (e) => {
      try {
        const entry: LogEntry = JSON.parse(e.data);
        setLogs(prev => [...prev.slice(-499), entry]); // cap at 500
      } catch (err) {}
    };

    return () => es.close();
  }, [shellToken]);

  // Auto-scroll to bottom
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs]);

  if (!shellToken) {
    return (
      <div className="flex h-full items-center justify-center bg-zinc-950 text-zinc-500 text-sm font-mono">
        Waiting for shell token...
      </div>
    );
  }

  return (
    <div ref={scrollRef} className="w-full h-full bg-zinc-950 overflow-y-auto p-4 space-y-1 font-mono text-xs">
      {logs.map((log, i) => (
        <div key={i} className={`flex gap-3 leading-tight ${log.level === 'error' ? 'text-red-400' : log.level === 'warn' ? 'text-amber-400' : 'text-zinc-300'}`}>
          <span className="text-zinc-600 shrink-0">[{new Date(log.ts).toISOString().split('T')[1].replace('Z', '')}]</span>
          <span className={`shrink-0 w-10 uppercase ${log.level === 'error' ? 'font-bold' : ''}`}>{log.level}</span>
          <span className="break-all whitespace-pre-wrap">{log.text}</span>
        </div>
      ))}
      {logs.length === 0 && (
        <div className="text-zinc-500 italic">Waiting for logs...</div>
      )}
    </div>
  );
}
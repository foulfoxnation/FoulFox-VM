import { useEffect, useRef, useState } from "react";
import { apiUrl } from "@/lib/api-url";

interface LogEntry {
  ts: number;
  level: "info" | "warn" | "error";
  text: string;
}

interface LogSource {
  id: string;
  label: string;
  group: string;
}

export function LogStream({ shellToken }: { shellToken: string | null }) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [sources, setSources] = useState<LogSource[]>([]);
  const [source, setSource] = useState("system");
  const scrollRef = useRef<HTMLDivElement>(null);

  // Load the list of available log sources (journal, services, VMs, Windows).
  useEffect(() => {
    if (!shellToken) return;
    let cancelled = false;
    fetch(apiUrl(`/api/shell/logs/sources?token=${shellToken}`))
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data) => {
        if (!cancelled && Array.isArray(data.sources)) setSources(data.sources);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [shellToken]);

  useEffect(() => {
    if (!shellToken) return;
    setLogs([]);
    const es = new EventSource(apiUrl(`/api/shell/logs/stream?token=${shellToken}&source=${encodeURIComponent(source)}`));

    es.onmessage = (e) => {
      try {
        const entry: LogEntry = JSON.parse(e.data);
        setLogs(prev => [...prev.slice(-499), entry]); // cap at 500
      } catch (err) {}
    };

    return () => es.close();
  }, [shellToken, source]);

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

  const groups = Array.from(new Set(sources.map((s) => s.group)));

  return (
    <div className="flex flex-col w-full h-full bg-zinc-950">
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-zinc-800 shrink-0">
        <span className="text-[11px] uppercase tracking-wide text-zinc-500 font-mono">Source</span>
        <select
          value={source}
          onChange={(e) => setSource(e.target.value)}
          className="bg-zinc-900 text-zinc-200 text-xs font-mono border border-zinc-700 rounded px-2 py-1 max-w-[280px]"
          data-testid="select-log-source"
        >
          {groups.map((g) => (
            <optgroup key={g} label={g}>
              {sources.filter((s) => s.group === g).map((s) => (
                <option key={s.id} value={s.id}>{s.label}</option>
              ))}
            </optgroup>
          ))}
          {sources.length === 0 && <option value="system">System journal</option>}
        </select>
      </div>
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto p-4 space-y-1 font-mono text-xs">
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
    </div>
  );
}

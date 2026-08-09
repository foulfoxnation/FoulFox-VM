/**
 * DiagnosticPanel — FoulFox OS self-report / fix-loop dashboard.
 *
 * Shows real-time system health checks, the autonomous bug-fix loop status,
 * and lets you trigger a report or start the closed-loop Replit communication cycle.
 */
import { useState, useEffect, useRef, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Input } from "@/components/ui/input";
import {
  CheckCircle2, XCircle, AlertTriangle, HelpCircle,
  RefreshCw, Play, Square, Send, ChevronDown, ChevronUp,
  Activity, Loader2, Copy, Check,
} from "lucide-react";
import { apiUrl } from "@/lib/api-url";
import { authedFetch } from "@/lib/shell-token";
import { useToast } from "@/hooks/use-toast";

// ── Types ────────────────────────────────────────────────────────────────────

interface CheckResult {
  id: string;
  name: string;
  status: "ok" | "warn" | "fail" | "unknown";
  detail: string;
  value: unknown;
}

interface LoopState {
  running: boolean;
  iteration: number;
  phase: string;
  last_sent_at: number | null;
  replit_url: string;
  auto_send: boolean;
  all_passed: boolean;
  stopped_reason: string | null;
  summary: { ok: number; warn: number; fail: number } | null;
  checks: CheckResult[] | null;
  markdown: string | null;
  log: string[];
}

// ── Status icon ───────────────────────────────────────────────────────────────

function StatusIcon({ status }: { status: CheckResult["status"] }) {
  switch (status) {
    case "ok":      return <CheckCircle2  className="h-3.5 w-3.5 text-green-500 shrink-0" />;
    case "warn":    return <AlertTriangle className="h-3.5 w-3.5 text-yellow-500 shrink-0" />;
    case "fail":    return <XCircle       className="h-3.5 w-3.5 text-red-500 shrink-0" />;
    default:        return <HelpCircle    className="h-3.5 w-3.5 text-muted-foreground shrink-0" />;
  }
}

function statusBg(status: CheckResult["status"]) {
  switch (status) {
    case "ok":    return "bg-green-500/10 border-green-500/20";
    case "warn":  return "bg-yellow-500/10 border-yellow-500/20";
    case "fail":  return "bg-red-500/10 border-red-500/20";
    default:      return "bg-muted/20 border-border/30";
  }
}

// ── Phase label ───────────────────────────────────────────────────────────────

function PhaseLabel({ phase, running }: { phase: string; running: boolean }) {
  const labels: Record<string, string> = {
    idle: "Idle",
    diagnosing: "Running diagnostics…",
    sending: "Sending to Replit…",
    waiting: "Waiting for update…",
    verifying: "Verifying fixes…",
    done: "All checks passed ✓",
  };
  return (
    <span className={`text-xs ${running ? "text-primary" : "text-muted-foreground"}`}>
      {labels[phase] ?? phase}
    </span>
  );
}

// ── Copy button ───────────────────────────────────────────────────────────────

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <button type="button" onClick={copy} className="ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors">
      {copied ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
      {copied ? "Copied" : "Copy report"}
    </button>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function DiagnosticPanel() {
  const [loop, setLoop] = useState<LoopState | null>(null);
  const [loading, setLoading] = useState(false);
  const [replitUrl, setReplitUrl] = useState("https://replit.com/@foulfoxnation/Odysseus-VM");
  const [maxIters, setMaxIters] = useState(20);
  const [showLog, setShowLog] = useState(false);
  const [showMarkdown, setShowMarkdown] = useState(false);
  const [sending, setSending] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const sseRef = useRef<EventSource | null>(null);
  const { toast } = useToast();

  // ── SSE stream ──────────────────────────────────────────────────────────────

  const startStream = useCallback(() => {
    if (sseRef.current) sseRef.current.close();
    const es = new EventSource(apiUrl("/api/odysseus/api/bug-loop/stream"));
    sseRef.current = es;
    es.onmessage = (e) => {
      try { setLoop(JSON.parse(e.data)); } catch { /* ignore */ }
    };
    es.onerror = () => {
      // Back-off reconnect
      setTimeout(startStream, 5000);
    };
  }, []);

  useEffect(() => {
    startStream();
    return () => sseRef.current?.close();
  }, [startStream]);

  useEffect(() => {
    if (logRef.current && showLog) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [loop?.log, showLog]);

  // ── Actions ─────────────────────────────────────────────────────────────────

  const runReport = async () => {
    setLoading(true);
    try {
      const res = await authedFetch("/api/odysseus/api/bug-loop/report", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Failed");
      toast({ title: "Diagnostics complete", description: `${data.report?.summary?.ok ?? 0} OK · ${data.report?.summary?.fail ?? 0} fail` });
    } catch (e) {
      toast({ title: "Diagnostics failed", description: (e as Error).message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  const startLoop = async () => {
    const res = await authedFetch("/api/odysseus/api/bug-loop/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ replitUrl, autoSend: true, maxIterations: maxIters }),
    });
    const data = await res.json();
    if (!data.ok) toast({ title: "Failed to start loop", description: data.detail, variant: "destructive" });
  };

  const stopLoop = async () => {
    await authedFetch("/api/odysseus/api/bug-loop/stop", { method: "POST" });
  };

  const sendToReplit = async () => {
    setSending(true);
    try {
      const res = await authedFetch("/api/odysseus/api/bug-loop/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ replitUrl }),
      });
      const data = await res.json();
      if (data.ok) {
        toast({ title: "Report sent to Replit", description: data.detail });
      } else {
        toast({ title: "Send failed", description: data.detail, variant: "destructive" });
      }
    } catch (e) {
      toast({ title: "Send error", description: (e as Error).message, variant: "destructive" });
    } finally {
      setSending(false);
    }
  };

  // ── Render ──────────────────────────────────────────────────────────────────

  const checks = loop?.checks ?? [];
  const summary = loop?.summary;
  const hasReport = checks.length > 0;
  const issues = checks.filter(c => c.status !== "ok");
  const passing = checks.filter(c => c.status === "ok");

  return (
    <div className="space-y-3 p-4">
      {/* ── Header bar ────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-primary" />
          <span className="text-sm font-medium">System Diagnostics</span>
          {loop?.running && (
            <Badge variant="secondary" className="animate-pulse bg-primary/20 text-primary text-[10px]">
              Loop #{loop.iteration}
            </Badge>
          )}
          {loop?.all_passed && (
            <Badge className="bg-green-500/20 text-green-400 text-[10px]">All passing</Badge>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            size="sm" variant="outline" className="h-7 text-xs gap-1"
            onClick={runReport} disabled={loading || loop?.running}
          >
            {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
            {loading ? "Running…" : "Run now"}
          </Button>
          {loop?.running ? (
            <Button size="sm" variant="outline" className="h-7 text-xs gap-1 text-red-400 hover:text-red-300 hover:border-red-500/40" onClick={stopLoop}>
              <Square className="h-3 w-3" /> Stop loop
            </Button>
          ) : (
            <Button size="sm" className="h-7 text-xs gap-1" onClick={startLoop} disabled={loading}>
              <Play className="h-3 w-3" /> Start fix loop
            </Button>
          )}
        </div>
      </div>

      {/* ── Loop status bar ────────────────────────────────────────────────── */}
      {loop && (
        <div className="flex items-center gap-3 rounded border bg-muted/20 px-3 py-1.5 text-xs text-muted-foreground">
          <PhaseLabel phase={loop.phase} running={loop.running} />
          {loop.running && <Loader2 className="h-3 w-3 animate-spin text-primary ml-auto" />}
          {loop.stopped_reason && (
            <span className="ml-auto text-yellow-500 truncate max-w-[200px]">{loop.stopped_reason}</span>
          )}
        </div>
      )}

      {/* ── Summary pills ──────────────────────────────────────────────────── */}
      {summary && (
        <div className="flex gap-2 text-xs">
          <span className="flex items-center gap-1 rounded-full bg-green-500/10 px-2 py-0.5 text-green-400">
            <CheckCircle2 className="h-3 w-3" /> {summary.ok} OK
          </span>
          {summary.warn > 0 && (
            <span className="flex items-center gap-1 rounded-full bg-yellow-500/10 px-2 py-0.5 text-yellow-400">
              <AlertTriangle className="h-3 w-3" /> {summary.warn} warn
            </span>
          )}
          {summary.fail > 0 && (
            <span className="flex items-center gap-1 rounded-full bg-red-500/10 px-2 py-0.5 text-red-400">
              <XCircle className="h-3 w-3" /> {summary.fail} fail
            </span>
          )}
          {loop?.markdown && <CopyButton text={loop.markdown} />}
        </div>
      )}

      {/* ── Check results ──────────────────────────────────────────────────── */}
      {hasReport && (
        <div className="space-y-1">
          {/* Issues first */}
          {issues.map(c => (
            <div key={c.id} className={`flex items-start gap-2 rounded border px-2.5 py-1.5 text-xs ${statusBg(c.status)}`}>
              <StatusIcon status={c.status} />
              <div className="min-w-0 flex-1">
                <span className="font-medium">{c.name}</span>
                <span className="ml-1.5 text-muted-foreground truncate">{c.detail}</span>
              </div>
            </div>
          ))}

          {/* Collapsible passing checks */}
          {passing.length > 0 && (
            <details className="group">
              <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/20">
                <CheckCircle2 className="h-3 w-3 text-green-500" />
                {passing.length} passing checks
                <ChevronDown className="ml-auto h-3 w-3 group-open:rotate-180 transition-transform" />
              </summary>
              <div className="mt-1 space-y-1 pl-1">
                {passing.map(c => (
                  <div key={c.id} className="flex items-start gap-2 rounded border border-green-500/10 bg-green-500/5 px-2.5 py-1 text-xs">
                    <StatusIcon status={c.status} />
                    <div className="min-w-0 flex-1">
                      <span className="font-medium">{c.name}</span>
                      <span className="ml-1.5 text-muted-foreground truncate">{c.detail}</span>
                    </div>
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      )}

      {!hasReport && !loading && (
        <p className="py-4 text-center text-xs text-muted-foreground">
          No report yet — click "Run now" to check all systems.
        </p>
      )}

      {/* ── Replit URL + send ─────────────────────────────────────────────── */}
      <div className="space-y-2 rounded-lg border bg-muted/10 p-3">
        <p className="text-xs font-medium text-foreground">Send to Replit</p>
        <p className="text-[11px] text-muted-foreground">
          The agent navigates the kiosk browser to this URL and pastes the report into the AI chat.
          Make sure you are logged into Replit in the browser first.
        </p>
        <div className="flex gap-2">
          <Input
            value={replitUrl}
            onChange={e => setReplitUrl(e.target.value)}
            placeholder="https://replit.com/@you/project"
            className="h-7 flex-1 font-mono text-xs"
          />
          <Button
            size="sm" variant="secondary" className="h-7 text-xs gap-1 shrink-0"
            onClick={sendToReplit} disabled={sending || !hasReport}
            title={!hasReport ? "Run diagnostics first" : "Send report to Replit via browser automation"}
          >
            {sending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
            {sending ? "Sending…" : "Send now"}
          </Button>
        </div>

        <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
          <span>Loop max iterations:</span>
          <input
            type="number" min={1} max={100} value={maxIters}
            onChange={e => setMaxIters(Number(e.target.value))}
            className="w-14 rounded border bg-muted/30 px-1.5 py-0.5 text-xs text-foreground"
          />
          <span className="text-muted-foreground/60">Auto-send is enabled when loop is running.</span>
        </div>
      </div>

      {/* ── Loop log ──────────────────────────────────────────────────────── */}
      {loop && loop.log.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setShowLog(v => !v)}
            className="flex w-full items-center gap-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground"
          >
            <Activity className="h-3 w-3" />
            Loop log ({loop.log.length} lines)
            {showLog ? <ChevronUp className="ml-auto h-3 w-3" /> : <ChevronDown className="ml-auto h-3 w-3" />}
          </button>
          {showLog && (
            <div ref={logRef} className="mt-1 max-h-48 overflow-y-auto rounded border bg-zinc-950 p-2 font-mono text-[10px] text-zinc-400">
              {loop.log.map((line, i) => (
                <div key={i} className={line.includes("❌") || line.includes("error") || line.includes("fail") ? "text-red-400" : line.includes("✅") || line.includes("pass") ? "text-green-400" : ""}>
                  {line}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Raw markdown ──────────────────────────────────────────────────── */}
      {loop?.markdown && (
        <div>
          <button
            type="button"
            onClick={() => setShowMarkdown(v => !v)}
            className="flex w-full items-center gap-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground"
          >
            Raw report (Markdown)
            {showMarkdown ? <ChevronUp className="ml-auto h-3 w-3" /> : <ChevronDown className="ml-auto h-3 w-3" />}
          </button>
          {showMarkdown && (
            <pre className="mt-1 max-h-64 overflow-y-auto whitespace-pre-wrap rounded border bg-zinc-950 p-3 text-[10px] text-zinc-300">
              {loop.markdown}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

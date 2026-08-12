/**
 * DiagnosticPanel — FoulFox OS functional-capability dashboard.
 *
 * Shows real-time system checks grouped by capability area, the autonomous
 * bug-fix loop status, and controls for triggering a report or sending it
 * to Replit.
 */
import { useState, useEffect, useRef, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  CheckCircle2, XCircle, AlertTriangle, HelpCircle,
  RefreshCw, Play, Square, Send, ChevronDown, ChevronUp,
  Activity, Loader2, Copy, Check,
} from "lucide-react";
import { apiUrl } from "@/lib/api-url";
import { authedFetch } from "@/lib/shell-token";
import HardwareCard from "@/components/HardwareCard";
import { useToast } from "@/hooks/use-toast";

// ── Types ────────────────────────────────────────────────────────────────────

interface CheckResult {
  id: string;
  category: string;
  name: string;
  status: "ok" | "warn" | "fail" | "unknown";
  detail: string;
  value: unknown;
}

interface CatSummary {
  label: string;
  icon: string;
  ok: number;
  warn: number;
  fail: number;
  status: "ok" | "warn" | "fail";
  checks: CheckResult[];
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
  summary: { ok: number; warn: number; fail: number; total?: number } | null;
  checks: CheckResult[] | null;
  markdown: string | null;
  log: string[];
  // Extended fields from new build_report
  categories?: Record<string, CatSummary>;
  category_order?: string[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function StatusIcon({ status, className = "h-3.5 w-3.5 shrink-0" }: { status: CheckResult["status"]; className?: string }) {
  switch (status) {
    case "ok":    return <CheckCircle2  className={`${className} text-green-500`} />;
    case "warn":  return <AlertTriangle className={`${className} text-yellow-500`} />;
    case "fail":  return <XCircle       className={`${className} text-red-500`} />;
    default:      return <HelpCircle   className={`${className} text-muted-foreground`} />;
  }
}

function statusBorder(s: string) {
  if (s === "ok")   return "border-green-500/20 bg-green-500/5";
  if (s === "warn")  return "border-yellow-500/20 bg-yellow-500/5";
  if (s === "fail")  return "border-red-500/20 bg-red-500/5";
  return "border-border/20 bg-muted/10";
}

function statusHeaderBg(s: string) {
  if (s === "ok")   return "bg-green-500/10 text-green-400";
  if (s === "warn")  return "bg-yellow-500/10 text-yellow-400";
  if (s === "fail")  return "bg-red-500/10 text-red-400";
  return "bg-muted/20 text-muted-foreground";
}

function phaseLabelText(phase: string): string {
  const m: Record<string, string> = {
    idle: "Idle", diagnosing: "Running diagnostics…", sending: "Sending to Replit…",
    waiting: "Waiting for update…", verifying: "Verifying fixes…", done: "All checks passed ✓",
  };
  return m[phase] ?? phase;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button type="button" onClick={() => {
      navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
    }} className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors">
      {copied ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
      {copied ? "Copied" : "Copy report"}
    </button>
  );
}

// ── Category section ──────────────────────────────────────────────────────────

function CategorySection({ catId, cat }: { catId: string; cat: CatSummary }) {
  const [open, setOpen] = useState(cat.status !== "ok"); // auto-open problems

  return (
    <div className={`rounded-lg border ${statusBorder(cat.status)} overflow-hidden`}>
      {/* Header */}
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        <span className="text-base leading-none">{cat.icon}</span>
        <span className="flex-1 text-sm font-medium">{cat.label}</span>
        <div className="flex items-center gap-2">
          {cat.ok > 0   && <span className="text-[10px] text-green-400">{cat.ok}✅</span>}
          {cat.warn > 0 && <span className="text-[10px] text-yellow-400">{cat.warn}⚠️</span>}
          {cat.fail > 0 && <span className="text-[10px] text-red-400">{cat.fail}❌</span>}
          <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${statusHeaderBg(cat.status)}`}>
            {cat.status.toUpperCase()}
          </span>
        </div>
        {open ? <ChevronUp className="h-3 w-3 text-muted-foreground" /> : <ChevronDown className="h-3 w-3 text-muted-foreground" />}
      </button>

      {/* Checks */}
      {open && (
        <div className="border-t border-inherit divide-y divide-inherit">
          {cat.checks.map(c => (
            <div key={c.id} className="flex items-start gap-2 px-3 py-2">
              <StatusIcon status={c.status} className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-xs font-medium">{c.name}</span>
                </div>
                <p className="mt-0.5 text-[11px] text-muted-foreground leading-snug">{c.detail}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
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
  const [activeTab, setActiveTab] = useState<"systems" | "loop">("systems");
  const logRef = useRef<HTMLDivElement>(null);
  const sseRef = useRef<EventSource | null>(null);
  const { toast } = useToast();

  // ── SSE ────────────────────────────────────────────────────────────────────

  const startStream = useCallback(() => {
    if (sseRef.current) sseRef.current.close();
    const es = new EventSource(apiUrl("/api/odysseus/api/bug-loop/stream"));
    sseRef.current = es;
    es.onmessage = (e) => { try { setLoop(JSON.parse(e.data)); } catch { /* ignore */ } };
    es.onerror = () => { setTimeout(startStream, 5000); };
  }, []);

  useEffect(() => { startStream(); return () => sseRef.current?.close(); }, [startStream]);

  useEffect(() => {
    if (logRef.current && showLog) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [loop?.log, showLog]);

  // ── Actions ────────────────────────────────────────────────────────────────

  const runReport = async () => {
    setLoading(true);
    try {
      const res = await authedFetch("/api/odysseus/api/bug-loop/report", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Failed");
      const s = data.report?.summary;
      toast({ title: "Diagnostics complete", description: s ? `${s.ok} OK · ${s.warn} warn · ${s.fail} fail` : "Done" });
    } catch (e) {
      toast({ title: "Diagnostics failed", description: (e as Error).message, variant: "destructive" });
    } finally { setLoading(false); }
  };

  const startLoop = async () => {
    const res = await authedFetch("/api/odysseus/api/bug-loop/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ replitUrl, autoSend: true, maxIterations: maxIters }),
    });
    const data = await res.json();
    if (!data.ok) toast({ title: "Failed to start loop", description: data.detail, variant: "destructive" });
    else setActiveTab("loop");
  };

  const stopLoop = () => authedFetch("/api/odysseus/api/bug-loop/stop", { method: "POST" });

  const sendToReplit = async () => {
    setSending(true);
    try {
      const res = await authedFetch("/api/odysseus/api/bug-loop/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ replitUrl }),
      });
      const data = await res.json();
      if (data.ok) toast({ title: "Report sent to Replit", description: data.detail });
      else toast({ title: "Send failed", description: data.detail, variant: "destructive" });
    } catch (e) {
      toast({ title: "Send error", description: (e as Error).message, variant: "destructive" });
    } finally { setSending(false); }
  };

  // ── Derived state ──────────────────────────────────────────────────────────

  const checks  = loop?.checks ?? [];
  const summary = loop?.summary;
  const catOrder = loop?.category_order ?? [];
  const catMap   = loop?.categories ?? {};
  const hasCats  = catOrder.length > 0 && Object.keys(catMap).length > 0;
  const hasReport = checks.length > 0;
  const issues  = checks.filter(c => c.status !== "ok");

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* ── Sticky top bar ──────────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-2 border-b bg-card/80 backdrop-blur px-4 py-2 shrink-0">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-primary" />
          <span className="text-sm font-semibold">System Capabilities</span>
          {loop?.running && (
            <span className="animate-pulse rounded-full bg-primary/20 px-2 py-0.5 text-[10px] text-primary font-medium">
              Loop #{loop.iteration} · {phaseLabelText(loop.phase)}
            </span>
          )}
          {loop?.all_passed && (
            <span className="rounded-full bg-green-500/15 px-2 py-0.5 text-[10px] text-green-400 font-medium">
              All passing ✓
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <Button size="sm" variant="outline" className="h-7 text-xs gap-1"
            onClick={runReport} disabled={loading || loop?.running}>
            {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
            {loading ? "Running…" : "Run Diagnostics"}
          </Button>
          {loop?.running ? (
            <Button size="sm" variant="outline" className="h-7 text-xs gap-1 text-red-400 hover:text-red-300 hover:border-red-500/40" onClick={stopLoop}>
              <Square className="h-3 w-3" /> Stop
            </Button>
          ) : (
            <Button size="sm" className="h-7 text-xs gap-1" onClick={startLoop} disabled={loading}>
              <Play className="h-3 w-3" /> Start Fix Loop
            </Button>
          )}
        </div>
      </div>

      {/* ── Summary strip ───────────────────────────────────────────────── */}
      {summary && (
        <div className="flex items-center gap-3 border-b px-4 py-2 text-xs shrink-0 bg-muted/10">
          <span className="flex items-center gap-1 text-green-400"><CheckCircle2 className="h-3 w-3" />{summary.ok} OK</span>
          {(summary.warn ?? 0) > 0 && <span className="flex items-center gap-1 text-yellow-400"><AlertTriangle className="h-3 w-3" />{summary.warn} warn</span>}
          {(summary.fail ?? 0) > 0 && <span className="flex items-center gap-1 text-red-400"><XCircle className="h-3 w-3" />{summary.fail} fail</span>}
          <span className="text-muted-foreground/50">of {summary.total ?? checks.length} checks</span>
          {loop?.markdown && <span className="ml-auto"><CopyButton text={loop.markdown} /></span>}
        </div>
      )}

      {/* ── Tab bar ──────────────────────────────────────────────────────── */}
      <div className="flex gap-0 border-b shrink-0">
        {(["systems", "loop"] as const).map(t => (
          <button key={t} type="button" onClick={() => setActiveTab(t)}
            className={`px-4 py-2 text-xs font-medium transition-colors ${activeTab === t ? "border-b-2 border-primary text-foreground" : "text-muted-foreground hover:text-foreground"}`}>
            {t === "systems" ? "📊 Systems" : "🔄 Fix Loop"}
          </button>
        ))}
      </div>

      {/* ── Scrollable body ──────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto min-h-0">

        {/* ── SYSTEMS TAB ──────────────────────────────────────────────── */}
        {activeTab === "systems" && (
          <div className="p-4 space-y-2">
            <HardwareCard />
            {!hasReport && !loading && (
              <div className="py-12 text-center text-sm text-muted-foreground">
                <Activity className="mx-auto mb-3 h-8 w-8 opacity-30" />
                <p className="font-medium">No report yet</p>
                <p className="mt-1 text-xs">Click "Run Diagnostics" to evaluate all 13 capability areas.</p>
              </div>
            )}

            {loading && !hasReport && (
              <div className="py-12 text-center text-sm text-muted-foreground">
                <Loader2 className="mx-auto mb-3 h-8 w-8 animate-spin opacity-50" />
                <p>Running {Object.keys({
                  foulfox_os: 1, voice_forge: 1, llama_llama: 1, windows_vm: 1,
                  agent_vm_socket: 1, agent_foulfox: 1, vm_backups: 1, voice_agent: 1,
                  agent_memory: 1, agent_learning: 1, agent_awareness: 1,
                  subagents_speed: 1, subagents_learning: 1
                }).length} capability checks…</p>
              </div>
            )}

            {/* Category sections */}
            {hasCats && catOrder.map(catId => {
              const cat = catMap[catId];
              if (!cat) return null;
              return <CategorySection key={catId} catId={catId} cat={cat} />;
            })}

            {/* Fallback: flat list if no categories yet */}
            {hasReport && !hasCats && (
              <div className="space-y-1">
                {issues.map(c => (
                  <div key={c.id} className={`flex items-start gap-2 rounded border px-2.5 py-1.5 text-xs ${statusBorder(c.status)}`}>
                    <StatusIcon status={c.status} />
                    <div className="min-w-0 flex-1">
                      <span className="font-medium">{c.name}</span>
                      <span className="ml-1.5 text-muted-foreground">{c.detail}</span>
                    </div>
                  </div>
                ))}
                <details className="group">
                  <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/20">
                    <CheckCircle2 className="h-3 w-3 text-green-500" />
                    {checks.filter(c => c.status === "ok").length} passing checks
                    <ChevronDown className="ml-auto h-3 w-3 group-open:rotate-180 transition-transform" />
                  </summary>
                  <div className="mt-1 space-y-1 pl-1">
                    {checks.filter(c => c.status === "ok").map(c => (
                      <div key={c.id} className="flex items-start gap-2 rounded border border-green-500/10 bg-green-500/5 px-2.5 py-1 text-xs">
                        <StatusIcon status={c.status} />
                        <div className="min-w-0 flex-1">
                          <span className="font-medium">{c.name}</span>
                          <span className="ml-1.5 text-muted-foreground">{c.detail}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </details>
              </div>
            )}
          </div>
        )}

        {/* ── LOOP TAB ─────────────────────────────────────────────────── */}
        {activeTab === "loop" && (
          <div className="p-4 space-y-4">

            {/* Phase */}
            {loop && (
              <div className={`flex items-center gap-2 rounded-lg border px-3 py-2.5 text-xs
                ${loop.running ? "border-primary/30 bg-primary/5" : "border-border bg-muted/10"}`}>
                {loop.running
                  ? <Loader2 className="h-4 w-4 animate-spin text-primary shrink-0" />
                  : <Activity className="h-4 w-4 text-muted-foreground shrink-0" />}
                <div className="flex-1 min-w-0">
                  <div className="font-medium">{phaseLabelText(loop.phase)}</div>
                  {loop.stopped_reason && (
                    <div className="mt-0.5 text-muted-foreground truncate">{loop.stopped_reason}</div>
                  )}
                </div>
                {loop.iteration > 0 && (
                  <span className="shrink-0 text-muted-foreground">Iteration {loop.iteration}</span>
                )}
              </div>
            )}

            {/* Config */}
            <div className="rounded-lg border bg-muted/10 p-3 space-y-3">
              <p className="text-xs font-medium">Replit Project URL</p>
              <p className="text-[11px] text-muted-foreground">
                The fix loop navigates the kiosk Chromium to this URL and pastes the capability
                report into the AI chat. Log in to Replit in the browser first.
              </p>
              <div className="flex gap-2">
                <Input value={replitUrl} onChange={e => setReplitUrl(e.target.value)}
                  placeholder="https://replit.com/@you/project"
                  className="h-7 flex-1 font-mono text-xs" />
                <Button size="sm" variant="secondary" className="h-7 text-xs gap-1 shrink-0"
                  onClick={sendToReplit} disabled={sending || !hasReport}
                  title={!hasReport ? "Run diagnostics first" : "Send report via browser"}>
                  {sending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
                  {sending ? "Sending…" : "Send now"}
                </Button>
              </div>
              <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
                <span>Max loop iterations:</span>
                <input type="number" min={1} max={100} value={maxIters}
                  onChange={e => setMaxIters(Number(e.target.value))}
                  className="w-14 rounded border bg-muted/30 px-1.5 py-0.5 text-xs text-foreground" />
              </div>
            </div>

            {/* Loop log */}
            {loop && loop.log.length > 0 && (
              <div>
                <button type="button" onClick={() => setShowLog(v => !v)}
                  className="flex w-full items-center gap-1.5 py-1 text-xs text-muted-foreground hover:text-foreground">
                  <Activity className="h-3 w-3" />
                  Activity log ({loop.log.length} events)
                  {showLog ? <ChevronUp className="ml-auto h-3 w-3" /> : <ChevronDown className="ml-auto h-3 w-3" />}
                </button>
                {showLog && (
                  <div ref={logRef} className="mt-1 max-h-56 overflow-y-auto rounded border bg-zinc-950 p-2.5 font-mono text-[10px] text-zinc-400 space-y-0.5">
                    {loop.log.map((line, i) => (
                      <div key={i} className={
                        line.includes("❌") || line.toLowerCase().includes("fail") || line.toLowerCase().includes("error")
                          ? "text-red-400"
                          : line.includes("✅") || line.toLowerCase().includes("pass") || line.toLowerCase().includes("ok")
                            ? "text-green-400"
                            : ""
                      }>{line}</div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Raw markdown */}
            {loop?.markdown && (
              <div>
                <button type="button" onClick={() => setShowMarkdown(v => !v)}
                  className="flex w-full items-center gap-1.5 py-1 text-xs text-muted-foreground hover:text-foreground">
                  Full capability report (Markdown)
                  {showMarkdown ? <ChevronUp className="ml-auto h-3 w-3" /> : <ChevronDown className="ml-auto h-3 w-3" />}
                </button>
                {showMarkdown && (
                  <pre className="mt-1 max-h-72 overflow-y-auto whitespace-pre-wrap rounded border bg-zinc-950 p-3 text-[10px] text-zinc-300">
                    {loop.markdown}
                  </pre>
                )}
              </div>
            )}

            {!loop?.running && loop?.log.length === 0 && (
              <p className="text-center text-xs text-muted-foreground py-4">
                Start the fix loop to watch the agent diagnose, report, and verify fixes automatically.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

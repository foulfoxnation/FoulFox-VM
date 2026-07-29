import { useEffect, useRef, useState, useCallback } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  ChevronDown,
  ChevronRight,
  Search,
  Brain,
  CheckCircle,
  XCircle,
  Loader2,
  Clock,
  Database,
  Trash2,
  RefreshCw,
} from "lucide-react";

const SSE_URL = "/api/odysseus/api/mtm/stream";
const MTM_BASE = "/api/odysseus/api/mtm";

interface MtmTask {
  id: string;
  title: string;
  kind: string;
  status: string;
  agent_role: string;
  parent_id: string | null;
  created_at: string;
  updated_at: string;
  findings: string;
  tool_calls: number;
  rounds: number;
  error: string | null;
  children: string[];
  meta: Record<string, unknown>;
}

interface MemEntry {
  value: unknown;
  updated_at: string;
  written_by: string;
}

const STATUS_ICON: Record<string, React.ReactNode> = {
  running: <Loader2 className="h-3.5 w-3.5 text-blue-500 animate-spin" />,
  pending: <Clock className="h-3.5 w-3.5 text-amber-500" />,
  done: <CheckCircle className="h-3.5 w-3.5 text-green-500" />,
  error: <XCircle className="h-3.5 w-3.5 text-red-500" />,
  cancelled: <XCircle className="h-3.5 w-3.5 text-zinc-400" />,
};

const KIND_COLOR: Record<string, string> = {
  discover: "bg-purple-500/15 text-purple-400 border-purple-500/30",
  worker: "bg-blue-500/15 text-blue-400 border-blue-500/30",
  scheduled: "bg-amber-500/15 text-amber-400 border-amber-500/30",
  manual: "bg-zinc-500/15 text-zinc-400 border-zinc-500/30",
  plan: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
};

function relativeTime(iso: string): string {
  try {
    const diff = (Date.now() - new Date(iso).getTime()) / 1000;
    if (diff < 5) return "just now";
    if (diff < 60) return `${Math.floor(diff)}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    return `${Math.floor(diff / 3600)}h ago`;
  } catch {
    return "";
  }
}

function TaskRow({ task, tasks, depth = 0 }: { task: MtmTask; tasks: MtmTask[]; depth?: number }) {
  const [open, setOpen] = useState(depth === 0 && task.status === "running");
  const children = tasks.filter((t) => t.parent_id === task.id);
  const hasChildren = children.length > 0;

  return (
    <div className="text-sm">
      <div
        className={[
          "flex items-start gap-2 px-3 py-2 rounded-md transition-colors",
          depth === 0 ? "hover:bg-muted/40" : "hover:bg-muted/20",
          depth > 0 ? "ml-4 pl-2 border-l border-border" : "",
        ].join(" ")}
      >
        <button
          className="mt-0.5 shrink-0"
          onClick={() => setOpen((o) => !o)}
          disabled={!hasChildren && !task.findings}
        >
          {hasChildren ? (
            open ? (
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
            )
          ) : (
            <span className="inline-block w-3.5" />
          )}
        </button>

        <div className="shrink-0 mt-0.5">{STATUS_ICON[task.status] ?? STATUS_ICON.cancelled}</div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span
              className={[
                "text-[10px] font-medium px-1.5 py-0.5 rounded border",
                KIND_COLOR[task.kind] ?? KIND_COLOR.manual,
              ].join(" ")}
            >
              {task.kind}
            </span>
            <span className="text-[10px] text-muted-foreground">{task.agent_role}</span>
            <span className="text-[10px] text-muted-foreground ml-auto shrink-0">
              {relativeTime(task.updated_at)}
            </span>
          </div>
          <p
            className="mt-0.5 font-medium text-foreground leading-snug cursor-pointer"
            onClick={() => setOpen((o) => !o)}
          >
            {task.title}
          </p>
          {(task.tool_calls > 0 || task.rounds > 0) && (
            <div className="flex gap-2 mt-0.5">
              {task.tool_calls > 0 && (
                <span className="text-[10px] text-muted-foreground">
                  {task.tool_calls} tool{task.tool_calls !== 1 ? "s" : ""}
                </span>
              )}
              {task.rounds > 0 && (
                <span className="text-[10px] text-muted-foreground">{task.rounds} rounds</span>
              )}
            </div>
          )}
          {task.error && (
            <p className="mt-1 text-[10px] text-red-400 font-mono leading-snug">{task.error}</p>
          )}
        </div>
      </div>

      {open && (
        <div className="pb-1">
          {task.findings && (
            <div className="mx-3 mb-2 rounded-md bg-muted/30 border border-border p-2 text-[11px] text-muted-foreground font-mono leading-relaxed max-h-40 overflow-y-auto whitespace-pre-wrap">
              {task.findings}
            </div>
          )}
          {children.map((child) => (
            <TaskRow key={child.id} task={child} tasks={tasks} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

export function AgentTasksPanel() {
  const [tasks, setTasks] = useState<MtmTask[]>([]);
  const [memory, setMemory] = useState<Record<string, MemEntry>>({});
  const [tab, setTab] = useState<"tasks" | "memory">("tasks");
  const [connected, setConnected] = useState(false);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const connect = useCallback(() => {
    if (esRef.current) {
      esRef.current.close();
    }
    const es = new EventSource(SSE_URL);
    esRef.current = es;

    es.onopen = () => setConnected(true);
    es.onerror = () => {
      setConnected(false);
      es.close();
      reconnectRef.current = setTimeout(connect, 4000);
    };

    es.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data);
        if (data.type === "ping") return;

        if (data.type === "snapshot") {
          setTasks(data.tasks ?? []);
          setMemory(data.memory ?? {});
          return;
        }
        if (data.type === "task_created" || data.type === "task_updated") {
          const t: MtmTask = data.task;
          setTasks((prev) => {
            const idx = prev.findIndex((x) => x.id === t.id);
            if (idx === -1) return [t, ...prev];
            const next = [...prev];
            next[idx] = t;
            return next;
          });
          return;
        }
        if (data.type === "memory_written") {
          setMemory((prev) => ({
            ...prev,
            [data.key]: { value: data.value ?? "", updated_at: data.ts ?? "", written_by: data.written_by ?? "" },
          }));
          return;
        }
        if (data.type === "memory_deleted") {
          setMemory((prev) => {
            const next = { ...prev };
            delete next[data.key];
            return next;
          });
          return;
        }
        if (data.type === "memory_cleared") {
          setMemory({});
          return;
        }
      } catch {
        /* ignore parse errors */
      }
    };
  }, []);

  useEffect(() => {
    connect();
    return () => {
      esRef.current?.close();
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
    };
  }, [connect]);

  const clearFinishedTasks = async () => {
    const finished = tasks.filter((t) => t.status !== "running" && t.status !== "pending");
    await Promise.allSettled(
      finished.map((t) =>
        fetch(`${MTM_BASE}/tasks/${t.id}`, { method: "DELETE" }).catch(() => {})
      )
    );
    setTasks((prev) => prev.filter((t) => t.status === "running" || t.status === "pending"));
  };

  const clearMemory = async () => {
    await fetch(`${MTM_BASE}/memory`, { method: "DELETE" });
    setMemory({});
  };

  const topLevel = tasks.filter((t) => t.parent_id === null);
  const active = topLevel.filter((t) => t.status === "running" || t.status === "pending");
  const finished = topLevel.filter((t) => t.status !== "running" && t.status !== "pending");
  const memKeys = Object.keys(memory).sort((a, b) => {
    const ta = memory[a]?.updated_at ?? "";
    const tb = memory[b]?.updated_at ?? "";
    return tb.localeCompare(ta);
  });

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      {/* Header */}
      <div className="flex items-center justify-between border-b px-3 py-2 shrink-0">
        <div className="flex items-center gap-2">
          <Brain className="h-4 w-4 text-primary" />
          <span className="font-semibold text-sm">Agent Activity</span>
          <div
            className={`h-1.5 w-1.5 rounded-full ${connected ? "bg-green-500" : "bg-red-500"}`}
            title={connected ? "Live" : "Reconnecting…"}
          />
        </div>
        <div className="flex items-center gap-1">
          {active.length > 0 && (
            <Badge className="text-[10px] h-5 px-1.5 bg-blue-500/20 text-blue-400 border-blue-500/30">
              {active.length} active
            </Badge>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            onClick={connect}
            title="Reconnect SSE stream"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* Tab strip */}
      <div className="flex border-b shrink-0">
        {(["tasks", "memory"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={[
              "flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors border-b-2",
              tab === t
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            ].join(" ")}
          >
            {t === "tasks" ? (
              <>
                <Search className="h-3 w-3" />
                Tasks
                {tasks.length > 0 && (
                  <span className="ml-0.5 rounded-full bg-muted px-1 text-[10px] leading-4">
                    {tasks.length}
                  </span>
                )}
              </>
            ) : (
              <>
                <Database className="h-3 w-3" />
                Memory
                {memKeys.length > 0 && (
                  <span className="ml-0.5 rounded-full bg-muted px-1 text-[10px] leading-4">
                    {memKeys.length}
                  </span>
                )}
              </>
            )}
          </button>
        ))}
      </div>

      {/* Content */}
      <ScrollArea className="flex-1 min-h-0">
        {tab === "tasks" ? (
          <div className="p-2 space-y-1">
            {tasks.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 py-12 text-muted-foreground text-sm">
                <Brain className="h-8 w-8 opacity-30" />
                <p>No agent tasks yet</p>
                <p className="text-xs text-center max-w-48 opacity-70">
                  Tasks appear here when the agent uses <code className="font-mono">discover</code> or runs background jobs
                </p>
              </div>
            ) : (
              <>
                {active.length > 0 && (
                  <div>
                    <div className="flex items-center gap-2 px-3 py-1">
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                        Active
                      </span>
                      <Loader2 className="h-3 w-3 text-blue-500 animate-spin" />
                    </div>
                    {active.map((t) => (
                      <TaskRow key={t.id} task={t} tasks={tasks} />
                    ))}
                  </div>
                )}

                {finished.length > 0 && (
                  <div>
                    <div className="flex items-center justify-between px-3 py-1">
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                        Completed ({finished.length})
                      </span>
                      <button
                        onClick={clearFinishedTasks}
                        className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
                        title="Clear finished tasks"
                      >
                        <Trash2 className="h-3 w-3" />
                        Clear
                      </button>
                    </div>
                    {finished.map((t) => (
                      <TaskRow key={t.id} task={t} tasks={tasks} />
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        ) : (
          <div className="p-2 space-y-1">
            {memKeys.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 py-12 text-muted-foreground text-sm">
                <Database className="h-8 w-8 opacity-30" />
                <p>Shared memory is empty</p>
                <p className="text-xs text-center max-w-48 opacity-70">
                  Agents write findings here with <code className="font-mono">discover(write_key=…)</code>
                </p>
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between px-3 py-1">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {memKeys.length} entr{memKeys.length === 1 ? "y" : "ies"}
                  </span>
                  <button
                    onClick={clearMemory}
                    className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
                    title="Clear all shared memory"
                  >
                    <Trash2 className="h-3 w-3" />
                    Clear all
                  </button>
                </div>
                {memKeys.map((k) => {
                  const entry = memory[k];
                  const isOpen = expandedKey === k;
                  const val = entry?.value;
                  const preview = typeof val === "string" ? val : JSON.stringify(val);
                  return (
                    <div
                      key={k}
                      className="rounded-md border border-border bg-card mx-1 text-sm overflow-hidden"
                    >
                      <button
                        className="w-full flex items-start gap-2 px-3 py-2 hover:bg-muted/40 transition-colors text-left"
                        onClick={() => setExpandedKey(isOpen ? null : k)}
                      >
                        {isOpen ? (
                          <ChevronDown className="h-3.5 w-3.5 mt-0.5 text-muted-foreground shrink-0" />
                        ) : (
                          <ChevronRight className="h-3.5 w-3.5 mt-0.5 text-muted-foreground shrink-0" />
                        )}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <code className="font-mono text-[11px] text-primary font-semibold">
                              {k}
                            </code>
                            <span className="text-[10px] text-muted-foreground ml-auto">
                              by {entry?.written_by} · {relativeTime(entry?.updated_at ?? "")}
                            </span>
                          </div>
                          {!isOpen && (
                            <p className="text-[11px] text-muted-foreground mt-0.5 truncate">
                              {preview?.slice(0, 120)}
                            </p>
                          )}
                        </div>
                      </button>
                      {isOpen && (
                        <div className="border-t border-border bg-muted/20 px-3 py-2 font-mono text-[11px] leading-relaxed text-foreground max-h-48 overflow-y-auto whitespace-pre-wrap">
                          {preview}
                        </div>
                      )}
                    </div>
                  );
                })}
              </>
            )}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}

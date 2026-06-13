import { useGetShellHistory, getGetShellHistoryQueryKey } from "@workspace/api-client-react";
import { format } from "date-fns";
import { Copy, Terminal as TermIcon, AlertCircle } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";

export function ShellHistoryPanel() {
  const { data: history } = useGetShellHistory({ query: { refetchInterval: 5000, queryKey: getGetShellHistoryQueryKey() } });
  const { toast } = useToast();

  const handleCopy = (cmd: string) => {
    navigator.clipboard.writeText(cmd);
    toast({ title: "Command copied to clipboard", duration: 2000 });
  };

  if (!history || history.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground p-4">
        No recent commands
      </div>
    );
  }

  return (
    <ScrollArea className="h-full">
      <div className="p-4 space-y-4">
        {history.map((entry) => (
          <div
            key={entry.id}
            className="rounded-lg border bg-card p-3 text-sm shadow-sm transition-colors hover:bg-accent/50 cursor-pointer group"
            onClick={() => handleCopy(entry.command)}
            data-testid={`history-entry-${entry.id}`}
          >
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <TermIcon className="h-3 w-3" />
                <span>{format(new Date(entry.timestamp), "HH:mm:ss")}</span>
              </div>
              <div className="flex items-center gap-2">
                {entry.exitCode !== null && (
                  <Badge variant={entry.exitCode === 0 ? "secondary" : "destructive"} className="text-[10px] h-5 px-1.5">
                    {entry.exitCode === 0 ? "0" : `Exit ${entry.exitCode}`}
                  </Badge>
                )}
                <Copy className="h-3 w-3 opacity-0 transition-opacity group-hover:opacity-100" />
              </div>
            </div>
            
            <div className="font-mono text-foreground font-semibold break-all bg-muted/50 p-2 rounded text-xs mb-2">
              $ {entry.command}
            </div>
            
            {(entry.stdout || entry.stderr) && (
              <div className="max-h-32 overflow-y-auto rounded bg-black/90 p-2 font-mono text-[10px] leading-relaxed text-zinc-300">
                {entry.stdout && <div className="whitespace-pre-wrap">{entry.stdout}</div>}
                {entry.stderr && <div className="whitespace-pre-wrap text-red-400 mt-1">{entry.stderr}</div>}
              </div>
            )}
          </div>
        ))}
      </div>
    </ScrollArea>
  );
}

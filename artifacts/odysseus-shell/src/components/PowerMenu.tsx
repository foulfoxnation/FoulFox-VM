import { useState } from "react";
import { Power, Moon, RotateCcw, PowerOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useShellToken } from "@/hooks/use-shell-token";
import { apiUrl } from "@/lib/api-url";
import { useToast } from "@/hooks/use-toast";

type Action = "shutdown" | "restart" | "sleep";

const ACTION_META: Record<Action, { label: string; description: string; confirm: string }> = {
  shutdown: {
    label: "Shut Down",
    description: "The system will power off. Make sure all work is saved.",
    confirm: "Shut Down",
  },
  restart: {
    label: "Restart",
    description: "The system will reboot. Make sure all work is saved.",
    confirm: "Restart",
  },
  sleep: {
    label: "Sleep",
    description: "The system will suspend to RAM.",
    confirm: "Sleep",
  },
};

export function PowerMenu() {
  const [pending, setPending] = useState<Action | null>(null);
  const { data: shellToken } = useShellToken();
  const { toast } = useToast();

  async function execute(action: Action) {
    setPending(null);
    try {
      const r = await fetch(apiUrl(`/api/power/${action}`), {
        method: "POST",
        headers: shellToken ? { "X-Shell-Token": shellToken } : {},
      });
      const data = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!r.ok || data.ok === false) {
        toast({
          title: `Could not ${ACTION_META[action].label.toLowerCase()}`,
          description: data.error || `The system refused the request (${r.status}).`,
          variant: "destructive",
          duration: 6000,
        });
        return;
      }
      if (action === "sleep") {
        toast({ title: "Going to sleep…", duration: 3000 });
      } else {
        toast({
          title: action === "shutdown" ? "Shutting down…" : "Restarting…",
          description: "The system is going down now.",
          duration: 5000,
        });
      }
    } catch {
      toast({ title: "Power action failed", variant: "destructive", duration: 3000 });
    }
  }

  const meta = pending ? ACTION_META[pending] : null;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground"
            title="Power"
            data-testid="button-power-menu"
          >
            <Power className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-40">
          <DropdownMenuItem
            onClick={() => setPending("sleep")}
            data-testid="power-sleep"
          >
            <Moon className="mr-2 h-4 w-4" />
            Sleep
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={() => setPending("restart")}
            data-testid="power-restart"
          >
            <RotateCcw className="mr-2 h-4 w-4" />
            Restart
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => setPending("shutdown")}
            className="text-destructive focus:text-destructive"
            data-testid="power-shutdown"
          >
            <PowerOff className="mr-2 h-4 w-4" />
            Shut Down
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={!!pending} onOpenChange={(o) => !o && setPending(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{meta?.label}</AlertDialogTitle>
            <AlertDialogDescription>{meta?.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => pending && execute(pending)}>
              {meta?.confirm}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

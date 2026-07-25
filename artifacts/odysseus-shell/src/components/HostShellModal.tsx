import { useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Terminal as TermIcon, Trash2, Send } from "lucide-react";
import { Terminal, type TerminalHandle } from "./Terminal";
import { ShellHistoryPanel } from "./ShellHistoryPanel";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { useShellToken } from "@/hooks/use-shell-token";
import { useToast } from "@/hooks/use-toast";

interface HostShellModalProps {
  /** Called when the user sends terminal output to the FoulFox OS agent. */
  onSendToOdysseus?: (output: string) => void;
}

export function HostShellModal({ onSendToOdysseus }: HostShellModalProps) {
  const [open, setOpen] = useState(false);
  const terminalRef = useRef<TerminalHandle>(null);
  const { data: shellToken } = useShellToken();
  const { toast } = useToast();

  const handleClear = () => {
    terminalRef.current?.clear();
  };

  const handleSend = () => {
    const output = terminalRef.current?.getLastOutput();
    if (!output?.trim()) {
      toast({ title: "No terminal output to send", variant: "destructive", duration: 2000 });
      return;
    }
    onSendToOdysseus?.(output);
    toast({
      title: "Terminal context sent to FoulFox OS",
      description: "FoulFox OS will analyse the output in the chat panel.",
      duration: 3000,
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 gap-1.5 text-muted-foreground hover:text-foreground"
          title="Open host shell terminal"
          data-testid="button-host-shell"
        >
          <TermIcon className="h-4 w-4" />
          <span className="hidden sm:inline text-xs">Shell</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-5xl h-[80vh] flex flex-col p-0 gap-0">
        <DialogHeader className="px-4 py-2 border-b shrink-0">
          <DialogTitle className="flex items-center gap-2 text-sm font-medium">
            <TermIcon className="h-4 w-4" /> Host Shell
          </DialogTitle>
        </DialogHeader>

        <div className="flex items-center gap-2 border-b bg-muted/30 px-4 py-1.5 shrink-0">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleClear}
            className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
            data-testid="button-clear-terminal"
          >
            <Trash2 className="mr-1 h-3.5 w-3.5" />
            Clear
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleSend}
            disabled={!shellToken}
            className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
            data-testid="button-send-to-odysseus"
          >
            <Send className="mr-1 h-3.5 w-3.5" />
            Send to FoulFox OS
          </Button>
        </div>

        <div className="flex-1 min-h-0">
          <ResizablePanelGroup direction="vertical" className="h-full">
            <ResizablePanel defaultSize={70} minSize={30}>
              <div className="h-full p-4 bg-zinc-950">
                <Terminal ref={terminalRef} />
              </div>
            </ResizablePanel>
            <ResizableHandle withHandle />
            <ResizablePanel defaultSize={30} minSize={15}>
              <div className="flex flex-col h-full bg-card">
                <div className="flex items-center border-b px-4 py-2 font-medium text-sm shrink-0">
                  Command History
                </div>
                <div className="flex-1 overflow-hidden">
                  <ShellHistoryPanel />
                </div>
              </div>
            </ResizablePanel>
          </ResizablePanelGroup>
        </div>
      </DialogContent>
    </Dialog>
  );
}

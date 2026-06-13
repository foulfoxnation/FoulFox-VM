import { useState, useRef } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SettingsModal } from "@/components/SettingsModal";
import { SnapshotModal } from "@/components/SnapshotModal";
import { VmControls } from "@/components/VmControls";
import { Terminal, type TerminalHandle } from "@/components/Terminal";
import { OdysseusTab } from "@/components/OdysseusTab";
import { ShellHistoryPanel } from "@/components/ShellHistoryPanel";
import { useHealthCheck } from "@workspace/api-client-react";
import { useShellToken } from "@/hooks/use-shell-token";
import { apiUrl } from "@/lib/api-url";
import { Terminal as TermIcon, MonitorDot, Command, Trash2, Send, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";

export default function Home() {
  const [activeTab, setActiveTab] = useState("odysseus");
  const [sendingToOdysseus, setSendingToOdysseus] = useState(false);
  const { data: health } = useHealthCheck();
  const { data: shellToken } = useShellToken();
  const terminalRef = useRef<TerminalHandle>(null);
  const { toast } = useToast();

  const handleClearTerminal = () => {
    terminalRef.current?.clear();
  };

  const handleSendToOdysseus = async () => {
    const lastOutput = terminalRef.current?.getLastOutput();
    if (!lastOutput?.trim()) {
      toast({ title: "No terminal output to send", variant: "destructive", duration: 2000 });
      return;
    }

    setSendingToOdysseus(true);
    try {
      // POST the terminal transcript to the Odysseus OpenAI-compatible chat endpoint.
      // The proxy at /api/odysseus/ forwards to the Odysseus Python service.
      const response = await fetch(apiUrl("/api/odysseus/v1/chat/completions"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // Include shell token on any request that may be considered shell-related
          ...(shellToken ? { "X-Shell-Token": shellToken } : {}),
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          messages: [
            {
              role: "system",
              content:
                "You are operating as the user inside a Windows VM. " +
                "The following is recent terminal output from the shell. " +
                "Analyse it, identify any errors or next steps, and respond concisely.",
            },
            {
              role: "user",
              content: `Here is my recent terminal output:\n\n\`\`\`\n${lastOutput.slice(-4000)}\n\`\`\`\n\nWhat do you see and what should I do next?`,
            },
          ],
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      // Switch to Odysseus tab so user can see the response
      setActiveTab("odysseus");
      toast({
        title: "Terminal context sent to Odysseus",
        description: "Odysseus is analysing your terminal output.",
        duration: 3000,
      });
    } catch (err) {
      toast({
        title: "Failed to send to Odysseus",
        description: String(err),
        variant: "destructive",
        duration: 3000,
      });
    } finally {
      setSendingToOdysseus(false);
    }
  };

  return (
    <div className="flex h-screen w-full flex-col bg-background text-foreground overflow-hidden">
      <div className="flex items-center justify-between border-b bg-card px-4 py-2 shadow-sm z-10">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground font-bold">
            Od
          </div>
          <h1 className="font-semibold tracking-tight">Windows Odysseus</h1>
          <div
            className={`h-2 w-2 rounded-full ${health?.status === "ok" ? "bg-green-500" : "bg-red-500"} ml-2`}
            title="API Status"
            data-testid="status-api-health"
          />
        </div>

        <div className="flex items-center gap-2">
          <SnapshotModal />
          <SettingsModal />
        </div>
      </div>

      <VmControls />

      <Tabs value={activeTab} onValueChange={setActiveTab} className="flex flex-1 flex-col overflow-hidden">
        <div className="border-b px-4 bg-muted/20">
          <TabsList className="h-12 w-full justify-start rounded-none border-b-0 bg-transparent p-0">
            <TabsTrigger
              value="odysseus"
              className="relative h-12 rounded-none border-b-2 border-b-transparent bg-transparent px-4 pb-3 pt-2 font-medium text-muted-foreground shadow-none transition-none data-[state=active]:border-b-primary data-[state=active]:text-foreground data-[state=active]:shadow-none"
              data-testid="tab-odysseus"
            >
              <MonitorDot className="mr-2 h-4 w-4" />
              Odysseus Workspace
            </TabsTrigger>
            <TabsTrigger
              value="shell"
              className="relative h-12 rounded-none border-b-2 border-b-transparent bg-transparent px-4 pb-3 pt-2 font-medium text-muted-foreground shadow-none transition-none data-[state=active]:border-b-primary data-[state=active]:text-foreground data-[state=active]:shadow-none"
              data-testid="tab-shell"
            >
              <TermIcon className="mr-2 h-4 w-4" />
              Shell Terminal
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="odysseus" className="flex-1 m-0 p-0 border-0 outline-none h-full data-[state=inactive]:hidden">
          <OdysseusTab />
        </TabsContent>

        <TabsContent value="shell" className="flex-1 m-0 p-0 border-0 outline-none h-full data-[state=inactive]:hidden">
          <div className="flex flex-col h-full">
            {/* Quick-actions toolbar */}
            <div className="flex items-center gap-2 border-b bg-muted/30 px-4 py-1.5" data-testid="shell-quick-actions">
              <Button
                variant="ghost"
                size="sm"
                onClick={handleClearTerminal}
                className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
                data-testid="button-clear-terminal"
              >
                <Trash2 className="mr-1 h-3.5 w-3.5" />
                Clear
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleSendToOdysseus}
                disabled={sendingToOdysseus || !shellToken}
                className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
                data-testid="button-send-to-odysseus"
              >
                {sendingToOdysseus ? (
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Send className="mr-1 h-3.5 w-3.5" />
                )}
                Send to Odysseus
              </Button>
            </div>

            <ResizablePanelGroup direction="vertical" className="flex-1">
              <ResizablePanel defaultSize={70} minSize={30}>
                <div className="h-full p-4 bg-zinc-950">
                  <Terminal ref={terminalRef} />
                </div>
              </ResizablePanel>
              <ResizableHandle withHandle />
              <ResizablePanel defaultSize={30} minSize={20}>
                <div className="flex flex-col h-full bg-card">
                  <div className="flex items-center border-b px-4 py-2 font-medium text-sm">
                    <Command className="mr-2 h-4 w-4" /> Command History
                  </div>
                  <div className="flex-1 overflow-hidden">
                    <ShellHistoryPanel />
                  </div>
                </div>
              </ResizablePanel>
            </ResizablePanelGroup>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}

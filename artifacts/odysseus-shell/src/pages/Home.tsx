import { useEffect, useRef, useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SettingsModal } from "@/components/SettingsModal";
import { SetupWizard } from "@/components/SetupWizard";
import { SnapshotModal } from "@/components/SnapshotModal";
import { Terminal, type TerminalHandle } from "@/components/Terminal";
import { OdysseusTab } from "@/components/OdysseusTab";
import { ShellHistoryPanel } from "@/components/ShellHistoryPanel";
import { FileExplorer } from "@/components/FileExplorer";
import { VmTab } from "@/components/VmTab";
import { OsPicker } from "@/components/OsPicker";
import { DownloadTab } from "@/components/DownloadTab";
import foxLogo from "@assets/FoxQuest_Logo_1781378611335.png";
import { useHealthCheck } from "@workspace/api-client-react";
import { useShellToken } from "@/hooks/use-shell-token";
import { useVmList } from "@/hooks/use-vms";
import { DEFAULT_VM_ID, type OsKind } from "@/lib/vm-api";
import {
  Terminal as TermIcon,
  MonitorDot,
  Command,
  Trash2,
  Send,
  FolderOpen,
  Plus,
  Monitor,
  Apple,
  Disc3,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";

const TAB_TRIGGER =
  "relative h-12 flex items-center rounded-none border-b-2 border-b-transparent bg-transparent px-4 pb-3 pt-2 font-medium text-muted-foreground shadow-none transition-none data-[state=active]:border-b-primary data-[state=active]:text-foreground data-[state=active]:shadow-none";
const TAB_CONTENT =
  "flex-1 m-0 p-0 border-0 outline-none h-full data-[state=inactive]:hidden";

const OS_ICON: Record<OsKind, typeof Monitor> = {
  linux: TermIcon,
  windows: Monitor,
  macos: Apple,
};
const STATE_DOT: Record<string, string> = {
  running: "bg-green-500",
  starting: "bg-amber-500",
  stopping: "bg-amber-500",
  stopped: "bg-zinc-500",
  error: "bg-red-500",
};

export default function Home() {
  const [activeTab, setActiveTab] = useState("odysseus");
  const [pickerOpen, setPickerOpen] = useState(false);
  // Terminal context pending delivery to the Odysseus chat UI via iframe postMessage.
  const [pendingOdysseusContext, setPendingOdysseusContext] = useState<string | null>(null);

  const { data: health } = useHealthCheck();
  const { data: shellToken } = useShellToken();
  const { data: vms = [] } = useVmList();
  const terminalRef = useRef<TerminalHandle>(null);
  const { toast } = useToast();

  // If the active VM tab disappears (e.g. deleted), fall back to the workspace tab.
  useEffect(() => {
    if (activeTab.startsWith("vm:")) {
      const id = activeTab.slice(3);
      if (vms.length > 0 && !vms.some((v) => v.id === id)) setActiveTab("odysseus");
    }
  }, [vms, activeTab]);

  const handleClearTerminal = () => {
    terminalRef.current?.clear();
  };

  const handleSendToOdysseus = () => {
    const lastOutput = terminalRef.current?.getLastOutput();
    if (!lastOutput?.trim()) {
      toast({ title: "No terminal output to send", variant: "destructive", duration: 2000 });
      return;
    }
    setPendingOdysseusContext(lastOutput);
    setActiveTab("odysseus");
    toast({
      title: "Terminal context sent to FoulFox VM",
      description: "FoulFox VM will analyse the output in the chat panel.",
      duration: 3000,
    });
  };

  return (
    <div className="flex h-screen w-full flex-col bg-background text-foreground overflow-hidden">
      <SetupWizard />
      <OsPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        onCreated={(id) => {
          setPickerOpen(false);
          setActiveTab(`vm:${id}`);
        }}
      />
      <div className="flex items-center justify-between gap-4 border-b bg-card px-4 py-2 shadow-sm z-10">
        <div className="flex items-center gap-3 shrink-0">
          <img src={foxLogo} alt="FoulFox VM" className="h-8 w-8 rounded-md object-cover" />
          <h1 className="font-semibold tracking-tight">FoulFox VM</h1>
          <div
            className={`h-2 w-2 rounded-full ${health?.status === "ok" ? "bg-green-500" : "bg-red-500"}`}
            title="API Status"
            data-testid="status-api-health"
          />
        </div>

        <div className="flex items-center gap-3 shrink-0">
          <SnapshotModal />
          <SettingsModal />
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="flex flex-1 flex-col overflow-hidden">
        <div className="border-b px-4 bg-muted/20">
          <TabsList className="h-12 w-full justify-start rounded-none border-b-0 bg-transparent p-0">
            <TabsTrigger value="odysseus" className={TAB_TRIGGER} data-testid="tab-odysseus">
              <MonitorDot className="mr-2 h-4 w-4" />
              FoulFox VM Workspace
            </TabsTrigger>
            <TabsTrigger value="shell" className={TAB_TRIGGER} data-testid="tab-shell">
              <TermIcon className="mr-2 h-4 w-4" />
              Host Shell
            </TabsTrigger>
            <TabsTrigger
              value="files"
              className={TAB_TRIGGER}
              data-testid="tab-files"
            >
              <FolderOpen className="mr-2 h-4 w-4" />
              File Explorer
            </TabsTrigger>
            <TabsTrigger
              value="download"
              className={TAB_TRIGGER}
              data-testid="tab-download"
            >
              <Disc3 className="mr-2 h-4 w-4" />
              Get FoulFox OS
            </TabsTrigger>

            {vms.map((vm) => {
              const Icon = OS_ICON[vm.osKind] ?? Monitor;
              return (
                <TabsTrigger key={vm.id} value={`vm:${vm.id}`} className={TAB_TRIGGER} data-testid={`tab-vm-${vm.id}`}>
                  <Icon className="mr-2 h-4 w-4" />
                  <span className="max-w-[140px] truncate">{vm.name}</span>
                  <span
                    className={`ml-2 h-2 w-2 rounded-full ${STATE_DOT[vm.state] ?? "bg-zinc-500"}`}
                    title={vm.state}
                  />
                </TabsTrigger>
              );
            })}

            <Button
              variant="ghost"
              size="sm"
              className="ml-1 h-8 self-center px-2 text-muted-foreground hover:text-foreground"
              onClick={() => setPickerOpen(true)}
              title="New VM"
              data-testid="button-add-vm"
            >
              <Plus className="h-4 w-4" />
            </Button>
          </TabsList>
        </div>

        <TabsContent value="odysseus" className={TAB_CONTENT}>
          <OdysseusTab
            pendingContext={pendingOdysseusContext}
            onContextConsumed={() => setPendingOdysseusContext(null)}
            shellToken={shellToken}
          />
        </TabsContent>

        <TabsContent value="shell" className={TAB_CONTENT}>
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
                disabled={!shellToken}
                className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
                data-testid="button-send-to-odysseus"
              >
                <Send className="mr-1 h-3.5 w-3.5" />
                Send to FoulFox VM
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

        <TabsContent value="files" className={TAB_CONTENT}>
          <FileExplorer />
        </TabsContent>
        <TabsContent value="download" className={TAB_CONTENT}>
          <DownloadTab />
        </TabsContent>
        {vms.map((vm) => (
          <TabsContent key={vm.id} value={`vm:${vm.id}`} className={TAB_CONTENT}>
            <VmTab vm={vm} isDefault={vm.id === DEFAULT_VM_ID} onDeleted={() => setActiveTab("odysseus")} />
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}

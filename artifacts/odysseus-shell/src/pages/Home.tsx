import { useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SettingsModal } from "@/components/SettingsModal";
import { SnapshotModal } from "@/components/SnapshotModal";
import { VmControls } from "@/components/VmControls";
import { Terminal } from "@/components/Terminal";
import { OdysseusTab } from "@/components/OdysseusTab";
import { ShellHistoryPanel } from "@/components/ShellHistoryPanel";
import { useHealthCheck } from "@workspace/api-client-react";
import { Terminal as TermIcon, MonitorDot, Command } from "lucide-react";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";

export default function Home() {
  const [activeTab, setActiveTab] = useState("odysseus");
  const { data: health } = useHealthCheck();

  return (
    <div className="flex h-screen w-full flex-col bg-background text-foreground overflow-hidden">
      <div className="flex items-center justify-between border-b bg-card px-4 py-2 shadow-sm z-10">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground font-bold">
            Od
          </div>
          <h1 className="font-semibold tracking-tight">Windows Odysseus</h1>
          <div className={`h-2 w-2 rounded-full ${health?.status === 'ok' ? 'bg-green-500' : 'bg-red-500'} ml-2`} title="API Status" />
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
          <ResizablePanelGroup direction="vertical" className="h-full">
            <ResizablePanel defaultSize={70} minSize={30}>
              <div className="h-full p-4 bg-zinc-950">
                <Terminal />
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
        </TabsContent>
      </Tabs>
    </div>
  );
}

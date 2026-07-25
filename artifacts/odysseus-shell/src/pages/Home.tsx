import { useEffect, useRef, useState, type ReactNode } from "react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SettingsModal } from "@/components/SettingsModal";
import { DiskInstallPanel } from "@/components/DiskInstallPanel";
import { PowerMenu } from "@/components/PowerMenu";
import { SetupWizard } from "@/components/SetupWizard";
import { ConnectLlamaModal } from "@/components/ConnectLlamaModal";
import { SnapshotModal } from "@/components/SnapshotModal";
import { AgentChatPane, type ChatTarget, type ChatPaneHandle } from "@/components/AgentChatPane";
import { VmTab } from "@/components/VmTab";
import { OsPicker } from "@/components/OsPicker";
import { GetFoulFoxOsModal } from "@/components/GetFoulFoxOsModal";
import { HostShellModal } from "@/components/HostShellModal";
import { FileExplorerModal } from "@/components/FileExplorerModal";
import { BrowserTab } from "@/components/BrowserTab";
import { DevicesTab } from "@/components/DevicesTab";
import { AppsTab } from "@/components/AppsTab";
import foxLogo from "@assets/FoxQuest_Logo_1781378611335.png";
import { useHealthCheck } from "@workspace/api-client-react";
import { useShellToken } from "@/hooks/use-shell-token";
import { authedFetch, refreshShellToken } from "@/lib/shell-token";
import { useVmList } from "@/hooks/use-vms";
import { DEFAULT_VM_ID, type OsKind } from "@/lib/vm-api";
import {
  Terminal as TermIcon,
  MonitorDot,
  Plus,
  Monitor,
  Apple,
  Globe,
  Plug,
  Boxes,
  Wifi,
  PanelLeft,
  RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";

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
  // Terminal context pending delivery to the agent chat (host shell -> chat).
  const [pendingOdysseusContext, setPendingOdysseusContext] = useState<string | null>(null);
  // Width (% of the content row) of the side-by-side agent chat panel.
  const [chatWidthPct, setChatWidthPct] = useState(38);
  const contentRef = useRef<HTMLDivElement>(null);

  const [restartingServices, setRestartingServices] = useState(false);

  const { data: health } = useHealthCheck();
  const { data: shellToken } = useShellToken();
  const { data: vms = [] } = useVmList();
  const chatPaneRef = useRef<ChatPaneHandle>(null);
  const { toast } = useToast();

  const handleRestartServices = async () => {
    setRestartingServices(true);
    try {
      const res = await authedFetch("/api/os/restart-services", { method: "POST" });
      const data = await res.json() as { ok: boolean; results?: Record<string, { ok: boolean }> };
      if (data.ok) {
        toast({
          title: "Services restarting",
          description: "FoulFox OS services are restarting — the AI agent should come online in a few seconds.",
          duration: 5000,
        });
        // The restarted api-server mints a NEW session token; grab it as soon
        // as the server is back so the next action doesn't hit a stale-token 401.
        setTimeout(() => void refreshShellToken(), 4000);
        setTimeout(() => void refreshShellToken(), 10000);
      } else {
        toast({
          title: "Restart may not have taken effect",
          description: "This only works on the physical machine. The AI agent is managed by the dev workflow here.",
          duration: 4000,
        });
      }
    } catch {
      toast({ title: "Could not reach the API server", variant: "destructive", duration: 3000 });
    } finally {
      setRestartingServices(false);
    }
  };

  // If the active VM tab disappears (e.g. deleted), fall back to the workspace tab.
  useEffect(() => {
    if (activeTab.startsWith("vm:")) {
      const id = activeTab.slice(3);
      if (vms.length > 0 && !vms.some((v) => v.id === id)) setActiveTab("odysseus");
    }
  }, [vms, activeTab]);

  // ── Workspace layout ──────────────────────────────────────────────────────
  // The agent chat is a single persistent iframe (it never unmounts, so the
  // conversation + the VM VNC/terminals all stay alive across tab switches).
  // - Workspace tab      -> chat fills the area.
  // - Host Shell + VM    -> chat on the LEFT, the tab body on the right.
  // - File Explorer + Get FoulFox OS -> no chat (hidden, still mounted).
  const isVm = activeTab.startsWith("vm:");
  const activeVmId = isVm ? activeTab.slice(3) : null;
  const activeVm = activeVmId ? vms.find((v) => v.id === activeVmId) ?? null : null;
  const chatVisible = activeTab === "odysseus" || isVm;
  const chatFull = activeTab === "odysseus";
  const split = chatVisible && !chatFull;
  const rightVisible = activeTab !== "odysseus";
  const chatTarget: ChatTarget =
    isVm && activeVm
      ? { kind: "vm", vmId: activeVm.id, label: activeVm.name }
      : { kind: "host", label: "Host system" };

  const startChatResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const el = contentRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const onMove = (ev: PointerEvent) => {
      const pct = ((ev.clientX - rect.left) / rect.width) * 100;
      setChatWidthPct(Math.min(60, Math.max(22, pct)));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.userSelect = "";
    };
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
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
          <img src={foxLogo} alt="FoulFox OS" className="h-8 w-8 rounded-md object-cover" />
          <div className="flex flex-col leading-tight">
            <h1 className="font-semibold tracking-tight">FoulFox OS</h1>
            <span className="text-[11px] font-medium text-muted-foreground">
              Powered by Odysseus
            </span>
          </div>
          <div
            className={`h-2 w-2 rounded-full ${health?.status === "ok" ? "bg-green-500" : "bg-red-500"}`}
            title="API Status"
            data-testid="status-api-health"
          />
        </div>

        <div className="flex items-center gap-3 shrink-0">
          <Button
            variant="ghost"
            size="sm"
            className="h-8 gap-1.5 text-muted-foreground hover:text-foreground"
            onClick={() => setActiveTab("devices")}
            title="Network / WiFi setup"
            data-testid="button-wifi-quick"
          >
            <Wifi className="h-4 w-4" />
            <span className="hidden sm:inline text-xs">WiFi</span>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 gap-1.5 text-muted-foreground hover:text-foreground"
            onClick={handleRestartServices}
            disabled={restartingServices}
            title="Restart FoulFox OS services (use after connecting WiFi)"
            data-testid="button-restart-services"
          >
            <RefreshCw className={`h-4 w-4 ${restartingServices ? "animate-spin" : ""}`} />
            <span className="hidden sm:inline text-xs">Retry Setup</span>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 gap-1.5 text-muted-foreground hover:text-foreground"
            onClick={() => chatPaneRef.current?.showSidebar()}
            title="Restore Odysseus sidebar"
            data-testid="button-restore-sidebar"
          >
            <PanelLeft className="h-4 w-4" />
            <span className="hidden sm:inline text-xs">Sidebar</span>
          </Button>
          <HostShellModal onSendToOdysseus={(output) => setPendingOdysseusContext(output)} />
          <FileExplorerModal />
          <GetFoulFoxOsModal />
          <ConnectLlamaModal />
          <SnapshotModal />
          <DiskInstallPanel />
          <PowerMenu />
          <SettingsModal />
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="flex flex-1 flex-col overflow-hidden">
        <div className="border-b px-4 bg-muted/20">
          <TabsList className="h-12 w-full justify-start rounded-none border-b-0 bg-transparent p-0">
            <TabsTrigger value="odysseus" className={TAB_TRIGGER} data-testid="tab-odysseus">
              <MonitorDot className="mr-2 h-4 w-4" />
              FoulFox OS Workspace
            </TabsTrigger>
            <TabsTrigger
              value="browser"
              className={TAB_TRIGGER}
              data-testid="tab-browser"
            >
              <Globe className="mr-2 h-4 w-4" />
              Browser
            </TabsTrigger>
            <TabsTrigger
              value="devices"
              className={TAB_TRIGGER}
              data-testid="tab-devices"
            >
              <Plug className="mr-2 h-4 w-4" />
              Devices
            </TabsTrigger>
            <TabsTrigger
              value="apps"
              className={TAB_TRIGGER}
              data-testid="tab-apps"
            >
              <Boxes className="mr-2 h-4 w-4" />
              Apps
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

        {/* Content area: persistent agent chat (left) + per-tab body (right). */}
        <div ref={contentRef} className="flex flex-1 overflow-hidden">
          {/* The agent chat is a single iframe that never unmounts, so the
              conversation (and any VM VNC/terminal it drives) survives tab
              switches. It fills the area on the Workspace tab, sits on the left
              beside the Host Shell / VM tabs, and is hidden (but kept mounted)
              on File Explorer + Get FoulFox OS. */}
          <div
            className={chatVisible ? "h-full min-w-0" : "hidden"}
            style={
              chatFull
                ? { flex: "1 1 0%" }
                : { width: `${chatWidthPct}%`, flexShrink: 0 }
            }
          >
            <AgentChatPane
              ref={chatPaneRef}
              pendingContext={pendingOdysseusContext}
              onContextConsumed={() => setPendingOdysseusContext(null)}
              shellToken={shellToken}
              target={chatTarget}
              showTargetBadge={split}
            />
          </div>

          {/* Drag divider — only when the chat sits beside a tab body. */}
          {split && (
            <div
              role="separator"
              aria-orientation="vertical"
              onPointerDown={startChatResize}
              className="w-1.5 shrink-0 cursor-col-resize bg-border transition-colors hover:bg-primary/50"
              data-testid="chat-resize-handle"
            />
          )}

          {/* Right region — every non-chat body stays mounted; shown by tab so
              terminal scrollback and VNC sessions are never torn down. */}
          <div className={rightVisible ? "h-full min-w-0 flex-1" : "hidden"}>
            <Body show={activeTab === "browser"}>
              <BrowserTab />
            </Body>
            <Body show={activeTab === "devices"}>
              <DevicesTab />
            </Body>
            <Body show={activeTab === "apps"}>
              <AppsTab />
            </Body>
            {vms.map((vm) => (
              <Body key={vm.id} show={activeTab === `vm:${vm.id}`}>
                <VmTab vm={vm} isDefault={vm.id === DEFAULT_VM_ID} onDeleted={() => setActiveTab("odysseus")} />
              </Body>
            ))}
          </div>
        </div>
      </Tabs>
    </div>
  );
}

/**
 * A tab body that stays mounted but is hidden with `display:none` when its tab
 * is inactive. Keeping every body mounted preserves expensive state — terminal
 * scrollback, VM VNC sessions — across tab switches.
 */
function Body({ show, children }: { show: boolean; children: ReactNode }) {
  return <div className={show ? "h-full w-full" : "hidden"}>{children}</div>;
}

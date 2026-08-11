import { useEffect, useRef, useState, type ReactNode } from "react";
import { SettingsModal } from "@/components/SettingsModal";
import { DiskSetupModal } from "@/components/DiskSetupModal";
import { PowerMenu } from "@/components/PowerMenu";
import { SetupWizard } from "@/components/SetupWizard";
import { ConnectLlamaModal } from "@/components/ConnectLlamaModal";
import { SnapshotModal } from "@/components/SnapshotModal";
import { AgentChatPane, type ChatTarget, type ChatPaneHandle } from "@/components/AgentChatPane";
import { VmTab } from "@/components/VmTab";
import { OsPicker } from "@/components/OsPicker";
import { GetFoulFoxOsModal } from "@/components/GetFoulFoxOsModal";
import { OdysseusUpdateButton } from "@/components/OdysseusUpdateButton";
import { HostShellModal } from "@/components/HostShellModal";
import { FileExplorerModal } from "@/components/FileExplorerModal";
import { BrowserTab } from "@/components/BrowserTab";
import { WindowTray } from "@/components/WindowTray";
import { DevicesTab } from "@/components/DevicesTab";
import { AppsTab } from "@/components/AppsTab";
import { AgentTasksPanel } from "@/components/AgentTasksPanel";
import { VoiceForgeWidget } from "@/components/VoiceForgeWidget";
import { DiagnosticPanel } from "@/components/DiagnosticPanel";
import { Terminal } from "@/components/Terminal";
import foxLogo from "@assets/FoxQuest_Logo_1781378611335.png";
import { useHealthCheck } from "@workspace/api-client-react";
import { useShellToken } from "@/hooks/use-shell-token";
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
  Sparkles,
  Activity,
  ShieldCheck,
  SquareTerminal,
} from "lucide-react";
import { Button } from "@/components/ui/button";

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
  const [pendingOdysseusContext, setPendingOdysseusContext] = useState<string | null>(null);
  const [focusAppId, setFocusAppId] = useState<string | null>(null);
  const openDefaultApp = (id: string) => {
    setFocusAppId(id);
    setActiveTab("apps");
  };
  const [chatWidthPct, setChatWidthPct] = useState(38);
  const contentRef = useRef<HTMLDivElement>(null);

  const { data: health } = useHealthCheck();
  const { data: shellToken } = useShellToken();
  const { data: vms = [] } = useVmList();
  const chatPaneRef = useRef<ChatPaneHandle>(null);

  useEffect(() => {
    if (activeTab.startsWith("vm:")) {
      const id = activeTab.slice(3);
      if (vms.length > 0 && !vms.some((v) => v.id === id)) setActiveTab("odysseus");
    }
  }, [vms, activeTab]);

  const isVm = activeTab.startsWith("vm:");
  const activeVmId = isVm ? activeTab.slice(3) : null;
  const activeVm = activeVmId ? vms.find((v) => v.id === activeVmId) ?? null : null;
  const chatVisible = activeTab === "odysseus" || isVm;
  const chatFull = activeTab === "odysseus";
  const split = chatVisible && !chatFull;
  const rightVisible = activeTab !== "odysseus";
  const chatTarget: ChatTarget =
    isVm && activeVm
      ? { kind: "vm", vmId: activeVm.id, label: activeVm.name, osKind: activeVm.osKind, projectPath: activeVm.projectPath }
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

      {/* ── Top header ──────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-4 border-b bg-card px-4 py-2 shadow-sm z-10 shrink-0">
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

        <div className="flex items-center gap-3 shrink-0 flex-wrap">
          <VoiceForgeWidget
            onAgentResponse={() => chatPaneRef.current?.refresh()}
          />
          <Button
            variant="ghost"
            size="sm"
            className="h-8 gap-1.5 text-muted-foreground hover:text-foreground"
            onClick={() => openDefaultApp("llama-llama-studio")}
            title="Llama Llama Studio — local AI research studio"
            data-testid="button-app-llama-studio"
          >
            <Sparkles className="h-4 w-4" />
            <span className="hidden sm:inline text-xs">Llama Studio</span>
          </Button>
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
          <OdysseusUpdateButton />
          <ConnectLlamaModal />
          <SnapshotModal />
          <DiskSetupModal />
          <PowerMenu />
          <SettingsModal />
        </div>
      </div>

      {/* ── Content area ────────────────────────────────────────────────── */}
      <div ref={contentRef} className="flex flex-1 overflow-hidden min-h-0">
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

        {split && (
          <div
            role="separator"
            aria-orientation="vertical"
            onPointerDown={startChatResize}
            className="w-1.5 shrink-0 cursor-col-resize bg-border transition-colors hover:bg-primary/50"
            data-testid="chat-resize-handle"
          />
        )}

        <div className={rightVisible ? "h-full min-w-0 flex-1" : "hidden"}>
          <Body show={activeTab === "browser"}>
            <BrowserTab />
          </Body>
          <Body show={activeTab === "devices"}>
            <DevicesTab />
          </Body>
          <Body show={activeTab === "apps"}>
            <AppsTab focusAppId={activeTab === "apps" ? focusAppId : null} />
          </Body>
          <Body show={activeTab === "agents"}>
            <AgentTasksPanel />
          </Body>
          <Body show={activeTab === "diagnostics"}>
            <div className="h-full overflow-y-auto">
              <DiagnosticPanel />
            </div>
          </Body>
          <Body show={activeTab === "console"}>
            <div className="h-full flex flex-col bg-zinc-950">
              <Terminal />
            </div>
          </Body>
          {vms.map((vm) => (
            <Body key={vm.id} show={activeTab === `vm:${vm.id}`}>
              <VmTab
                vm={vm}
                isDefault={vm.id === DEFAULT_VM_ID}
                onDeleted={() => setActiveTab("odysseus")}
                onMinimize={() => setActiveTab("odysseus")}
              />
            </Body>
          ))}
        </div>
      </div>

      {/* ── Windows-style bottom taskbar ────────────────────────────────── */}
      <div
        className="shrink-0 flex items-center gap-1 border-t bg-card px-2 overflow-x-auto"
        style={{ height: "48px" }}
        data-testid="taskbar"
      >
        {/* Fixed sections */}
        <TaskbarButton
          id="odysseus"
          active={activeTab === "odysseus"}
          icon={<MonitorDot className="h-4 w-4" />}
          label="Workspace"
          onClick={() => setActiveTab("odysseus")}
          testId="tab-odysseus"
        />
        <TaskbarButton
          id="browser"
          active={activeTab === "browser"}
          icon={<Globe className="h-4 w-4" />}
          label="Browser"
          onClick={() => setActiveTab("browser")}
          testId="tab-browser"
        />
        <TaskbarButton
          id="devices"
          active={activeTab === "devices"}
          icon={<Plug className="h-4 w-4" />}
          label="Devices"
          onClick={() => setActiveTab("devices")}
          testId="tab-devices"
        />
        <TaskbarButton
          id="apps"
          active={activeTab === "apps"}
          icon={<Boxes className="h-4 w-4" />}
          label="Apps"
          onClick={() => setActiveTab("apps")}
          testId="tab-apps"
        />
        <TaskbarButton
          id="agents"
          active={activeTab === "agents"}
          icon={<Activity className="h-4 w-4" />}
          label="Agents"
          onClick={() => setActiveTab("agents")}
          testId="tab-agents"
        />
        <TaskbarButton
          id="diagnostics"
          active={activeTab === "diagnostics"}
          icon={<ShieldCheck className="h-4 w-4" />}
          label="Diagnostics"
          onClick={() => setActiveTab("diagnostics")}
          testId="tab-diagnostics"
        />
        <TaskbarButton
          id="console"
          active={activeTab === "console"}
          icon={<SquareTerminal className="h-4 w-4" />}
          label="Console"
          onClick={() => setActiveTab("console")}
          testId="tab-console"
        />

        {/* VM buttons — one per running/stopped VM */}
        {vms.map((vm) => {
          const Icon = OS_ICON[vm.osKind] ?? Monitor;
          return (
            <TaskbarButton
              key={vm.id}
              id={`vm:${vm.id}`}
              active={activeTab === `vm:${vm.id}`}
              icon={
                <span className="relative">
                  <Icon className="h-4 w-4" />
                  <span
                    className={`absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full border border-card ${STATE_DOT[vm.state] ?? "bg-zinc-500"}`}
                    title={vm.state}
                  />
                </span>
              }
              label={vm.name}
              onClick={() => setActiveTab(`vm:${vm.id}`)}
              testId={`tab-vm-${vm.id}`}
            />
          );
        })}

        {/* New VM */}
        <button
          className="flex items-center gap-1.5 px-2 py-1 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors h-8 shrink-0"
          onClick={() => setPickerOpen(true)}
          title="Create another VM (Windows, Linux, …)"
          data-testid="button-add-vm"
        >
          <Plus className="h-4 w-4" />
          <span className="hidden sm:inline">New VM</span>
        </button>

        {/* Spacer pushes X windows to the right */}
        <div className="flex-1" />

        {/* Open X windows on the appliance (Discord, Firefox, …) */}
        <WindowTray />
      </div>
    </div>
  );
}

interface TaskbarButtonProps {
  id: string;
  active: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
  testId?: string;
}

function TaskbarButton({ active, icon, label, onClick, testId }: TaskbarButtonProps) {
  return (
    <button
      className={[
        "relative flex items-center gap-2 px-3 rounded text-sm transition-colors h-9 shrink-0 max-w-[180px]",
        active
          ? "bg-muted text-foreground font-medium"
          : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
      ].join(" ")}
      onClick={onClick}
      data-testid={testId}
    >
      {icon}
      <span className="truncate">{label}</span>
      {/* Active indicator line at the top of the button, like Windows */}
      {active && (
        <span className="absolute inset-x-2 top-0 h-0.5 rounded-full bg-primary" />
      )}
    </button>
  );
}

function Body({ show, children }: { show: boolean; children: ReactNode }) {
  return <div className={show ? "h-full w-full" : "hidden"}>{children}</div>;
}

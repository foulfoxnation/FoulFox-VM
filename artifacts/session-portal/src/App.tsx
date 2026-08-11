import { type ReactNode, useEffect, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { Route, Switch, useLocation, Router as WouterRouter } from 'wouter';

import { useGetSessionInfo, useCreateViewToken, setDefaultHeaders } from '@workspace/api-client-react';
import { VncViewer } from '@/components/VncViewer';
import { TerminalPane } from '@/components/TerminalPane';
import { LogStream } from '@/components/LogStream';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Copy, Terminal as TerminalIcon, ScrollText, Share, MonitorPlay, Check, Loader2 } from 'lucide-react';
import { apiUrl } from '@/lib/api-url';

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: false } }
});

function formatUptime(seconds: number) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${h}h ${m}m ${s}s`;
}

function Portal() {
  const [searchParams] = useState(() => new URLSearchParams(window.location.search));
  const viewTokenParam = searchParams.get('token');

  const [shellToken, setShellToken] = useState<string | null>(null);
  const [activeVmId, setActiveVmId] = useState<string | null>(null);

  // Fetch the shell session token first; inject it as a default header for
  // all api-client requests (enables createViewToken mutation, etc.).
  useEffect(() => {
    fetch(apiUrl('/api/shell/session-token'))
      .then(res => res.json())
      .then(data => {
        if (data.token) {
          setShellToken(data.token);
          setDefaultHeaders({ 'X-Shell-Token': data.token });
        }
      })
      .catch(console.error);
  }, []);

  // Session info: prefer view token from URL, fall back to shell token.
  // Wait until we have at least one token before issuing the request.
  const sessionToken = viewTokenParam || shellToken;
  const { data: sessionInfo, isLoading } = useGetSessionInfo(
    { token: sessionToken ?? undefined },
    {
      query: {
        enabled: !!sessionToken,
        refetchInterval: 5000,
        queryKey: ['sessionInfo', sessionToken],
      },
    }
  );

  // Set default active VM when info arrives
  useEffect(() => {
    if (sessionInfo?.vms && sessionInfo.vms.length > 0 && !activeVmId) {
      setActiveVmId(sessionInfo.vms[0].id);
    }
  }, [sessionInfo, activeVmId]);

  const createToken = useCreateViewToken();
  const [copied, setCopied] = useState(false);

  const handleShare = () => {
    createToken.mutate(undefined, {
      onSuccess: (data) => {
        if (data.sessionUrl) {
          navigator.clipboard.writeText(data.sessionUrl);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        }
      }
    });
  };

  if (isLoading && !sessionInfo) {
    return (
      <div className="min-h-screen w-full flex items-center justify-center bg-zinc-950 text-zinc-400">
        <Loader2 className="w-8 h-8 animate-spin" />
      </div>
    );
  }

  const activeVm = sessionInfo?.vms.find(vm => vm.id === activeVmId);
  const displayToken = viewTokenParam || activeVm?.displayToken || null;
  const sseToken = viewTokenParam || shellToken;

  return (
    <div className="flex flex-col h-screen w-full bg-[#09090b] text-zinc-200 overflow-hidden font-sans">
      {/* Header */}
      <header className="flex-none h-14 border-b border-zinc-800 bg-[#09090b] flex items-center justify-between px-4">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <div className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse shadow-[0_0_10px_rgba(16,185,129,0.5)]" />
            <h1 className="text-sm font-bold tracking-wider uppercase text-zinc-100">{sessionInfo?.machineName || "FoulFox Session"}</h1>
          </div>
          
          <div className="flex items-center gap-2 text-xs font-mono">
            <span className="px-2 py-0.5 rounded bg-zinc-800 text-zinc-300 border border-zinc-700">
              {sessionInfo?.platform} {sessionInfo?.arch}
            </span>
            <span className="text-zinc-500">
              UPTIME: <span className="text-zinc-300">{formatUptime(sessionInfo?.uptimeSeconds || 0)}</span>
            </span>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <Button 
            variant="outline" 
            size="sm" 
            className="h-8 border-zinc-700 bg-zinc-800 hover:bg-zinc-700 hover:text-white"
            onClick={handleShare}
            disabled={createToken.isPending}
          >
            {createToken.isPending ? (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            ) : copied ? (
              <Check className="w-4 h-4 mr-2 text-emerald-400" />
            ) : (
              <Share className="w-4 h-4 mr-2" />
            )}
            {copied ? "Copied Link" : "Share Session"}
          </Button>
        </div>
      </header>

      {/* Body */}
      <main className="flex-1 overflow-hidden">
        <PanelGroup direction="horizontal">
          
          {/* Left Panel - VNC */}
          <Panel defaultSize={65} minSize={30}>
            <div className="flex flex-col h-full bg-zinc-950 border-r border-zinc-800">
              {/* VM Tabs */}
              <div className="flex-none flex px-2 pt-2 gap-1 bg-[#09090b] border-b border-zinc-800">
                {sessionInfo?.vms.map(vm => (
                  <button
                    key={vm.id}
                    onClick={() => setActiveVmId(vm.id)}
                    className={`px-4 py-2 text-xs font-medium rounded-t border-t border-x transition-colors flex items-center gap-2 outline-none
                      ${activeVmId === vm.id 
                        ? 'bg-black border-zinc-800 text-zinc-100 z-10 translate-y-[1px]' 
                        : 'bg-[#09090b] border-transparent text-zinc-500 hover:text-zinc-300'}`}
                  >
                    <MonitorPlay className="w-3.5 h-3.5" />
                    {vm.name}
                    <span className={`w-1.5 h-1.5 rounded-full ml-1 ${vm.state === 'running' ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]' : 'bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.5)]'}`} />
                  </button>
                ))}
                {(!sessionInfo?.vms || sessionInfo.vms.length === 0) && (
                  <div className="px-4 py-2 text-xs font-medium text-zinc-500">No VMs discovered</div>
                )}
              </div>
              
              <div className="flex-1 min-h-0 bg-black">
                {activeVm ? (
                  activeVm.state !== 'running' ? (
                    <div className="flex h-full w-full items-center justify-center flex-col gap-2">
                      <div className="text-zinc-600 text-lg">{activeVm.name} is Stopped</div>
                    </div>
                  ) : (
                    <VncViewer vmId={activeVm.id} displayToken={displayToken} />
                  )
                ) : (
                  <div className="flex h-full w-full items-center justify-center">
                    <div className="text-zinc-600 text-sm">Select a VM</div>
                  </div>
                )}
              </div>
            </div>
          </Panel>

          {/* Resize Handle */}
          <PanelResizeHandle className="w-1 bg-zinc-900 hover:bg-zinc-700 active:bg-zinc-600 transition-colors cursor-col-resize z-20 flex items-center justify-center border-x border-zinc-800/50">
            <div className="w-0.5 h-8 bg-zinc-700 rounded-full" />
          </PanelResizeHandle>

          {/* Right Panel - Terminal/Logs */}
          <Panel defaultSize={35} minSize={20}>
            <div className="flex flex-col h-full bg-[#09090b]">
              <Tabs defaultValue="terminal" className="flex-1 flex flex-col h-full">
                <TabsList className="flex-none justify-start h-[41px] px-2 bg-[#09090b] border-b border-zinc-800 rounded-none w-full gap-1 pt-2">
                  <TabsTrigger value="terminal" className="text-xs data-[state=active]:bg-zinc-800 data-[state=active]:text-zinc-100 rounded-t-md rounded-b-none border-t border-x border-transparent data-[state=active]:border-zinc-800 h-full data-[state=active]:shadow-none">
                    <TerminalIcon className="w-3.5 h-3.5 mr-2" />
                    Terminal
                  </TabsTrigger>
                  <TabsTrigger value="logs" className="text-xs data-[state=active]:bg-zinc-800 data-[state=active]:text-zinc-100 rounded-t-md rounded-b-none border-t border-x border-transparent data-[state=active]:border-zinc-800 h-full data-[state=active]:shadow-none">
                    <ScrollText className="w-3.5 h-3.5 mr-2" />
                    Logs
                  </TabsTrigger>
                </TabsList>
                <TabsContent value="terminal" className="flex-1 min-h-0 m-0 mt-0 data-[state=active]:flex border-none outline-none bg-zinc-950">
                  <TerminalPane shellToken={shellToken} />
                </TabsContent>
                <TabsContent value="logs" className="flex-1 min-h-0 m-0 mt-0 data-[state=active]:flex border-none outline-none bg-zinc-950">
                  <LogStream shellToken={sseToken} />
                </TabsContent>
              </Tabs>
            </div>
          </Panel>

        </PanelGroup>
      </main>
    </div>
  );
}

function Router() {
  return (
    <RoutedErrorBoundary>
      <Switch>
        <Route path="/" component={Portal} />
        <Route component={NotFound} />
      </Switch>
    </RoutedErrorBoundary>
  );
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
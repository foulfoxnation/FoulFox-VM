import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useApps,
  useInstallApp,
  useInstallZip,
  useInstallFromPath,
  useDrives,
  useDirectory,
  useInstallJob,
  useUninstallApp,
  useStartApp,
  useStopApp,
  APPS_KEY,
} from "@/hooks/use-apps";
import {
  ALL_CAPABILITIES,
  fetchAppLogs,
  fetchRunLog,
  appUiUrl,
  fetchAppUiBase,
  appIconUrl,
  type AppCapability,
  type InstalledApp,
  type InstallPhase,
  type RunPhase,
} from "@/lib/apps-api";
import { useShellToken } from "@/hooks/use-shell-token";
import { externalLinkClick } from "@/lib/open-external";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Boxes,
  Github,
  Loader2,
  Trash2,
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  FileText,
  Upload,
  Usb,
  Folder,
  FileArchive,
  ArrowLeft,
  RefreshCw,
  Play,
  Square,
  Monitor,
  ChevronDown,
  ChevronUp,
} from "lucide-react";

const PHASE_LABEL: Record<InstallPhase, string> = {
  cloning: "Cloning repository…",
  extracting: "Extracting zip…",
  parsing: "Reading foxapp.json…",
  installing: "Running install…",
  building: "Building…",
  done: "Installed",
  error: "Failed",
};

const CAP_LABEL: Record<AppCapability, string> = {
  "agent.task": "Agent tasks",
  "vm.computer_use": "Computer use (VM)",
};

export function AppsTab() {
  const { data: token } = useShellToken();
  const { data: apps = [], isLoading } = useApps();
  const install = useInstallApp();
  const qc = useQueryClient();

  const installZip = useInstallZip();
  const installFromPath = useInstallFromPath();

  const [repoUrl, setRepoUrl] = useState("");
  const [jobId, setJobId] = useState<string | null>(null);
  const { data: job } = useInstallJob(jobId);
  const logRef = useRef<HTMLPreElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Flash-drive picker state: null = closed; otherwise the directory shown.
  const [drivePath, setDrivePath] = useState<string | null>(null);
  const [driveOpen, setDriveOpen] = useState(false);
  const { data: drives = [], isLoading: drivesLoading, refetch: refetchDrives } =
    useDrives(driveOpen);
  const { data: dirListing, isLoading: dirLoading } = useDirectory(drivePath);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [job?.log]);

  useEffect(() => {
    if (job?.phase === "done" || job?.phase === "error") {
      qc.invalidateQueries({ queryKey: APPS_KEY });
    }
  }, [job?.phase, qc]);

  const installing = !!job && job.phase !== "done" && job.phase !== "error";
  const busy =
    install.isPending || installZip.isPending || installFromPath.isPending || installing;
  const startError =
    (install.error as Error | null) ??
    (installZip.error as Error | null) ??
    (installFromPath.error as Error | null);

  const onInstall = () => {
    const url = repoUrl.trim();
    if (!url || busy) return;
    install.mutate(
      { repoUrl: url, capabilities: ALL_CAPABILITIES },
      { onSuccess: (r) => setJobId(r.jobId) },
    );
  };

  const onZipPicked = (file: File | null) => {
    if (!file || busy) return;
    installZip.mutate(
      { file, capabilities: ALL_CAPABILITIES },
      { onSuccess: (r) => setJobId(r.jobId) },
    );
    if (fileRef.current) fileRef.current.value = "";
  };

  const onDriveZip = (path: string) => {
    if (busy) return;
    installFromPath.mutate(
      { path, capabilities: ALL_CAPABILITIES },
      {
        onSuccess: (r) => {
          setJobId(r.jobId);
          setDriveOpen(false);
          setDrivePath(null);
        },
      },
    );
  };

  return (
    <div className="h-full overflow-auto bg-background">
      <div className="mx-auto max-w-3xl space-y-6 p-6">
        <div className="flex items-center gap-3">
          <Boxes className="h-6 w-6 text-primary" />
          <div>
            <h2 className="text-lg font-semibold">FoulFox Apps</h2>
            <p className="text-sm text-muted-foreground">
              Install a web app from a GitHub repository that has a{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-xs">foxapp.json</code>{" "}
              at its root.
            </p>
          </div>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Install an app</CardTitle>
            <CardDescription>
              Paste a public GitHub repo URL. FoulFox clones it, validates the
              manifest, then runs its install &amp; build steps.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Github className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={repoUrl}
                  onChange={(e) => setRepoUrl(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") onInstall();
                  }}
                  placeholder="https://github.com/owner/repo"
                  className="pl-9"
                  disabled={busy}
                  data-testid="input-app-repo"
                />
              </div>
              <Button
                onClick={onInstall}
                disabled={busy || !repoUrl.trim() || !token}
                data-testid="button-install-app"
              >
                {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Install
              </Button>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground">or install from</span>
              <input
                ref={fileRef}
                type="file"
                accept=".zip,application/zip"
                className="hidden"
                onChange={(e) => onZipPicked(e.target.files?.[0] ?? null)}
                data-testid="input-app-zip"
              />
              <Button
                variant="outline"
                size="sm"
                disabled={busy || !token}
                onClick={() => fileRef.current?.click()}
                data-testid="button-upload-zip"
              >
                <Upload className="mr-2 h-4 w-4" /> Zip file
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={busy || !token}
                onClick={() => {
                  setDriveOpen((v) => !v);
                  setDrivePath(null);
                }}
                data-testid="button-flash-drive"
              >
                <Usb className="mr-2 h-4 w-4" /> Flash drive
              </Button>
            </div>

            {driveOpen && (
              <div className="rounded-md border bg-muted/30 p-3" data-testid="panel-flash-drive">
                {drivePath === null ? (
                  <>
                    <div className="mb-2 flex items-center justify-between">
                      <span className="text-xs font-medium text-muted-foreground">
                        Plugged-in drives
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        onClick={() => refetchDrives()}
                      >
                        <RefreshCw className="mr-1 h-3 w-3" /> Refresh
                      </Button>
                    </div>
                    {drivesLoading ? (
                      <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
                        <Loader2 className="h-3 w-3 animate-spin" /> Looking for drives…
                      </div>
                    ) : drives.length === 0 ? (
                      <p className="py-2 text-xs text-muted-foreground">
                        No drives found. Plug in a USB flash drive with your app&apos;s
                        .zip on it — it should appear here within a few seconds.
                      </p>
                    ) : (
                      <div className="space-y-1">
                        {drives.map((d) => (
                          <button
                            key={d.path}
                            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted"
                            onClick={() => setDrivePath(d.path)}
                            data-testid={`drive-${d.name}`}
                          >
                            <Usb className="h-4 w-4 text-muted-foreground" />
                            <span className="font-medium">{d.label || d.name}</span>
                            <span className="ml-auto text-xs text-muted-foreground">
                              {d.fsType ?? ""}
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    <div className="mb-2 flex items-center gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        onClick={() =>
                          setDrivePath(
                            dirListing?.parent &&
                              drives.some((d) => dirListing.path.startsWith(d.path)) &&
                              !drives.some((d) => d.path === dirListing.path)
                              ? dirListing.parent
                              : null,
                          )
                        }
                      >
                        <ArrowLeft className="mr-1 h-3 w-3" /> Back
                      </Button>
                      <span className="truncate text-xs text-muted-foreground">
                        {dirListing?.path ?? drivePath}
                      </span>
                    </div>
                    {dirLoading ? (
                      <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
                        <Loader2 className="h-3 w-3 animate-spin" /> Reading…
                      </div>
                    ) : (
                      <div className="max-h-56 space-y-1 overflow-auto">
                        {(dirListing?.entries ?? [])
                          .filter(
                            (e) =>
                              e.type === "directory" ||
                              (e.type === "file" && /\.zip$/i.test(e.name)),
                          )
                          .map((e) =>
                            e.type === "directory" ? (
                              <button
                                key={e.path}
                                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted"
                                onClick={() => setDrivePath(e.path)}
                              >
                                <Folder className="h-4 w-4 text-muted-foreground" />
                                {e.name}
                              </button>
                            ) : (
                              <button
                                key={e.path}
                                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted"
                                onClick={() => onDriveZip(e.path)}
                                data-testid={`zip-${e.name}`}
                              >
                                <FileArchive className="h-4 w-4 text-primary" />
                                <span className="font-medium">{e.name}</span>
                                {e.sizeBytes != null && (
                                  <span className="ml-auto text-xs text-muted-foreground">
                                    {(e.sizeBytes / (1024 * 1024)).toFixed(1)} MB
                                  </span>
                                )}
                              </button>
                            ),
                          )}
                        {dirListing &&
                          dirListing.entries.filter(
                            (e) =>
                              e.type === "directory" ||
                              (e.type === "file" && /\.zip$/i.test(e.name)),
                          ).length === 0 && (
                            <p className="py-2 text-xs text-muted-foreground">
                              No folders or .zip files here.
                            </p>
                          )}
                      </div>
                    )}
                  </>
                )}
              </div>
            )}

            {!token && (
              <p className="text-xs text-amber-500">
                Waiting for a shell session token before installs can run…
              </p>
            )}
            {startError && (
              <p className="text-xs text-destructive">
                {startError.message ?? "Install failed to start."}
              </p>
            )}

            {jobId && job && (
              <div className="rounded-md border bg-muted/30 p-3">
                <div className="mb-2 flex items-center gap-2 text-sm">
                  {job.phase === "done" ? (
                    <CheckCircle2 className="h-4 w-4 text-green-500" />
                  ) : job.phase === "error" ? (
                    <AlertCircle className="h-4 w-4 text-destructive" />
                  ) : (
                    <Loader2 className="h-4 w-4 animate-spin text-primary" />
                  )}
                  <span className="font-medium">
                    {job.appName ? `${job.appName}: ` : ""}
                    {PHASE_LABEL[job.phase]}
                  </span>
                  {(job.phase === "done" || job.phase === "error") && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="ml-auto h-7 px-2 text-xs"
                      onClick={() => {
                        setJobId(null);
                        setRepoUrl("");
                      }}
                      data-testid="button-dismiss-job"
                    >
                      Dismiss
                    </Button>
                  )}
                </div>
                {job.error && (
                  <p className="mb-2 whitespace-pre-wrap text-xs text-destructive">{job.error}</p>
                )}
                <pre
                  ref={logRef}
                  className="max-h-56 overflow-auto whitespace-pre-wrap rounded bg-zinc-950 p-2 font-mono text-[11px] leading-snug text-zinc-200"
                  data-testid="text-install-log"
                >
                  {job.log || "…"}
                </pre>
              </div>
            )}
          </CardContent>
        </Card>

        <div className="space-y-3">
          <h3 className="text-sm font-medium text-muted-foreground">
            Installed apps{apps.length ? ` (${apps.length})` : ""}
          </h3>
          {isLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : apps.length === 0 ? (
            <Card>
              <CardContent className="py-8 text-center text-sm text-muted-foreground">
                No apps installed yet. Install one above to get started.
              </CardContent>
            </Card>
          ) : (
            apps.map((app) => <AppCard key={app.id} app={app} token={token} />)
          )}
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: InstalledApp["status"] }) {
  if (status === "installed") return <Badge variant="secondary">Installed</Badge>;
  if (status === "installing")
    return (
      <Badge variant="outline" className="gap-1.5">
        <Loader2 className="h-3 w-3 animate-spin" /> Installing…
      </Badge>
    );
  return <Badge variant="destructive">Error</Badge>;
}

const RUN_BADGE: Record<RunPhase, { label: string; cls: string }> = {
  stopped: { label: "Stopped", cls: "text-muted-foreground" },
  starting: { label: "Starting…", cls: "text-amber-500" },
  running: { label: "Running", cls: "text-green-500" },
  crashed: { label: "Crashed — restarting", cls: "text-destructive" },
};

function AppCard({ app, token }: { app: InstalledApp; token?: string | null }) {
  const uninstall = useUninstallApp();
  const start = useStartApp();
  const stop = useStopApp();
  const [logs, setLogs] = useState<string | null>(null);
  const [loadingLogs, setLoadingLogs] = useState(false);
  const [windowOpen, setWindowOpen] = useState(true);
  // Where to embed the app UI from: a dedicated loopback origin on the
  // appliance (privilege separation), null in dev (same-origin, opaque sandbox).
  const [uiBase, setUiBase] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    fetchAppUiBase().then((b) => {
      if (alive) setUiBase(b);
    });
    return () => {
      alive = false;
    };
  }, []);

  const phase = app.run?.phase ?? "stopped";
  const isUp = phase === "running" || phase === "starting";
  const runBusy = start.isPending || stop.isPending;
  const runError = (start.error as Error | null) ?? (stop.error as Error | null);

  const toggleLogs = async () => {
    if (logs !== null) {
      setLogs(null);
      return;
    }
    setLoadingLogs(true);
    try {
      // Prefer the live runtime log when the app has run; fall back to install log.
      const runLog = isUp || phase === "crashed" ? await fetchRunLog(app.id) : "";
      setLogs(runLog || (await fetchAppLogs(app.id)));
    } catch (e) {
      setLogs(`Could not load logs: ${(e as Error).message}`);
    } finally {
      setLoadingLogs(false);
    }
  };

  const onUninstall = () => {
    if (window.confirm(`Uninstall "${app.name}"? This removes its files and data.`)) {
      uninstall.mutate(app.id);
    }
  };

  return (
    <Card data-testid={`card-app-${app.id}`}>
      <CardContent className="space-y-3 p-4">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted">
            {app.icon ? (
              <img
                src={appIconUrl(app.id)}
                alt={app.name}
                className="h-full w-full object-cover"
                onError={(e) => {
                  (e.currentTarget as HTMLImageElement).style.display = "none";
                  (e.currentTarget.nextElementSibling as HTMLElement | null)?.style.setProperty("display", "flex");
                }}
              />
            ) : null}
            <span
              className={`${app.icon ? "hidden" : "flex"} h-full w-full items-center justify-center`}
            >
              <Boxes className="h-5 w-5 text-muted-foreground" />
            </span>
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium" data-testid={`text-app-name-${app.id}`}>
                {app.name}
              </span>
              <Badge variant="outline" className="text-[10px]">
                v{app.version}
              </Badge>
              <Badge variant="outline" className="text-[10px]">
                {app.runtime}
              </Badge>
              <StatusBadge status={app.status} />
            </div>
            {app.description && (
              <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{app.description}</p>
            )}
          </div>
          <div className="flex shrink-0 gap-1">
            {app.status === "installed" &&
              (isUp ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 px-2 text-xs"
                  onClick={() => stop.mutate(app.id)}
                  disabled={runBusy || !token}
                  title="Stop app"
                  data-testid={`button-stop-app-${app.id}`}
                >
                  {stop.isPending ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Square className="h-3.5 w-3.5" />
                  )}
                </Button>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 px-2 text-xs"
                  onClick={() => start.mutate(app.id)}
                  disabled={runBusy || !token}
                  title="Start app"
                  data-testid={`button-start-app-${app.id}`}
                >
                  {start.isPending ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Play className="h-3.5 w-3.5" />
                  )}
                </Button>
              ))}
            <Button
              variant="ghost"
              size="sm"
              className="h-8 px-2 text-xs"
              onClick={toggleLogs}
              data-testid={`button-app-logs-${app.id}`}
            >
              {loadingLogs ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <FileText className="h-3.5 w-3.5" />
              )}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 px-2 text-xs text-destructive hover:text-destructive"
              onClick={onUninstall}
              disabled={uninstall.isPending}
              data-testid={`button-uninstall-${app.id}`}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>

        {app.status === "installed" && (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span
              className={`inline-flex items-center gap-1.5 font-medium ${RUN_BADGE[phase].cls}`}
              data-testid={`text-run-phase-${app.id}`}
            >
              <span
                className={`h-2 w-2 rounded-full ${
                  phase === "running"
                    ? "bg-green-500"
                    : phase === "starting"
                      ? "bg-amber-500 animate-pulse"
                      : phase === "crashed"
                        ? "bg-destructive"
                        : "bg-zinc-500"
                }`}
              />
              {RUN_BADGE[phase].label}
            </span>
            {app.autostart && (
              <Badge variant="outline" className="text-[10px]">
                Autostart
              </Badge>
            )}
            {app.run?.restarts > 0 && (
              <span className="text-muted-foreground">
                restarts: {app.run.restarts}
              </span>
            )}
            {phase === "crashed" && app.run?.lastExit && (
              <span className="text-muted-foreground">({app.run.lastExit})</span>
            )}
          </div>
        )}

        {runError && (
          <p className="text-xs text-destructive">{runError.message}</p>
        )}

        {app.status === "error" && app.error && (
          <p className="whitespace-pre-wrap rounded bg-destructive/10 p-2 text-xs text-destructive">
            {app.error}
          </p>
        )}

        {app.capabilities.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-muted-foreground">Capabilities:</span>
            {app.capabilities.map((c) => (
              <Badge
                key={c}
                variant={app.grantedCapabilities.includes(c) ? "secondary" : "outline"}
                className="text-[10px]"
              >
                {CAP_LABEL[c] ?? c}
              </Badge>
            ))}
          </div>
        )}

        <a
          href={app.repoUrl}
          target="_blank"
          rel="noreferrer"
          onClick={externalLinkClick(app.repoUrl)}
          className="inline-flex items-center gap-1 break-all text-xs text-muted-foreground hover:text-foreground"
        >
          <ExternalLink className="h-3 w-3 shrink-0" /> {app.repoUrl}
        </a>

        {logs !== null && (
          <pre
            className="max-h-56 overflow-auto whitespace-pre-wrap rounded bg-zinc-950 p-2 font-mono text-[11px] leading-snug text-zinc-200"
            data-testid={`text-app-log-${app.id}`}
          >
            {logs || "(no log output)"}
          </pre>
        )}

        {/* App window: mounted the entire time the app is up (even while the
            panel is collapsed or another shell tab is shown) so a voice app's
            microphone session and audio playback are never torn down. */}
        {app.hasWindow && phase === "running" && (
          <div className="overflow-hidden rounded-md border">
            <button
              className="flex w-full items-center gap-2 bg-muted/40 px-3 py-1.5 text-xs font-medium hover:bg-muted"
              onClick={() => setWindowOpen((v) => !v)}
              data-testid={`button-toggle-window-${app.id}`}
            >
              <Monitor className="h-3.5 w-3.5 text-muted-foreground" />
              {app.window?.title || app.name}
              {windowOpen ? (
                <ChevronUp className="ml-auto h-3.5 w-3.5" />
              ) : (
                <ChevronDown className="ml-auto h-3.5 w-3.5" />
              )}
            </button>
            <div
              className={windowOpen ? "bg-background" : "h-0 overflow-hidden"}
              style={
                windowOpen
                  ? { height: Math.min(app.window?.height ?? 480, 640) }
                  : undefined
              }
            >
              <iframe
                // Re-mount the iframe on each new healthy run: a frame that
                // loaded a 502 ("App is not responding.") mid-startup never
                // recovers on its own.
                key={app.run?.startedAt ?? "run"}
                src={appUiUrl(app.id, uiBase)}
                title={app.window?.title || app.name}
                className="h-full w-full border-0"
                // Hands-free voice needs a live mic + gesture-free audio inside
                // the embed. On the appliance, app UIs come from a DEDICATED
                // loopback origin (uiBase) so allow-same-origin is safe: app JS
                // is same-origin only with the UI-proxy server, never with the
                // shell API (it cannot read the shell session token). In dev
                // there is no second origin, so the same-origin path is used
                // WITHOUT allow-same-origin (opaque origin — mic is a
                // hardware/appliance concern anyway).
                sandbox={
                  uiBase
                    ? "allow-scripts allow-same-origin allow-forms"
                    : "allow-scripts allow-forms"
                }
                allow="microphone; camera; autoplay; speaker-selection"
                data-testid={`iframe-app-${app.id}`}
              />
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

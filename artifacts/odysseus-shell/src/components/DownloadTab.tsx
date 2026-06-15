import {
  useOsRelease,
  useAppUpdateInfo,
  useUpdateStatus,
  useApplyAppUpdate,
  useRollbackAppUpdate,
} from "@/hooks/use-vms";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Download,
  Usb,
  Rocket,
  Github,
  ExternalLink,
  ShieldCheck,
  Disc3,
  Loader2,
  AlertCircle,
  RefreshCw,
  RotateCcw,
  CheckCircle2,
  XCircle,
} from "lucide-react";

const ETCHER_URL = "https://etcher.balena.io/";

export function DownloadTab() {
  const { data: release, isLoading } = useOsRelease();
  const status =
    release?.status ?? (release?.available ? "ready" : "unconfigured");
  const available = release?.available ?? false;
  const isoUrl = release?.isoUrl ?? null;
  const sha256Url = release?.sha256Url ?? null;

  return (
    <div className="h-full overflow-auto bg-background">
      <div className="mx-auto max-w-3xl space-y-8 px-6 py-8">
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Disc3 className="h-6 w-6 text-primary" />
            <h2 className="text-2xl font-semibold tracking-tight">Get FoulFox OS</h2>
          </div>
          <p className="text-muted-foreground">
            Download the bootable FoulFox OS image, write it to a USB stick, and
            boot any PC straight into the FoulFox OS appliance.
          </p>
        </div>

        <Card>
          <CardHeader>
            <div className="flex items-start justify-between gap-4">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <Download className="h-5 w-5" /> FoulFox OS image
                </CardTitle>
                <CardDescription>
                  The latest bootable appliance image (.iso).
                  {release?.version ? ` Version ${release.version}.` : ""}
                </CardDescription>
              </div>
              {isLoading ? null : status === "ready" ? (
                <Badge variant="secondary" className="shrink-0">
                  Ready
                </Badge>
              ) : status === "building" ? (
                <Badge variant="outline" className="shrink-0 gap-1.5">
                  <Loader2 className="h-3 w-3 animate-spin" /> Building…
                </Badge>
              ) : (
                <Badge variant="outline" className="shrink-0">
                  Not set up yet
                </Badge>
              )}
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {isLoading ? (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Checking for the latest
                image…
              </div>
            ) : status === "ready" && isoUrl ? (
              <>
                <Button
                  asChild
                  size="lg"
                  className="w-full sm:w-auto"
                  data-testid="button-download-iso"
                >
                  <a href={isoUrl} download>
                    <Download className="mr-2 h-4 w-4" /> Download FoulFox OS
                  </a>
                </Button>
                {sha256Url ? (
                  <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <ShieldCheck className="h-3.5 w-3.5" />
                    Verify it against the{" "}
                    <a
                      href={sha256Url}
                      className="underline underline-offset-2 hover:text-foreground"
                      target="_blank"
                      rel="noreferrer"
                      data-testid="link-iso-checksum"
                    >
                      checksum
                    </a>{" "}
                    before flashing.
                  </p>
                ) : null}
              </>
            ) : status === "building" ? (
              <BuildingNotice repo={release?.repo ?? null} />
            ) : (
              <SetupNotice />
            )}
          </CardContent>
        </Card>

        <AppUpdatesCard />

        <div className="space-y-4">
          <h3 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
            From download to running, in 3 steps
          </h3>
          <div className="grid gap-4 sm:grid-cols-3">
            <StepCard
              n={1}
              icon={Download}
              title="Download"
              desc="Grab the FoulFox OS .iso using the button above."
            />
            <StepCard
              n={2}
              icon={Usb}
              title="Flash to USB"
              desc="Open balenaEtcher, pick the .iso and your USB stick, then click Flash."
            />
            <StepCard
              n={3}
              icon={Rocket}
              title="Boot & go"
              desc="Plug the USB into the target PC, boot from it, and FoulFox OS starts itself."
            />
          </div>

          <Card className="bg-muted/30">
            <CardContent className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm text-muted-foreground">
                Writing a bootable USB needs a tiny free flasher — a web page can't
                write USB drives directly. balenaEtcher is the simplest, and works
                on Windows, macOS and Linux.
              </p>
              <Button asChild variant="outline" className="shrink-0">
                <a
                  href={ETCHER_URL}
                  target="_blank"
                  rel="noreferrer"
                  data-testid="link-etcher"
                >
                  Get balenaEtcher <ExternalLink className="ml-2 h-3.5 w-3.5" />
                </a>
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function fmtSize(bytes: number | null): string | null {
  if (!bytes || bytes <= 0) return null;
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

// Live app-stack updates: pull + atomically apply a new bundle on a running
// device, with automatic rollback. Only meaningful on a FoulFox OS appliance
// (info.supported); in the dev preview it explains that updates run on-device.
function AppUpdatesCard() {
  const { data: info, isLoading } = useAppUpdateInfo();
  const { data: status } = useUpdateStatus();
  const apply = useApplyAppUpdate();
  const rollback = useRollbackAppUpdate();

  const supported = info?.supported ?? false;
  const updateState = status?.state ?? "idle";
  const running = updateState === "running";
  const busy = running || apply.isPending || rollback.isPending;
  const available = (info?.available ?? false) && supported;

  const installed = info?.currentVersion ?? status?.currentVersion ?? null;
  const latest = info?.latestVersion ?? null;
  const size = fmtSize(info?.sizeBytes ?? null);
  const actionError =
    (apply.error as Error | null)?.message ??
    (rollback.error as Error | null)?.message ??
    null;

  const onApply = () => {
    if (busy) return;
    if (window.confirm("Apply the latest update? Services will restart briefly, and a failed update rolls back automatically.")) {
      apply.mutate();
    }
  };
  const onRollback = () => {
    if (busy) return;
    if (window.confirm("Roll back to the previous version? Services will restart briefly.")) {
      rollback.mutate();
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle className="flex items-center gap-2">
              <RefreshCw className="h-5 w-5" /> App updates
            </CardTitle>
            <CardDescription>
              Update the running appliance in place — no reflashing. Bad updates
              roll back on their own.
            </CardDescription>
          </div>
          <UpdateBadge
            isLoading={isLoading}
            supported={supported}
            running={running}
            available={available}
            status={info?.status ?? null}
          />
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
          <span className="text-muted-foreground">
            Installed:{" "}
            <span className="font-medium text-foreground" data-testid="text-installed-version">
              {installed ?? "baked image"}
            </span>
          </span>
          {supported && latest ? (
            <span className="text-muted-foreground">
              Latest:{" "}
              <span className="font-medium text-foreground" data-testid="text-latest-version">
                {latest}
              </span>
              {size ? ` (${size})` : ""}
            </span>
          ) : null}
        </div>

        {supported && available && info?.notes ? (
          <p className="text-sm text-muted-foreground">{info.notes}</p>
        ) : null}

        {/* Live progress / outcome from the patcher's status file. */}
        {supported && running ? (
          <div className="flex items-center gap-2 rounded-md border bg-muted/30 p-3 text-sm">
            <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
            <span>{status?.message ?? "Working…"}</span>
          </div>
        ) : supported && updateState === "success" && status?.message ? (
          <div className="flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm">
            <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
            <span>{status.message}</span>
          </div>
        ) : supported && updateState === "failed" ? (
          <div className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm">
            <XCircle className="h-4 w-4 shrink-0 text-destructive" />
            <span>{status?.message ?? status?.error ?? "The update failed."}</span>
          </div>
        ) : null}

        {actionError ? (
          <p className="flex items-center gap-1.5 text-sm text-destructive">
            <AlertCircle className="h-3.5 w-3.5" /> {actionError}
          </p>
        ) : null}

        {!supported ? (
          <div className="flex items-start gap-2 rounded-md border border-dashed p-4 text-sm text-muted-foreground">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <span>
              Live updates run on a FoulFox OS device. In this preview the updater
              isn't installed, so there's nothing to apply here.
            </span>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={onApply}
              disabled={busy || !available}
              data-testid="button-apply-update"
            >
              {apply.isPending || running ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Rocket className="mr-2 h-4 w-4" />
              )}
              {available ? "Apply update" : "Up to date"}
            </Button>
            <Button
              variant="outline"
              onClick={onRollback}
              disabled={busy}
              data-testid="button-rollback-update"
            >
              <RotateCcw className="mr-2 h-4 w-4" /> Roll back
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function UpdateBadge({
  isLoading,
  supported,
  running,
  available,
  status,
}: {
  isLoading: boolean;
  supported: boolean;
  running: boolean;
  available: boolean;
  status: string | null;
}) {
  if (isLoading) return null;
  if (!supported)
    return (
      <Badge variant="outline" className="shrink-0">
        Device only
      </Badge>
    );
  if (running)
    return (
      <Badge variant="secondary" className="shrink-0 gap-1.5">
        <Loader2 className="h-3 w-3 animate-spin" /> Updating…
      </Badge>
    );
  if (available)
    return (
      <Badge variant="secondary" className="shrink-0">
        Update available
      </Badge>
    );
  if (status === "current")
    return (
      <Badge variant="outline" className="shrink-0">
        Up to date
      </Badge>
    );
  if (status === "building")
    return (
      <Badge variant="outline" className="shrink-0 gap-1.5">
        <Loader2 className="h-3 w-3 animate-spin" /> Building…
      </Badge>
    );
  return (
    <Badge variant="outline" className="shrink-0">
      Not set up yet
    </Badge>
  );
}

function StepCard({
  n,
  icon: Icon,
  title,
  desc,
}: {
  n: number;
  icon: typeof Download;
  title: string;
  desc: string;
}) {
  return (
    <Card>
      <CardContent className="space-y-2 py-5">
        <div className="flex items-center gap-2">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
            {n}
          </span>
          <Icon className="h-4 w-4 text-muted-foreground" />
          <span className="font-medium">{title}</span>
        </div>
        <p className="text-sm text-muted-foreground">{desc}</p>
      </CardContent>
    </Card>
  );
}

function BuildingNotice({ repo }: { repo: string | null }) {
  const actionsUrl = repo
    ? `https://github.com/${repo}/actions`
    : "https://github.com";
  return (
    <div className="space-y-3 rounded-md border border-dashed p-4">
      <div className="flex items-center gap-2 font-medium">
        <Loader2 className="h-4 w-4 animate-spin text-primary" />
        Your FoulFox OS image is being built
      </div>
      <p className="text-sm text-muted-foreground">
        A free GitHub cloud build is assembling the latest bootable image — this
        usually takes about 30–90 minutes. This page checks on its own, so the
        download button switches on by itself the moment it's ready. No refresh
        needed.
      </p>
      <p className="text-sm text-muted-foreground">
        Haven't kicked off a build yet? On GitHub open{" "}
        <span className="font-medium text-foreground">
          Actions → Build FoulFox OS ISO → Run workflow
        </span>
        .
      </p>
      <Button asChild variant="outline" size="sm">
        <a
          href={actionsUrl}
          target="_blank"
          rel="noreferrer"
          data-testid="link-actions"
        >
          <Github className="mr-2 h-4 w-4" /> View build on GitHub
          <ExternalLink className="ml-2 h-3.5 w-3.5" />
        </a>
      </Button>
    </div>
  );
}

function SetupNotice() {
  return (
    <div className="space-y-3 rounded-md border border-dashed p-4">
      <div className="flex items-center gap-2 font-medium">
        <AlertCircle className="h-4 w-4 text-amber-500" />
        One-time setup to switch downloads on
      </div>
      <p className="text-sm text-muted-foreground">
        The image is built for free by a GitHub cloud build, and this button then
        links straight to it. To turn it on:
      </p>
      <ol className="list-decimal space-y-1.5 pl-5 text-sm text-muted-foreground">
        <li>
          Connect this project to GitHub (Git pane →{" "}
          <span className="font-medium text-foreground">
            Create a GitHub repository
          </span>
          ).
        </li>
        <li>
          On GitHub, open{" "}
          <span className="font-medium text-foreground">
            Actions → Build FoulFox OS ISO → Run workflow
          </span>{" "}
          and wait for it to finish (~30–90 min).
        </li>
        <li>
          Point this app at the build by setting{" "}
          <code className="rounded bg-muted px-1 py-0.5 text-xs text-foreground">
            FOULFOX_GITHUB_REPO
          </code>{" "}
          to your <span className="font-medium text-foreground">owner/repo</span>{" "}
          (or ask Replit to wire it). The download then switches on here.
        </li>
      </ol>
      <Button asChild variant="outline" size="sm">
        <a
          href="https://github.com"
          target="_blank"
          rel="noreferrer"
          data-testid="link-github"
        >
          <Github className="mr-2 h-4 w-4" /> Open GitHub
        </a>
      </Button>
    </div>
  );
}

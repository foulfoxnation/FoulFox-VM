import { useMemo, useState } from "react";
import {
  useListDirectory,
  getListDirectoryQueryKey,
  useListDrives,
  getListDrivesQueryKey,
  useGetStaging,
  getGetStagingQueryKey,
  useFrontloadFiles,
  FrontloadInputCategory,
  type FileEntry,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useShellToken } from "@/hooks/use-shell-token";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import {
  Folder,
  File as FileIcon,
  FileSymlink,
  HardDrive,
  Usb,
  ArrowUp,
  Home as HomeIcon,
  RefreshCw,
  Upload,
  AlertCircle,
  Loader2,
  Box,
  CornerDownRight,
} from "lucide-react";

type Category = (typeof FrontloadInputCategory)[keyof typeof FrontloadInputCategory];

function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return "";
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(value >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function entryIcon(type: FileEntry["type"]) {
  if (type === "directory") return <Folder className="h-4 w-4 text-sky-500 shrink-0" />;
  if (type === "symlink") return <FileSymlink className="h-4 w-4 text-violet-400 shrink-0" />;
  return <FileIcon className="h-4 w-4 text-muted-foreground shrink-0" />;
}

export function FileExplorer() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // null path => let the server default to HOME on first load.
  const [path, setPath] = useState<string | null>(null);
  const [pathInput, setPathInput] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [category, setCategory] = useState<Category>(FrontloadInputCategory.drivers);

  const { data: shellToken } = useShellToken();
  const tokenReady = !!shellToken;
  const authRequest = shellToken ? { headers: { "X-Shell-Token": shellToken } } : undefined;

  const listing = useListDirectory(path ? { path } : undefined, {
    query: {
      enabled: tokenReady,
      queryKey: getListDirectoryQueryKey(path ? { path } : undefined),
    },
    request: authRequest,
  });
  const drives = useListDrives({
    query: { enabled: tokenReady, queryKey: getListDrivesQueryKey() },
    request: authRequest,
  });
  const staging = useGetStaging({
    query: { enabled: tokenReady, queryKey: getGetStagingQueryKey() },
    request: authRequest,
  });
  const frontload = useFrontloadFiles({ request: authRequest });

  const currentPath = listing.data?.path ?? path ?? "~";
  const parent = listing.data?.parent ?? null;

  const navigate = (next: string | null) => {
    setPath(next);
    setSelected(new Set());
  };

  const toggleSelect = (entryPath: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(entryPath)) next.delete(entryPath);
      else next.add(entryPath);
      return next;
    });
  };

  const selectedCount = selected.size;

  const handleFrontload = () => {
    if (selectedCount === 0) return;
    frontload.mutate(
      { data: { sources: Array.from(selected), category } },
      {
        onSuccess: (result) => {
          const copied = result.copied.length;
          const failed = result.failed.length;
          toast({
            title:
              failed === 0
                ? `Frontloaded ${copied} item${copied === 1 ? "" : "s"} to ${category}`
                : `Frontloaded ${copied}, ${failed} failed`,
            description:
              failed > 0
                ? result.failed.map((f) => f.error).join("; ").slice(0, 200)
                : `Staged at ${result.stagingPath}`,
            variant: failed > 0 && copied === 0 ? "destructive" : undefined,
            duration: 4000,
          });
          setSelected(new Set());
          queryClient.invalidateQueries({ queryKey: getGetStagingQueryKey() });
        },
        onError: (err) => {
          toast({
            title: "Frontload failed",
            description: err instanceof Error ? err.message : "Unknown error",
            variant: "destructive",
            duration: 4000,
          });
        },
      },
    );
  };

  const goToManualPath = () => {
    const trimmed = pathInput.trim();
    if (trimmed.length > 0) navigate(trimmed);
  };

  const driveList = drives.data ?? [];
  const stagingPath = staging.data?.path ?? null;

  const sortedDrives = useMemo(
    () => [...driveList].sort((a, b) => Number(b.removable) - Number(a.removable)),
    [driveList],
  );

  return (
    <div className="flex h-full w-full">
      {/* ── Sidebar: locations + drives ─────────────────────────────── */}
      <aside className="w-60 shrink-0 border-r bg-muted/20 flex flex-col">
        <ScrollArea className="flex-1">
          <div className="p-3 space-y-4">
            <div>
              <p className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Locations
              </p>
              <SidebarButton
                active={path === null}
                icon={<HomeIcon className="h-4 w-4" />}
                label="Home"
                onClick={() => navigate(null)}
              />
              <SidebarButton
                active={path === "/"}
                icon={<HardDrive className="h-4 w-4" />}
                label="Filesystem"
                onClick={() => navigate("/")}
              />
              <SidebarButton
                active={stagingPath != null && currentPath === stagingPath}
                icon={<Box className="h-4 w-4" />}
                label="Frontload staging"
                onClick={() => stagingPath && navigate(stagingPath)}
              />
            </div>

            <div>
              <div className="flex items-center justify-between px-2 pb-1">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Drives
                </p>
                <button
                  type="button"
                  onClick={() => drives.refetch()}
                  className="text-muted-foreground hover:text-foreground"
                  title="Rescan drives"
                  data-testid="button-rescan-drives"
                >
                  <RefreshCw className={`h-3 w-3 ${drives.isFetching ? "animate-spin" : ""}`} />
                </button>
              </div>
              {sortedDrives.length === 0 ? (
                <p className="px-2 py-1 text-xs text-muted-foreground">
                  No drives detected. Insert a USB drive and rescan.
                </p>
              ) : (
                sortedDrives.map((d) => (
                  <SidebarButton
                    key={d.path}
                    active={currentPath === d.path}
                    icon={
                      d.removable ? (
                        <Usb className="h-4 w-4 text-emerald-500" />
                      ) : (
                        <HardDrive className="h-4 w-4" />
                      )
                    }
                    label={d.label || d.name}
                    sublabel={formatBytes(d.sizeBytes)}
                    onClick={() => navigate(d.path)}
                  />
                ))
              )}
            </div>
          </div>
        </ScrollArea>
      </aside>

      {/* ── Main: path bar + listing + frontload bar ─────────────────── */}
      <div className="flex flex-1 flex-col min-w-0">
        {/* Path / toolbar */}
        <div className="flex items-center gap-2 border-b bg-card px-3 py-2">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0"
            disabled={!parent}
            onClick={() => parent && navigate(parent)}
            title="Up one level"
            data-testid="button-up-dir"
          >
            <ArrowUp className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0"
            onClick={() => listing.refetch()}
            title="Refresh"
            data-testid="button-refresh-dir"
          >
            <RefreshCw className={`h-4 w-4 ${listing.isFetching ? "animate-spin" : ""}`} />
          </Button>
          <div className="flex flex-1 items-center gap-2 min-w-0">
            <Input
              value={pathInput}
              onChange={(e) => setPathInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && goToManualPath()}
              placeholder={currentPath}
              className="h-8 font-mono text-xs"
              data-testid="input-path"
            />
            <Button variant="secondary" size="sm" className="h-8 shrink-0" onClick={goToManualPath}>
              Go
            </Button>
          </div>
        </div>

        {/* Listing */}
        <div className="flex-1 overflow-hidden">
          {listing.isError ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">
              <AlertCircle className="h-6 w-6 text-destructive" />
              <p>Cannot open this location.</p>
              <p className="text-xs">It may be unreadable or no longer mounted.</p>
            </div>
          ) : !tokenReady || listing.isLoading ? (
            <div className="flex h-full items-center justify-center text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : listing.data && listing.data.entries.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              This folder is empty
            </div>
          ) : (
            <ScrollArea className="h-full">
              <div className="divide-y">
                {listing.data?.entries.map((entry) => {
                  const isDir = entry.type === "directory";
                  const isSelected = selected.has(entry.path);
                  return (
                    <div
                      key={entry.path}
                      className={`flex items-center gap-3 px-3 py-1.5 text-sm hover:bg-accent/50 ${
                        isSelected ? "bg-accent/40" : ""
                      }`}
                      data-testid={`entry-${entry.name}`}
                    >
                      <Checkbox
                        checked={isSelected}
                        onCheckedChange={() => toggleSelect(entry.path)}
                        aria-label={`Select ${entry.name}`}
                        data-testid={`checkbox-${entry.name}`}
                      />
                      <button
                        type="button"
                        className="flex flex-1 items-center gap-2 min-w-0 text-left"
                        onClick={() => isDir && navigate(entry.path)}
                        disabled={!isDir}
                      >
                        {entryIcon(entry.type)}
                        <span className={`truncate ${isDir ? "text-foreground" : "text-muted-foreground"}`}>
                          {entry.name}
                        </span>
                      </button>
                      <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                        {entry.type === "file" ? formatBytes(entry.sizeBytes) : ""}
                      </span>
                    </div>
                  );
                })}
              </div>
            </ScrollArea>
          )}
        </div>

        {/* Frontload action bar */}
        <div className="flex items-center gap-3 border-t bg-muted/30 px-3 py-2">
          <CornerDownRight className="h-4 w-4 text-muted-foreground shrink-0" />
          <span className="text-xs text-muted-foreground shrink-0">
            {selectedCount > 0 ? (
              <Badge variant="secondary" className="font-normal">
                {selectedCount} selected
              </Badge>
            ) : (
              "Select files/folders to frontload"
            )}
          </span>
          <div className="ml-auto flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Copy into</span>
            <Select value={category} onValueChange={(v) => setCategory(v as Category)}>
              <SelectTrigger className="h-8 w-28 text-xs" data-testid="select-category">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={FrontloadInputCategory.drivers}>Drivers</SelectItem>
                <SelectItem value={FrontloadInputCategory.isos}>ISOs</SelectItem>
                <SelectItem value={FrontloadInputCategory.files}>Files</SelectItem>
              </SelectContent>
            </Select>
            <Button
              size="sm"
              className="h-8"
              disabled={selectedCount === 0 || frontload.isPending}
              onClick={handleFrontload}
              data-testid="button-frontload"
            >
              {frontload.isPending ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <Upload className="mr-1 h-4 w-4" />
              )}
              Frontload
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function SidebarButton({
  active,
  icon,
  label,
  sublabel,
  onClick,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  sublabel?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors ${
        active ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
      }`}
    >
      <span className="shrink-0">{icon}</span>
      <span className="truncate flex-1 text-left">{label}</span>
      {sublabel ? <span className="shrink-0 text-[10px] text-muted-foreground/70">{sublabel}</span> : null}
    </button>
  );
}

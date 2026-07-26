import { useEffect, useRef, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useShellToken } from "@/hooks/use-shell-token";
import { useToast } from "@/hooks/use-toast";
import {
  ArrowLeft,
  ArrowRight,
  RotateCw,
  ExternalLink,
  Globe,
  Search,
} from "lucide-react";
import {
  fetchBrowserCapabilities,
  initBrowserSession,
  browserProxySrc,
  launchNativeBrowser,
  openStandaloneBrowser,
} from "@/lib/peripherals-api";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Compass, ChevronDown } from "lucide-react";

// Turn whatever the user typed into a URL: keep explicit http(s), promote a
// bare domain to https, otherwise run it as a web search.
function normalizeUrl(input: string): string {
  const t = input.trim();
  if (!t) return "";
  if (/^https?:\/\//i.test(t)) return t;
  if (!/\s/.test(t) && /\.[a-z]{2,}/i.test(t)) return `https://${t}`;
  return `https://duckduckgo.com/?q=${encodeURIComponent(t)}`;
}

const QUICK_LINKS = [
  { label: "DuckDuckGo", url: "https://duckduckgo.com/" },
  { label: "Wikipedia", url: "https://en.wikipedia.org/" },
  { label: "Replit", url: "https://replit.com/" },
  { label: "Hacker News", url: "https://news.ycombinator.com/" },
];

export function BrowserTab() {
  const { data: token } = useShellToken();
  const { toast } = useToast();
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const [address, setAddress] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [idx, setIdx] = useState(-1);
  const [reloadKey, setReloadKey] = useState(0);
  const [sessionReady, setSessionReady] = useState(false);
  // Set when the proxied page reports that clicks are going nowhere (JS-heavy
  // site that can't run in the sandboxed preview). Reset on every navigation.
  const [pageInert, setPageInert] = useState(false);

  const current = idx >= 0 && idx < history.length ? history[idx] : "";

  const { data: caps } = useQuery({
    queryKey: ["browser-capabilities"],
    queryFn: fetchBrowserCapabilities,
    staleTime: 60_000,
  });

  // Authorize the proxy iframe (HttpOnly cookie) before the first load.
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    initBrowserSession()
      .then(() => { if (!cancelled) setSessionReady(true); })
      .catch(() => { /* proxy will 401 and show its error page */ });
    return () => { cancelled = true; };
  }, [token]);

  const navigate = (url: string) => {
    if (!url) return;
    const base = history.slice(0, idx + 1);
    const next = [...base, url];
    setHistory(next);
    setIdx(next.length - 1);
    setAddress(url);
    setPageInert(false);
  };

  // The injected nav-shim posts the next URL up here (it never navigates itself,
  // so it works inside the same-origin-less sandbox and never sees a token).
  useEffect(() => {
    function onMsg(e: MessageEvent) {
      if (!iframeRef.current || e.source !== iframeRef.current.contentWindow) return;
      const data = e.data;
      if (data && data.type === "ff-navigate" && typeof data.url === "string") {
        navigate(data.url);
      } else if (data && data.type === "ff-page-inert") {
        setPageInert(true);
      }
    }
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [history, idx]);

  // Open a standalone, movable browser window (Firefox/Chromium) over the
  // kiosk on the appliance. In dev this fails honestly with a clear message.
  const openBrowserMut = useMutation({
    mutationFn: (browser: "firefox" | "chromium") => openStandaloneBrowser(browser),
    onSuccess: (r) => toast({ title: r.message || "Opening browser…", duration: 2500 }),
    onError: (e) =>
      toast({
        title: "Couldn't open the browser",
        description: (e as Error).message,
        variant: "destructive",
        duration: 4000,
      }),
  });

  const launchMut = useMutation({
    mutationFn: () => launchNativeBrowser(current || normalizeUrl(address)),
    onSuccess: (r) => toast({ title: r.message || "Opened in Chromium", duration: 2500 }),
    onError: (e) => toast({ title: "Couldn't open full browser", description: (e as Error).message, variant: "destructive", duration: 4000 }),
  });

  const canBack = idx > 0;
  const canForward = idx < history.length - 1;
  const src = sessionReady && current
    ? `${browserProxySrc(current)}${reloadKey ? `&_r=${reloadKey}` : ""}`
    : "about:blank";

  return (
    <div className="flex h-full w-full flex-col bg-background" data-testid="browser-tab">
      {/* Address / navigation bar */}
      <div className="flex items-center gap-2 border-b bg-card px-3 py-2">
        <Button variant="ghost" size="icon" className="h-8 w-8" disabled={!canBack}
          onClick={() => setIdx(idx - 1)} title="Back" data-testid="button-browser-back">
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="icon" className="h-8 w-8" disabled={!canForward}
          onClick={() => setIdx(idx + 1)} title="Forward" data-testid="button-browser-forward">
          <ArrowRight className="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="icon" className="h-8 w-8" disabled={!current}
          onClick={() => setReloadKey((k) => k + 1)} title="Reload" data-testid="button-browser-reload">
          <RotateCw className="h-4 w-4" />
        </Button>
        <form
          className="flex flex-1 items-center"
          onSubmit={(e) => { e.preventDefault(); navigate(normalizeUrl(address)); }}
        >
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="Search or enter a website"
              className="h-8 pl-8"
              spellCheck={false}
              data-testid="input-browser-address"
            />
          </div>
        </form>
        <Button
          variant="outline" size="sm" className="h-8 gap-1.5"
          disabled={(!current && !address) || !token || launchMut.isPending}
          onClick={() => launchMut.mutate()}
          title={caps?.nativeBrowser ? "Open this page in fullscreen Chromium" : "Available on the booted FoulFox OS appliance"}
          data-testid="button-browser-launch"
        >
          <ExternalLink className="h-4 w-4" />
          Full browser
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5"
              disabled={!token || openBrowserMut.isPending}
              title={
                caps?.openBrowser
                  ? "Open a standalone browser window over the FoulFox desktop"
                  : "Available on the booted FoulFox OS appliance"
              }
              data-testid="button-open-browser"
            >
              <Compass className="h-4 w-4" />
              Open Browser
              <ChevronDown className="h-3 w-3 opacity-60" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onClick={() => openBrowserMut.mutate("firefox")}
              data-testid="menu-open-firefox"
            >
              Firefox
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => openBrowserMut.mutate("chromium")}
              data-testid="menu-open-chromium"
            >
              Chromium
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Page area */}
      <div className="relative flex-1 overflow-hidden bg-white">
        {current ? (
          <iframe
            ref={iframeRef}
            key={src}
            src={src}
            title="FoulFox browser"
            className="h-full w-full border-0"
            // No allow-same-origin: the fetched page runs in an opaque origin and
            // cannot reach the shell's storage or authenticated API. allow-scripts
            // lets the nav-shim run; allow-forms lets GET search boxes work.
            sandbox="allow-scripts allow-forms"
            data-testid="iframe-browser"
          />
        ) : null}
        {current && pageInert ? (
          <div
            className="absolute inset-x-0 top-0 z-10 flex flex-wrap items-center justify-center gap-2 border-b bg-card/95 px-3 py-2 text-sm shadow-md backdrop-blur"
            data-testid="banner-page-inert"
          >
            <span className="text-muted-foreground">
              This site doesn&apos;t fully work in the built-in preview — buttons may not respond.
            </span>
            <Button
              size="sm"
              className="h-7"
              disabled={!token || launchMut.isPending}
              onClick={() => launchMut.mutate()}
              data-testid="button-inert-full-browser"
            >
              <ExternalLink className="mr-1 h-3.5 w-3.5" />
              Open in full browser
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7"
              onClick={() => setPageInert(false)}
              data-testid="button-inert-dismiss"
            >
              Dismiss
            </Button>
          </div>
        ) : null}
        {!current ? (
          <div className="flex h-full w-full flex-col items-center justify-center gap-6 bg-background p-8 text-center">
            <Globe className="h-14 w-14 text-muted-foreground/60" />
            <div>
              <h2 className="text-lg font-semibold">Browse the web</h2>
              <p className="mt-1 max-w-md text-sm text-muted-foreground">
                Enter an address above. Some sites that block embedding will need
                the full browser button — that opens fullscreen Chromium on the
                appliance.
              </p>
            </div>
            <div className="flex flex-wrap items-center justify-center gap-2">
              {QUICK_LINKS.map((l) => (
                <Button key={l.url} variant="secondary" size="sm"
                  onClick={() => navigate(l.url)} data-testid={`button-quicklink-${l.label.toLowerCase().replace(/\s+/g, "-")}`}>
                  {l.label}
                </Button>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

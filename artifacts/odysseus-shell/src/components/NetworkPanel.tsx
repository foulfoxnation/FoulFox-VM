import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { useShellToken } from "@/hooks/use-shell-token";
import { useToast } from "@/hooks/use-toast";
import { Wifi, WifiOff, Cable, Loader2, Lock, Check, RefreshCw } from "lucide-react";
import {
  fetchNetworkStatus, scanWifi, connectWifi, forgetWifi, type WifiNetwork,
} from "@/lib/peripherals-api";

function isSecured(security: string): boolean {
  const s = (security || "").trim().toUpperCase();
  return s !== "" && s !== "--" && s !== "NONE";
}

export function NetworkPanel() {
  const { data: token } = useShellToken();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [connectTarget, setConnectTarget] = useState<WifiNetwork | null>(null);
  const [password, setPassword] = useState("");

  const status = useQuery({ queryKey: ["network-status"], queryFn: fetchNetworkStatus, refetchInterval: 5000 });
  const scan = useQuery({ queryKey: ["wifi-scan"], queryFn: scanWifi, enabled: false });

  const connectMut = useMutation({
    mutationFn: (v: { ssid: string; password: string }) => connectWifi(v.ssid, v.password, token),
    onSuccess: (r) => {
      toast({ title: r.message, duration: 2500 });
      setConnectTarget(null); setPassword("");
      qc.invalidateQueries({ queryKey: ["network-status"] });
      scan.refetch();
    },
    onError: (e) => toast({ title: "Couldn't connect", description: (e as Error).message, variant: "destructive", duration: 4000 }),
  });
  const forgetMut = useMutation({
    mutationFn: (ssid: string) => forgetWifi(ssid, token),
    onSuccess: (r) => { toast({ title: r.message, duration: 2500 }); qc.invalidateQueries({ queryKey: ["network-status"] }); scan.refetch(); },
    onError: (e) => toast({ title: "Couldn't forget network", description: (e as Error).message, variant: "destructive", duration: 4000 }),
  });

  const startConnect = (n: WifiNetwork) => {
    if (isSecured(n.security)) { setConnectTarget(n); setPassword(""); }
    else connectMut.mutate({ ssid: n.ssid, password: "" });
  };

  if (status.data && status.data.available === false) {
    return <UnavailableCard reason={status.data.reason} />;
  }

  const data = status.data?.available ? status.data : null;

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4" data-testid="network-panel">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base"><Cable className="h-4 w-4" /> Connection status</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {!data ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
          ) : data.devices.length === 0 ? (
            <p className="text-sm text-muted-foreground">No network interfaces detected.</p>
          ) : (
            data.devices.map((d) => (
              <div key={d.device} className="flex items-center justify-between rounded-md border px-3 py-2 text-sm" data-testid={`net-device-${d.device}`}>
                <div className="flex items-center gap-2">
                  {d.type === "wifi" ? <Wifi className="h-4 w-4" /> : <Cable className="h-4 w-4" />}
                  <span className="font-medium">{d.device}</span>
                  <span className="text-muted-foreground">{d.type}</span>
                  {d.connection && <span className="text-muted-foreground">· {d.connection}</span>}
                </div>
                <Badge variant={d.state === "connected" ? "default" : "secondary"}>{d.state}</Badge>
              </div>
            ))
          )}
          {data?.wifi && (
            <div className="flex items-center gap-2 pt-1 text-sm text-muted-foreground">
              <Wifi className="h-4 w-4 text-green-500" /> Connected to <span className="font-medium text-foreground">{data.wifi.ssid}</span> ({data.wifi.signal}%)
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-3">
          <CardTitle className="flex items-center gap-2 text-base"><Wifi className="h-4 w-4" /> Wi-Fi networks</CardTitle>
          <Button size="sm" variant="outline" className="h-8 gap-1.5" onClick={() => scan.refetch()} disabled={scan.isFetching} data-testid="button-wifi-scan">
            {scan.isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Scan
          </Button>
        </CardHeader>
        <CardContent className="space-y-2">
          {!scan.data ? (
            <p className="text-sm text-muted-foreground">Press Scan to search for nearby networks.</p>
          ) : scan.data.available === false ? (
            <p className="text-sm text-muted-foreground">{scan.data.reason}</p>
          ) : scan.data.networks.length === 0 ? (
            <p className="text-sm text-muted-foreground">No networks found.</p>
          ) : (
            scan.data.networks.map((n) => (
              <div key={n.ssid} className="flex items-center justify-between rounded-md border px-3 py-2 text-sm" data-testid={`wifi-network-${n.ssid}`}>
                <div className="flex items-center gap-2">
                  <Wifi className="h-4 w-4" />
                  <span className="font-medium">{n.ssid}</span>
                  {isSecured(n.security) && <Lock className="h-3.5 w-3.5 text-muted-foreground" />}
                  <span className="text-muted-foreground">{n.signal}%</span>
                  {n.inUse && <Badge variant="default" className="gap-1"><Check className="h-3 w-3" /> Connected</Badge>}
                </div>
                <div className="flex items-center gap-2">
                  {n.inUse ? (
                    <Button size="sm" variant="ghost" className="h-7" onClick={() => forgetMut.mutate(n.ssid)} disabled={!token || forgetMut.isPending}>Forget</Button>
                  ) : (
                    <Button size="sm" variant="secondary" className="h-7" onClick={() => startConnect(n)} disabled={!token || connectMut.isPending} data-testid={`button-wifi-connect-${n.ssid}`}>Connect</Button>
                  )}
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Dialog open={!!connectTarget} onOpenChange={(o) => { if (!o) setConnectTarget(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Connect to {connectTarget?.ssid}</DialogTitle></DialogHeader>
          <form onSubmit={(e) => { e.preventDefault(); if (connectTarget) connectMut.mutate({ ssid: connectTarget.ssid, password }); }}>
            <Input type="password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Network password" data-testid="input-wifi-password" />
            <DialogFooter className="mt-4">
              <Button type="button" variant="ghost" onClick={() => setConnectTarget(null)}>Cancel</Button>
              <Button type="submit" disabled={!token || connectMut.isPending}>{connectMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Connect"}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function UnavailableCard({ reason }: { reason: string }) {
  return (
    <div className="mx-auto max-w-3xl p-4" data-testid="network-unavailable">
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
          <WifiOff className="h-10 w-10 text-muted-foreground/60" />
          <p className="max-w-md text-sm text-muted-foreground">{reason}</p>
        </CardContent>
      </Card>
    </div>
  );
}

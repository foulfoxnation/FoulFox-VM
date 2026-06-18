import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { useShellToken } from "@/hooks/use-shell-token";
import { useToast } from "@/hooks/use-toast";
import { Bluetooth, BluetoothOff, Loader2, Link, Check, Trash2, RefreshCw } from "lucide-react";
import {
  fetchBluetoothStatus, setBluetoothPower, scanBluetooth, bluetoothDeviceAction,
  type BtAction, type BtDevice,
} from "@/lib/peripherals-api";

const SCAN_SECONDS = 10;

export function BluetoothPanel() {
  const { data: token } = useShellToken();
  const { toast } = useToast();
  const qc = useQueryClient();

  const status = useQuery({ queryKey: ["bt-status"], queryFn: fetchBluetoothStatus, refetchInterval: 5000 });
  const invalidate = () => qc.invalidateQueries({ queryKey: ["bt-status"] });

  const powerMut = useMutation({
    mutationFn: (on: boolean) => setBluetoothPower(on, token),
    onSuccess: invalidate,
    onError: (e) => toast({ title: "Couldn't change power", description: (e as Error).message, variant: "destructive", duration: 4000 }),
  });
  const scanMut = useMutation({
    mutationFn: () => scanBluetooth(SCAN_SECONDS, token),
    onSuccess: invalidate,
    onError: (e) => toast({ title: "Scan failed", description: (e as Error).message, variant: "destructive", duration: 4000 }),
  });
  const actionMut = useMutation({
    mutationFn: (v: { action: BtAction; mac: string }) => bluetoothDeviceAction(v.action, v.mac, token),
    onSuccess: (r) => { toast({ title: r.message, duration: 2500 }); invalidate(); },
    onError: (e) => toast({ title: "Action failed", description: (e as Error).message, variant: "destructive", duration: 4000 }),
  });

  if (status.data && status.data.available === false) {
    return (
      <div className="mx-auto max-w-3xl p-4" data-testid="bluetooth-unavailable">
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
            <BluetoothOff className="h-10 w-10 text-muted-foreground/60" />
            <p className="max-w-md text-sm text-muted-foreground">{status.data.reason}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const data = status.data?.available ? status.data : null;
  const devices: BtDevice[] = data?.devices ?? [];

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4" data-testid="bluetooth-panel">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base"><Bluetooth className="h-4 w-4" /> Bluetooth</CardTitle>
        </CardHeader>
        <CardContent className="flex items-center justify-between">
          <div className="text-sm">
            <div className="font-medium">{data?.powered ? "On" : "Off"}</div>
            <div className="text-muted-foreground">{data?.adapter ? `Adapter ${data.adapter}` : "Toggle the radio to manage devices"}</div>
          </div>
          <Switch checked={!!data?.powered} disabled={!data || !token || powerMut.isPending} onCheckedChange={(v) => powerMut.mutate(v)} data-testid="switch-bluetooth-power" />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-3">
          <CardTitle className="flex items-center gap-2 text-base">Devices</CardTitle>
          <Button size="sm" variant="outline" className="h-8 gap-1.5" onClick={() => scanMut.mutate()} disabled={!data?.powered || !token || scanMut.isPending} data-testid="button-bluetooth-scan">
            {scanMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Scan
          </Button>
        </CardHeader>
        <CardContent className="space-y-2">
          {!data?.powered ? (
            <p className="text-sm text-muted-foreground">Turn Bluetooth on to scan for devices.</p>
          ) : devices.length === 0 ? (
            <p className="text-sm text-muted-foreground">{scanMut.isPending ? "Scanning…" : "No devices found. Press Scan."}</p>
          ) : (
            devices.map((d) => (
              <div key={d.mac} className="flex items-center justify-between rounded-md border px-3 py-2 text-sm" data-testid={`bt-device-${d.mac}`}>
                <div className="flex items-center gap-2">
                  <Bluetooth className="h-4 w-4" />
                  <span className="font-medium">{d.name || d.mac}</span>
                  <span className="font-mono text-xs text-muted-foreground">{d.mac}</span>
                  {d.paired && <Badge variant="default" className="gap-1"><Check className="h-3 w-3" /> Paired</Badge>}
                </div>
                <div className="flex items-center gap-1">
                  {!d.paired && (
                    <Button size="sm" variant="secondary" className="h-7 gap-1" disabled={!token || actionMut.isPending} onClick={() => actionMut.mutate({ action: "pair", mac: d.mac })} data-testid={`button-bt-pair-${d.mac}`}>Pair</Button>
                  )}
                  <Button size="sm" variant="ghost" className="h-7 gap-1" disabled={!token || actionMut.isPending} onClick={() => actionMut.mutate({ action: "connect", mac: d.mac })} data-testid={`button-bt-connect-${d.mac}`}>
                    <Link className="h-3.5 w-3.5" /> Connect
                  </Button>
                  <Button size="sm" variant="ghost" className="h-7 gap-1" disabled={!token || actionMut.isPending} onClick={() => actionMut.mutate({ action: "remove", mac: d.mac })} data-testid={`button-bt-remove-${d.mac}`}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}

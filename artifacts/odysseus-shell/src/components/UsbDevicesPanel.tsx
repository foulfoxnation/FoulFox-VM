import { useEffect, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useShellToken } from "@/hooks/use-shell-token";
import { useVmList } from "@/hooks/use-vms";
import { useToast } from "@/hooks/use-toast";
import { Usb, Loader2, RefreshCw, Plug, Unplug } from "lucide-react";
import { listUsb, attachUsb, detachUsb, type UsbDevice } from "@/lib/peripherals-api";

export function UsbDevicesPanel() {
  const { data: token } = useShellToken();
  const { toast } = useToast();
  const { data: vms } = useVmList();
  const [vmId, setVmId] = useState<string>("");
  const [confirmDev, setConfirmDev] = useState<UsbDevice | null>(null);

  const usb = useQuery({ queryKey: ["usb-list"], queryFn: listUsb, refetchInterval: 5000 });
  const runningVms = (vms ?? []).filter((v) => v.state === "running");

  // Keep the selected target valid as VMs come and go.
  useEffect(() => {
    if (runningVms.length === 0) { if (vmId) setVmId(""); return; }
    if (!runningVms.some((v) => v.id === vmId)) setVmId(runningVms[0].id);
  }, [runningVms, vmId]);

  const attachMut = useMutation({
    mutationFn: (d: UsbDevice) => attachUsb(vmId, d.bus, d.device, token),
    onSuccess: (r) => toast({ title: r.message || "Device attached", duration: 2500 }),
    onError: (e) => toast({ title: "Attach failed", description: (e as Error).message, variant: "destructive", duration: 4000 }),
  });
  const detachMut = useMutation({
    mutationFn: (d: UsbDevice) => detachUsb(vmId, d.bus, d.device, token),
    onSuccess: (r) => toast({ title: r.message || "Device detached", duration: 2500 }),
    onError: (e) => toast({ title: "Detach failed", description: (e as Error).message, variant: "destructive", duration: 4000 }),
  });

  if (usb.data && usb.data.available === false) {
    return (
      <div className="mx-auto max-w-3xl p-4" data-testid="usb-unavailable">
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
            <Usb className="h-10 w-10 text-muted-foreground/60" />
            <p className="max-w-md text-sm text-muted-foreground">{usb.data.reason}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const devices = usb.data?.available ? usb.data.devices : null;

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4" data-testid="usb-panel">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base"><Plug className="h-4 w-4" /> Pass a device to a VM</CardTitle>
        </CardHeader>
        <CardContent>
          {runningVms.length === 0 ? (
            <p className="text-sm text-muted-foreground">Start a virtual machine to pass USB devices through to it.</p>
          ) : (
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">Target VM</span>
              <Select value={vmId} onValueChange={setVmId}>
                <SelectTrigger className="h-8 w-56" data-testid="select-usb-vm"><SelectValue placeholder="Select a running VM" /></SelectTrigger>
                <SelectContent>
                  {runningVms.map((v) => <SelectItem key={v.id} value={v.id}>{v.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-3">
          <CardTitle className="flex items-center gap-2 text-base"><Usb className="h-4 w-4" /> Connected USB devices</CardTitle>
          <Button size="sm" variant="outline" className="h-8 gap-1.5" onClick={() => usb.refetch()} disabled={usb.isFetching} data-testid="button-usb-refresh">
            {usb.isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Refresh
          </Button>
        </CardHeader>
        <CardContent className="space-y-2">
          {!devices ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
          ) : devices.length === 0 ? (
            <p className="text-sm text-muted-foreground">No USB devices detected.</p>
          ) : (
            devices.map((d) => (
              <div key={`${d.bus}-${d.device}-${d.vendorId}-${d.productId}`} className="flex items-center justify-between rounded-md border px-3 py-2 text-sm" data-testid={`usb-device-${d.vendorId}-${d.productId}`}>
                <div className="flex items-center gap-2">
                  <Usb className="h-4 w-4" />
                  <span className="font-medium">{d.name || "USB device"}</span>
                  <span className="font-mono text-xs text-muted-foreground">{d.vendorId}:{d.productId}</span>
                  {d.isHub && <Badge variant="secondary">hub</Badge>}
                </div>
                {!d.isHub && (
                  <div className="flex items-center gap-1.5">
                    <Button size="sm" variant="secondary" className="h-7 gap-1" disabled={!vmId || !token || attachMut.isPending} onClick={() => setConfirmDev(d)} data-testid={`button-usb-attach-${d.vendorId}-${d.productId}`}>
                      <Plug className="h-3.5 w-3.5" /> Attach
                    </Button>
                    <Button size="sm" variant="ghost" className="h-7 gap-1" disabled={!vmId || !token || detachMut.isPending} onClick={() => detachMut.mutate(d)} data-testid={`button-usb-detach-${d.vendorId}-${d.productId}`}>
                      <Unplug className="h-3.5 w-3.5" /> Detach
                    </Button>
                  </div>
                )}
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <AlertDialog open={!!confirmDev} onOpenChange={(o) => { if (!o) setConfirmDev(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Attach {confirmDev?.name || "device"} to the VM?</AlertDialogTitle>
            <AlertDialogDescription>
              While attached, this device is controlled by the virtual machine and won't be usable by FoulFox OS. Detach it to hand control back.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={!token} onClick={() => { if (confirmDev) attachMut.mutate(confirmDev); setConfirmDev(null); }}>Attach</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Wifi, Usb, Bluetooth } from "lucide-react";
import { NetworkPanel } from "./NetworkPanel";
import { UsbDevicesPanel } from "./UsbDevicesPanel";
import { BluetoothPanel } from "./BluetoothPanel";

export function DevicesTab() {
  return (
    <div className="flex h-full w-full flex-col bg-background" data-testid="devices-tab">
      <Tabs defaultValue="network" className="flex h-full w-full flex-col">
        <div className="border-b bg-card px-3 py-2">
          <TabsList>
            <TabsTrigger value="network" className="gap-1.5" data-testid="subtab-network"><Wifi className="h-4 w-4" /> Network</TabsTrigger>
            <TabsTrigger value="usb" className="gap-1.5" data-testid="subtab-usb"><Usb className="h-4 w-4" /> USB</TabsTrigger>
            <TabsTrigger value="bluetooth" className="gap-1.5" data-testid="subtab-bluetooth"><Bluetooth className="h-4 w-4" /> Bluetooth</TabsTrigger>
          </TabsList>
        </div>
        <div className="min-h-0 flex-1">
          <ScrollArea className="h-full">
            <TabsContent value="network" className="mt-0"><NetworkPanel /></TabsContent>
            <TabsContent value="usb" className="mt-0"><UsbDevicesPanel /></TabsContent>
            <TabsContent value="bluetooth" className="mt-0"><BluetoothPanel /></TabsContent>
          </ScrollArea>
        </div>
      </Tabs>
    </div>
  );
}

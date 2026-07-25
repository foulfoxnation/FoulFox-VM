import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Disc3 } from "lucide-react";
import { DownloadTab } from "./DownloadTab";

export function GetFoulFoxOsModal() {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 gap-1.5 text-muted-foreground hover:text-foreground"
          title="Download FoulFox OS / manage updates"
          data-testid="button-get-foulfox-os"
        >
          <Disc3 className="h-4 w-4" />
          <span className="hidden sm:inline text-xs">Get OS</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto p-0">
        <DialogHeader className="px-6 pt-6 pb-0">
          <DialogTitle className="sr-only">Get FoulFox OS</DialogTitle>
        </DialogHeader>
        <DownloadTab />
      </DialogContent>
    </Dialog>
  );
}

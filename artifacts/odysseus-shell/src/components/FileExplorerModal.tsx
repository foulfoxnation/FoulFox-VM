import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { FolderOpen } from "lucide-react";
import { FileExplorer } from "./FileExplorer";

export function FileExplorerModal() {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 gap-1.5 text-muted-foreground hover:text-foreground"
          title="Open file explorer"
          data-testid="button-file-explorer"
        >
          <FolderOpen className="h-4 w-4" />
          <span className="hidden sm:inline text-xs">Files</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-4xl h-[80vh] flex flex-col p-0 gap-0">
        <DialogHeader className="px-4 py-2 border-b shrink-0">
          <DialogTitle className="flex items-center gap-2 text-sm font-medium">
            <FolderOpen className="h-4 w-4" /> File Explorer
          </DialogTitle>
        </DialogHeader>
        <div className="flex-1 min-h-0 overflow-auto">
          <FileExplorer />
        </div>
      </DialogContent>
    </Dialog>
  );
}

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Camera, Loader2 } from "lucide-react";
import { useSnapshotVm } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";

export function SnapshotModal({ disabled }: { disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const snapshotVm = useSnapshotVm();
  const { toast } = useToast();

  const handleSnapshot = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    snapshotVm.mutate(
      { data: { name } },
      {
        onSuccess: () => {
          toast({ title: "Snapshot created successfully" });
          setOpen(false);
          setName("");
        },
        onError: (err) => {
          toast({ title: "Failed to create snapshot", variant: "destructive", description: String(err) });
        },
      }
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" disabled={disabled} data-testid="button-snapshot-modal">
          <Camera className="mr-2 h-4 w-4" />
          Snapshot
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create VM Snapshot</DialogTitle>
          <DialogDescription>
            Capture the current state of the VM.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSnapshot} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="snapshotName">Snapshot Name</Label>
            <Input
              id="snapshotName"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g., before-unity-install"
              data-testid="input-snapshot-name"
              autoFocus
            />
          </div>
          <div className="flex justify-end space-x-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || snapshotVm.isPending} data-testid="button-save-snapshot">
              {snapshotVm.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Create
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

import { Keyboard } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

type Shortcut = { keys: string[]; action: string };
type Section = { title: string; shortcuts: Shortcut[] };

const SECTIONS: Section[] = [
  {
    title: "Windows VM",
    shortcuts: [
      { keys: ["Ctrl", "M"], action: "Leave the VM, back to FoulFox OS" },
      { keys: ["Esc"], action: "Exit VM fullscreen" },
      { keys: ["F11"], action: "Exit VM fullscreen" },
    ],
  },
  {
    title: "Workspace",
    shortcuts: [
      { keys: ["Ctrl", "B"], action: "Show / hide sidebar" },
      { keys: ["Esc"], action: "Close voice panel" },
    ],
  },
  {
    title: "Terminal",
    shortcuts: [
      { keys: ["Ctrl", "C"], action: "Copy selection (or stop command)" },
      { keys: ["Ctrl", "Shift", "C"], action: "Copy" },
      { keys: ["Ctrl", "V"], action: "Paste" },
      { keys: ["Ctrl", "Shift", "V"], action: "Paste" },
      { keys: ["Ctrl", "A"], action: "Select all" },
    ],
  },
];

function Keys({ keys }: { keys: string[] }) {
  return (
    <span className="flex items-center gap-0.5 shrink-0">
      {keys.map((k, i) => (
        <span key={i} className="flex items-center gap-0.5">
          {i > 0 && <span className="text-muted-foreground text-[10px]">+</span>}
          <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] leading-none text-foreground">
            {k}
          </kbd>
        </span>
      ))}
    </span>
  );
}

export default function KeyboardShortcutsMenu() {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground"
          title="Keyboard shortcuts"
          data-testid="button-keyboard-shortcuts"
        >
          <Keyboard className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72" data-testid="menu-keyboard-shortcuts">
        <DropdownMenuLabel>Keyboard shortcuts</DropdownMenuLabel>
        {SECTIONS.map((section) => (
          <div key={section.title}>
            <DropdownMenuSeparator />
            <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              {section.title}
            </div>
            {section.shortcuts.map((s, i) => (
              <div
                key={i}
                className="flex items-center justify-between gap-3 px-2 py-1 text-xs"
              >
                <span className="text-foreground/90">{s.action}</span>
                <Keys keys={s.keys} />
              </div>
            ))}
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

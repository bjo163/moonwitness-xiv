import { KeyboardIcon, SparkleIcon } from '@moonwitness/ui/icons';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@moonwitness/ui/components/dialog';

interface ShortcutGroup {
  category: string;
  items: Array<{
    keys: string[];
    description: string;
  }>;
}

const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    category: 'Global Navigation',
    items: [
      { keys: ['Ctrl', 'K'], description: 'Open Global Omnisearch palette' },
      { keys: ['Ctrl', '/'], description: 'Toggle this Keyboard Shortcuts manual' },
      { keys: ['Esc'], description: 'Close modals / Return to previous view' },
    ],
  },
  {
    category: 'Record Management (Form View)',
    items: [
      { keys: ['Ctrl', 'S'], description: 'Save current record without browser reload' },
      { keys: ['Ctrl', 'N'], description: 'Create new record in current module' },
      { keys: ['Ctrl', 'Shift', 'Backspace'], description: 'Discard changes and go back' },
    ],
  },
  {
    category: 'List & Data Views',
    items: [
      { keys: ['Alt', 'T'], description: 'Switch to Table Spreadsheet view' },
      { keys: ['Alt', 'C'], description: 'Switch to Manga Cards Kanban view' },
      { keys: ['Ctrl', 'Shift', 'F'], description: 'Focus search input bar' },
    ],
  },
];

interface ShortcutsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ShortcutsDialog({ open, onOpenChange }: ShortcutsDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg border-4 border-ink bg-paper p-6 shadow-ink-lg rounded-none">
        <DialogHeader className="border-b-2 border-ink pb-3 text-left">
          <div className="flex items-center gap-2">
            <span className="flex items-center gap-1 border-2 border-ink bg-lime px-2 py-0.5 font-mono text-xs font-bold uppercase text-on-accent">
              <KeyboardIcon className="size-3.5" /> Manual
            </span>
            <DialogTitle className="font-display text-2xl uppercase tracking-wider text-ink">
              Keyboard Mastery Cheatsheet
            </DialogTitle>
          </div>
          <DialogDescription className="font-mono text-xs text-ink-faint mt-1">
            Supercharge your MoonWitness workflow with instant hotkeys.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 py-3 font-sans">
          {SHORTCUT_GROUPS.map((group) => (
            <div key={group.category} className="space-y-2">
              <h3 className="font-display text-xs uppercase tracking-widest text-ink-faint flex items-center gap-1.5">
                <SparkleIcon className="size-3 text-lime" />
                {group.category}
              </h3>
              <div className="space-y-1.5">
                {group.items.map((item, idx) => (
                  <div
                    key={idx}
                    className="flex items-center justify-between gap-4 border-2 border-ink/20 bg-card p-2 text-xs transition-colors hover:border-ink hover:bg-paper-raised"
                  >
                    <span className="text-ink font-medium">{item.description}</span>
                    <div className="flex items-center gap-1 shrink-0">
                      {item.keys.map((k) => (
                        <kbd
                          key={k}
                          className="border-2 border-ink bg-paper px-2 py-0.5 font-mono text-[11px] font-bold text-ink shadow-[2px_2px_0_0_var(--ink)]"
                        >
                          {k}
                        </kbd>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="border-t-2 border-ink/20 pt-3 text-center font-mono text-[11px] text-ink-faint">
          Press <kbd className="border border-ink px-1 text-ink">Esc</kbd> anytime to dismiss
        </div>
      </DialogContent>
    </Dialog>
  );
}

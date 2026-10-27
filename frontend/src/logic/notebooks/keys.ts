/** What a key does on the notebook page (Jupyter's command mode, plus the run keys of edit mode). */
export type NotebookCommand =
  | { t: 'run'; then: 'advance' | 'stay' | 'insert' }
  | { t: 'edit' }
  | { t: 'select'; by: number }
  | { t: 'insert'; where: 'above' | 'below' }
  | { t: 'delete' }
  | { t: 'type'; to: 'code' | 'markdown' }
  | { t: 'interrupt' }
  | { t: 'restart' }
  | { t: 'save' };

export interface KeyInput {
  key: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}

/** Run keys, shared by edit mode (inside a cell editor) and command mode. */
export function runKey(e: KeyInput): NotebookCommand | null {
  if (e.key !== 'Enter') return null;
  if (e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) return { t: 'run', then: 'advance' };
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) return { t: 'run', then: 'stay' };
  if (e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey) return { t: 'run', then: 'insert' };
  return null;
}

/**
 * Command mode (a cell is selected, no editor focused). `prev` is the previous plain key, for the
 * double-press commands D D (delete), I I (interrupt) and 0 0 (restart).
 */
export function commandKey(e: KeyInput, prev: string | null): NotebookCommand | null {
  const run = runKey(e);
  if (run) return run;
  if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 's') return { t: 'save' };
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  switch (e.key) {
    case 'Enter':
      return { t: 'edit' };
    case 'ArrowUp':
    case 'k':
      return { t: 'select', by: -1 };
    case 'ArrowDown':
    case 'j':
      return { t: 'select', by: 1 };
    case 'a':
      return { t: 'insert', where: 'above' };
    case 'b':
      return { t: 'insert', where: 'below' };
    case 'm':
      return { t: 'type', to: 'markdown' };
    case 'y':
      return { t: 'type', to: 'code' };
    case 'd':
      return prev === 'd' ? { t: 'delete' } : null;
    case 'i':
      return prev === 'i' ? { t: 'interrupt' } : null;
    case '0':
      return prev === '0' ? { t: 'restart' } : null;
    default:
      return null;
  }
}

/** Shortcut list shown in the page's help popover. */
export const SHORTCUTS: [string, string][] = [
  ['⇧ Enter', 'Run cell, select next'],
  ['⌘ Enter', 'Run cell'],
  ['⌥ Enter', 'Run cell, insert below'],
  ['Esc / Enter', 'Leave / enter the cell editor'],
  ['A / B', 'Insert cell above / below'],
  ['M / Y', 'Make Markdown / code'],
  ['D D', 'Delete cell'],
  ['↑ ↓ (K J)', 'Select previous / next cell'],
  ['I I', 'Interrupt the kernel'],
  ['0 0', 'Restart the kernel'],
  ['⌘ S', 'Save to ICF'],
  ['⌃ ⌘ F', 'Full screen'],
];

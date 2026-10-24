import { useEffect } from 'react';

/** What leaving a page would lose: unsaved edits and/or a running kernel (it stops with the page). */
export interface PageGuard {
  name: string;
  dirty: boolean;
  kernel: boolean;
}

/** Tells the app shell, while the page is open, what navigating away or disconnecting would discard. */
export function usePageGuard(name: string, dirty: boolean, kernel: boolean, onGuard: (g: PageGuard | null) => void) {
  useEffect(() => onGuard(dirty || kernel ? { name, dirty, kernel } : null), [name, dirty, kernel, onGuard]);
  useEffect(() => () => onGuard(null), [onGuard]);
}

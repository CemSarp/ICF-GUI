import { useEffect } from 'react';
import { usePersistentState } from '../persist';

export type Theme = 'system' | 'light' | 'dark';

/** Remembered theme choice, applied to the document (`system` follows macOS). */
export function useTheme() {
  const [theme, setTheme] = usePersistentState<Theme>('theme', 'system');
  useEffect(() => {
    if (theme === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
  }, [theme]);
  return [theme, setTheme] as const;
}

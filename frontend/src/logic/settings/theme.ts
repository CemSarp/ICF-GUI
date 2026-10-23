import { useEffect } from 'react';

export type Theme = 'system' | 'light' | 'dark';

/** Apply the remembered theme choice to the document (`system` follows macOS). */
export function useApplyTheme(theme: Theme) {
  useEffect(() => {
    if (theme === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
  }, [theme]);
}

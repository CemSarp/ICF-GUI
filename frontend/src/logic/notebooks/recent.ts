import { usePersistentState } from '../persist';

const MAX_RECENT = 10;

export const under = (path: string, dir: string) => path === dir || path.startsWith(`${dir.replace(/\/+$/, '')}/`);
export const isNotebook = (name: string) => name.toLowerCase().endsWith('.ipynb');

export interface RecentNotebook {
  path: string;
  openedAt: number;
}

/** Notebooks opened from this Mac, newest first (paths only, kept in local UI preferences). */
export function useRecentNotebooks() {
  const [recent, setRecent] = usePersistentState<RecentNotebook[]>('notebooks.recent', []);
  const touch = (path: string) =>
    setRecent((r) => [{ path, openedAt: Date.now() }, ...r.filter((x) => x.path !== path)].slice(0, MAX_RECENT));
  const forget = (path: string) => setRecent((r) => r.filter((x) => x.path !== path));
  return { recent, touch, forget };
}

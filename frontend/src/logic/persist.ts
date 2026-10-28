import { useEffect, useState } from 'react';

// Non-sensitive UI preferences only (filters, sort, theme). Never credentials or snapshots.
export function usePersistentState<T>(key: string, initial: T) {
  const k = `icfcc.${key}`;
  const [v, setV] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(k);
      return raw === null ? initial : (JSON.parse(raw) as T);
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {
      /* storage unavailable: keep in memory */
    }
  }, [k, v]);
  return [v, setV] as const;
}

/** Drops saved values so their screens start from defaults next time they open. */
export function forget(...keys: string[]) {
  for (const key of keys)
    try {
      localStorage.removeItem(`icfcc.${key}`);
    } catch {
      /* storage unavailable: nothing was saved */
    }
}

/** Wall clock that re-renders every `ms` (for countdowns such as the sign-in cooldown). */
export function useNow(ms: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

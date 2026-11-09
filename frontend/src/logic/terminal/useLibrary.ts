import { useCallback } from 'react';
import { usePersistentState } from '../persist';
import { cleanCustom, type Custom } from './library';

/** The user's own saved commands (this Mac only, same as other UI preferences). */
export function useCustomCommands() {
  const [custom, setCustom] = usePersistentState<Custom[]>('terminal.customCommands', []);
  const add = useCallback(
    (title: string, command: string) => {
      const c = cleanCustom(title, command);
      if (!c) return false;
      setCustom((all) => [...all, { id: `c${Date.now().toString(36)}`, ...c }]);
      return true;
    },
    [setCustom],
  );
  const remove = useCallback((id: string) => setCustom((all) => all.filter((c) => c.id !== id)), [setCustom]);
  return { custom, add, remove };
}

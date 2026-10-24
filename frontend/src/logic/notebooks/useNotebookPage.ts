import { useEffect, useState } from 'react';
import { usePageGuard, type PageGuard } from '../app/guard';
import { useFileEditor } from '../editor/useFileEditor';
import { useRecentNotebooks } from './recent';
import { useKernel } from './useKernel';

/**
 * The open notebook: conflict-checked load/save (shared with the text editor), its kernel, and
 * the sheets the page shows. `onGuard` tells the app shell what navigating away would discard.
 */
export function useNotebookPage(path: string, onGuard: (g: PageGuard | null) => void) {
  const [dirty, setDirty] = useState(false);
  const file = useFileEditor(path, setDirty);
  const kernel = useKernel();
  const [kernelSheet, setKernelSheet] = useState(false);
  const [help, setHelp] = useState(false);
  const name = path.split('/').pop() ?? path;
  const { touch } = useRecentNotebooks();

  useEffect(() => {
    touch(path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  usePageGuard(name, dirty, kernel.active, onGuard);

  return { ...file, name, kernel, kernelSheet, setKernelSheet, help, setHelp };
}
